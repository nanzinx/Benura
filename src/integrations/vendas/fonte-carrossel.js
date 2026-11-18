'use strict';
/**
 * [NOVO] Vendas por consultor num dia, pelo Carrossel (o mesmo /ranking/vendedores e a mesma métrica
 * do roteador). Adaptador da fonte dos Liberados da URA: para trocar pelo sistema da Benconsig,
 * basta outra classe com `vendasDoDia(dia)` e `fotografar()`.
 *
 * O "ontem" do Carrossel pula o fim de semana (na segunda ele devolve a sexta), mas a URA conta o
 * sábado. Por isso o painel guarda uma foto do ranking "hoje" de cada dia (a última do dia vale):
 *  1. o "ontem" do Carrossel, se for o mesmo dia pedido (a conta mais completa);
 *  2. senão, a foto daquele dia;
 *  3. senão, sem dados (com o motivo).
 */

const { ArquivoDeEstado } = require('../../utils/persistencia-json');
const { dataLocal, horaLocal } = require('../../utils/datas');

const GUARDAR_DIAS = 15;

/** "17/11/2026" → "2026-11-17" (null se não for uma data). */
const deDiaBr = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

class FonteVendasCarrossel {
  /**
   * @param {object} deps
   * @param {{ listarVendas(periodo: 'hoje'|'ontem', opcoes?: object): Promise<{ vendedores: Array<{ nome: string, totalVendas: number }>, diaOntem: string|null }> }} deps.carrossel
   * @param {string} deps.arquivo - as fotos por dia
   * @param {string} deps.fuso
   */
  constructor({ carrossel, arquivo, fuso, logger, agora = () => new Date() }) {
    Object.assign(this, { carrossel, fuso, log: logger, agora });
    this.repositorio = new ArquivoDeEstado({ arquivo, logger });
    this.fotos = this.repositorio.carregar()?.fotos ?? {};
  }

  /** Guarda o ranking "hoje" do Carrossel como as vendas do dia (a cada ~10 min). */
  async fotografar() {
    const dia = dataLocal(this.fuso, this.agora());
    let r;
    try {
      r = await this.carrossel.listarVendas('hoje', { permitirFallback: false });
    } catch (e) {
      this.log.debug?.(`Liberados da URA: foto das vendas de hoje não saiu (${e.message}).`);
      return false;
    }
    const vendas = r.vendedores.map((v) => ({ nome: v.nome, valor: v.totalVendas }));
    if (!vendas.length) return false; // sem ninguém (começo do dia): não apaga uma foto boa
    this.fotos[dia] = { em: this.agora().toISOString(), vendas };
    for (const d of Object.keys(this.fotos).sort().slice(0, -GUARDAR_DIAS)) delete this.fotos[d];
    this.repositorio.salvar({ fotos: this.fotos });
    return true;
  }

  /** Espera a gravação em andamento (testes e desligamento). */
  aguardar() {
    return this.repositorio.aguardar();
  }

  /**
   * @param {string} dia - AAAA-MM-DD
   * @returns {Promise<{ vendas: Array<{ nome: string, valor: number }>, origem: string } | { vendas: null, motivo: string }>}
   */
  async vendasDoDia(dia) {
    let motivoCarrossel = null;
    try {
      const r = await this.carrossel.listarVendas('ontem', { permitirFallback: false });
      if (deDiaBr(r.diaOntem) === dia && r.vendedores.length) {
        return { vendas: r.vendedores.map((v) => ({ nome: v.nome, valor: v.totalVendas })), origem: `Carrossel ("ontem" = ${r.diaOntem})` };
      }
      motivoCarrossel = `o "ontem" do Carrossel é ${r.diaOntem ?? 'desconhecido'}${r.vendedores.length ? '' : ' (sem vendas)'}`;
    } catch (e) {
      motivoCarrossel = `Carrossel indisponível (${e.message})`;
    }
    const foto = this.fotos[dia];
    if (foto?.vendas?.length) return { vendas: foto.vendas, origem: `foto do Carrossel de ${dia.split('-').reverse().join('/')} às ${horaLocal(this.fuso, new Date(foto.em)).slice(0, 5)}` };
    return { vendas: null, motivo: `Sem as vendas de ${dia.split('-').reverse().join('/')}: ${motivoCarrossel}, e o painel não guardou a foto daquele dia (estava desligado?).` };
  }
}

module.exports = { FonteVendasCarrossel, deDiaBr };

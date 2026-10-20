'use strict';
/**
 * Cliente de risco falando com um robô (só leitura do relatório da Argus).
 *
 * A cada PERFIS_VIGIA_SEG, com robô ligado, lê as ligações do último minuto dos
 * grupos de robôs. Cada "LIGAÇÃO EM CURSO" cujo telefone tem perfil de risco
 * (muito callback ou atende muito) vira um alerta: no log (avisos.txt), na
 * página /ura (som, notificação do navegador) e, com o interruptor ligado,
 * desliga os robôs que não estão em ligação, para o livre ficar para esse cliente.
 *
 * O alerta mostra só o telefone mascarado e as contagens; nada é gravado do cliente.
 */

const { Resultado, classificarLigacao, telefoneDaLigacao } = require('../domain/perfis-clientes');
const { textoDaHora } = require('../domain/diagnostico-callbacks');
const { instanteLocal } = require('../domain/raio-x-callback');
const { escolherCampanha } = require('../integrations/argus/campanha');

/** Alerta some da tela depois disso (a ligação já terminou há tempo). */
const ALERTA_DURA_MS = 3 * 60_000;
const ROBO_RECENTE_MS = 60_000;

class VigiaRisco {
  /**
   * @param {object} deps
   * @param {{ ligacoesDetalhadas: Function, listarCampanhas: Function }} deps.client
   * @param {{ teveRoboLigado(agora: number, janelaMs: number): boolean, desligarPorClienteDeRisco(motivo: string): Promise }} deps.rodizio
   * @param {import('./perfis-clientes').PerfisClientes} deps.perfis
   * @param {{ ligado(): boolean }} deps.desligaRobos - interruptor "desligar robôs com cliente de risco"
   * @param {{ gruposRobosIds: number[], idCampanha?: number, fuso: string }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, rodizio, perfis, desligaRobos, cfg, logger }) {
    Object.assign(this, { client, rodizio, perfis, desligaRobos, cfg, log: logger });
    /** idLigacao → alerta */
    this.alertas = new Map();
    this.falhando = false;
  }

  async verificar(agora = Date.now()) {
    this.esquecerAntigos(agora);
    if (!this.rodizio.teveRoboLigado(agora, ROBO_RECENTE_MS)) return;
    const ligacoes = await this.lerUltimoMinuto().catch((e) => this.avisarFalha(e));
    if (!ligacoes) return;
    this.falhando = false;
    const novos = ligacoes.filter((l) => classificarLigacao(l) === Resultado.EM_CURSO).map((l) => this.avaliar(l, agora)).filter(Boolean);
    if (novos.length && this.desligaRobos?.ligado()) {
      await this.rodizio.desligarPorClienteDeRisco(`cliente de risco em ligação: ${novos.map((a) => a.mascara).join(', ')}`);
    }
  }

  esquecerAntigos(agora) {
    for (const [id, a] of this.alertas) if (agora - a.vistoEm > ALERTA_DURA_MS) this.alertas.delete(id);
  }

  /** Avisa uma vez até voltar a ler. @returns {null} */
  avisarFalha(e) {
    if (!this.falhando) this.log.aviso(`Vigia de clientes de risco: não foi possível ler o relatório da Argus (${e.message}).`);
    this.falhando = true;
    return null;
  }

  async lerUltimoMinuto() {
    this.idCampanha ??= await escolherCampanha(this.client, this.cfg.idCampanha);
    const todas = [];
    for (const idGrupoUsuario of this.cfg.gruposRobosIds) {
      todas.push(...await this.client.ligacoesDetalhadas({ idCampanha: this.idCampanha, idGrupoUsuario, ultimosMinutos: 1 }, { maxPaginas: 3 }));
    }
    return todas;
  }

  /** @returns {object|null} o alerta novo, se for cliente de risco ainda não alertado */
  avaliar(ligacao, agora) {
    const id = ligacao.idLigacao != null ? String(ligacao.idLigacao) : null;
    if (!id) return null;
    const ja = this.alertas.get(id);
    if (ja) {
      ja.vistoEm = agora;
      return null;
    }
    const perfil = this.perfis.consultar(telefoneDaLigacao(ligacao));
    if (!perfil?.motivos.length) return null;

    const alerta = {
      id,
      robo: ligacao.usuarioOperador ?? null,
      mascara: perfil.mascara,
      atendeu: perfil.atendeu,
      callbacks: perfil.callbacks,
      motivos: perfil.motivos,
      inicio: instanteLocal(textoDaHora(ligacao), this.cfg.fuso) ?? agora,
      vistoEm: agora,
    };
    this.alertas.set(id, alerta);
    this.log.aviso(`CLIENTE DE RISCO em ligação: ${alerta.robo ?? 'robô'} com ${alerta.mascara} (${alerta.motivos.join(', ')} nos últimos dias).`);
    return alerta;
  }

  /** Para GET /alertas: os alertas ainda na tela, mais recentes primeiro. */
  listar() {
    return [...this.alertas.values()].sort((a, b) => b.inicio - a.inicio).map(({ vistoEm, ...a }) => ({
      ...a, inicio: new Date(a.inicio).toISOString(),
    }));
  }
}

module.exports = { VigiaRisco };

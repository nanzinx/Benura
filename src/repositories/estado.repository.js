'use strict';
/**
 * Persistência do estado diário do roteador em arquivo JSON.
 *
 *  - Escrita atômica (arquivo .tmp + rename) com backup .bak.
 *  - Escritas serializadas: chamadas concorrentes nunca se intercalam.
 *  - Leitura tolerante: recupera do .bak e migra o formato legado.
 *
 * Formato:
 * {
 *   versao: 2,
 *   data: "2026-10-08",
 *   vendedores: {
 *     "1004": {
 *       nome, equipe, vendaOntem,
 *       fila: "URA" | "ATIVO",          // fila decidida pelo roteador
 *       promovidoNoDia: boolean,        // subiu para a URA por venda hoje
 *       vendaQueDisparou: number|null,
 *       sincronizado: boolean,          // false = transferência pendente na Argus
 *       ultimoResultado: string,        // resultado da última ação na discadora
 *       atualizadoEm: ISOString
 *     }
 *   }
 * }
 */

const fs = require('fs');

const VERSAO = 2;
const estadoVazio = () => ({ versao: VERSAO, data: '', vendedores: {} });

class EstadoRepository {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.log = logger;
    this.filaEscrita = Promise.resolve();
  }

  /** @returns {object} Estado carregado (ou vazio). Nunca lança. */
  carregar() {
    for (const caminho of [this.arquivo, `${this.arquivo}.bak`]) {
      try {
        const bruto = JSON.parse(fs.readFileSync(caminho, 'utf8'));
        const estado = this.normalizar(bruto);
        if (caminho !== this.arquivo) this.log.aviso('Estado principal ilegível; recuperado a partir do .bak.');
        return estado;
      } catch (e) {
        if (e.code !== 'ENOENT') this.log.aviso(`Não foi possível ler ${caminho}: ${e.message}`);
      }
    }
    this.log.info('Nenhum estado salvo encontrado; iniciando do zero.');
    return estadoVazio();
  }

  /** Aceita o formato atual e o legado (vendedoresUra/vendedoresAtivo/historico). */
  normalizar(bruto) {
    if (!bruto || typeof bruto !== 'object') return estadoVazio();
    if (bruto.versao === VERSAO && bruto.vendedores) return bruto;

    // Migração do formato v1.
    const estado = estadoVazio();
    estado.data = bruto.data || '';
    const historico = bruto.historico || {};
    const filas = [
      ...(bruto.vendedoresUra || []).map((r) => [r, 'URA']),
      ...(bruto.vendedoresAtivo || []).map((r) => [r, 'ATIVO']),
    ];
    for (const [ramal, fila] of filas) {
      const h = historico[ramal] || {};
      estado.vendedores[String(ramal)] = {
        nome: h.nome || `Ramal ${ramal}`,
        equipe: h.equipe || 'Sem equipe',
        vendaOntem: h.vendaOntem || 0,
        fila,
        promovidoNoDia: Boolean(h.movidoParaUraDuranteDia),
        vendaQueDisparou: h.vendaHojeQueDisparou ?? null,
        sincronizado: true,
        ultimoResultado: 'MIGRADO',
        atualizadoEm: h.horaMovimentacao || new Date().toISOString(),
      };
    }
    return estado;
  }

  /**
   * Persiste o estado. Escritas são enfileiradas e nunca rejeitam
   * (falhas são logadas; o estado em memória continua válido).
   */
  salvar(estado) {
    const conteudo = JSON.stringify(estado, null, 2);
    this.filaEscrita = this.filaEscrita.then(async () => {
      try {
        const tmp = `${this.arquivo}.tmp`;
        await fs.promises.writeFile(tmp, conteudo);
        await fs.promises.rename(tmp, this.arquivo);
        await fs.promises.copyFile(this.arquivo, `${this.arquivo}.bak`);
      } catch (e) {
        this.log.erro(`Falha ao salvar estado em ${this.arquivo}: ${e.message}`);
      }
    });
    return this.filaEscrita;
  }

  /** Aguarda escritas pendentes (usado no desligamento). */
  aguardarEscritas() {
    return this.filaEscrita;
  }
}

module.exports = { EstadoRepository, estadoVazio };

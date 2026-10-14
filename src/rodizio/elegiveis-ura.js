'use strict';
/**
 * Quem pode subir do Ativo para a URA pelo rodízio: a lista do dia do roteador
 * (state-vendas.json, fila "URA" = meta de ontem, venda hoje ou fixo).
 *
 * O roteador e o rodízio são processos separados; o arquivo é relido só quando
 * muda. Sem a lista do dia (roteador desligado, carga adiada porque o Carrossel
 * falhou, arquivo de ontem), só os fixos (OPERADORES_FIXOS_URA e
 * EQUIPES_FIXAS_URA) sobem: quem não bateu meta nem vendeu não vai para a URA
 * por falta de informação. Para pôr mais gente na URA, a supervisão usa a URA cheia.
 */

const { ArquivoJsonObservado } = require('../utils/arquivo-json');
const { dataLocal } = require('../utils/datas');
const { elegiveisDoEstado } = require('../domain/rodizio');

const mesmaLista = (a, b) => a === b || (a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((r) => b.has(r)));

class ElegiveisUra {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo - STATE_FILE do roteador
   * @param {string} deps.fusoHorario
   * @param {object} deps.logger
   * @param {() => Promise<Set<string>>} [deps.fixos] - ramais dos fixos, para quando não há a lista do dia
   */
  constructor({ arquivo, fusoHorario, logger, fixos = async () => new Set() }) {
    Object.assign(this, { arquivo, fusoHorario, log: logger, fixos });
    this.fonte = new ArquivoJsonObservado(arquivo);
    this.estado = null; // último conteúdo bom do arquivo
    this.ramais = undefined; // Set = lista do dia; null = sem lista (só fixos); undefined = ainda não lido
    this.fixosSemLista = new Set();
  }

  /** Relê o arquivo se mudou e confere se a lista é de hoje; sem ela, resolve os fixos. */
  async atualizar(agora = new Date()) {
    const lido = this.fonte.verificar();
    if (lido.estado === 'atualizado') this.estado = lido.dados;
    if (lido.estado === 'ausente') this.estado = null;
    // 'invalido': o roteador grava de forma atômica; mantém a última versão boa.

    const ramais = elegiveisDoEstado(this.estado, dataLocal(this.fusoHorario, agora));
    if (!ramais) this.fixosSemLista = await this.lerFixos();
    if (mesmaLista(this.ramais, ramais)) return;
    this.registrarMudanca(this.ramais, ramais);
    this.ramais = ramais;
  }

  async lerFixos() {
    try {
      return await this.fixos();
    } catch (e) {
      this.log.debug(`Fixos indisponíveis agora: ${e.message}`);
      return this.fixosSemLista;
    }
  }

  registrarMudanca(antes, depois) {
    if (!depois) {
      this.log.aviso(`Sem a lista de elegíveis do dia (${this.arquivo} ausente ou de outro dia; o roteador está rodando?). `
        + `Só os fixos sobem para a URA (${this.fixosSemLista.size}); quem não bateu meta nem vendeu fica no Ativo. `
        + 'Para pôr todo mundo na URA, use a URA cheia (/ura).');
      return;
    }
    const novos = antes instanceof Set ? [...depois].filter((r) => !antes.has(r)) : [];
    this.log.info(`Elegíveis para a URA: ${depois.size} (meta de ontem, venda hoje ou fixo)`
      + `${novos.length ? `; novos: ${novos.join(', ')}` : ''}. Os demais ficam no Ativo.`);
  }

  /**
   * Grupo de onde o roteador tirou a pessoa ao levá-la para a URA (último
   * recurso para a volta ao Ativo, quando o grupo do supervisor é desconhecido).
   * @returns {number|null}
   */
  grupoDeOrigem(ramal) {
    const grupo = this.estado?.vendedores?.[String(ramal)]?.grupoAtivoAnterior;
    return Number.isFinite(grupo) ? grupo : null;
  }

  /** @returns {boolean} sem a lista do dia, só os fixos */
  permite(ramal) {
    return (this.ramais || this.fixosSemLista).has(String(ramal));
  }

  resumo() {
    const disponivel = this.ramais instanceof Set;
    return { disponivel, total: disponivel ? this.ramais.size : this.fixosSemLista.size };
  }
}

module.exports = { ElegiveisUra };

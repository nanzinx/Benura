'use strict';
/**
 * Retorno automático de quem desistiu da fila da URA.
 *
 * Recebe os webhooks da Argus (via rodízio) e:
 *   - abandono / sem agente / time-out → inclui o telefone como lead de retorno
 *     numa skill existente, marcado com origem RETORNO_URA (medível nos relatórios);
 *   - o mesmo cliente liga de novo e é atendido → remove o retorno pendente.
 *
 * Nasce desligado (RETORNO_FILA_ATIVO=false) e respeita DRY_RUN.
 */

const {
  Acao, interpretarEncerramentoUra, codClienteDoRetorno, jaTemRetorno, limparExpirados, montarLead,
} = require('../domain/retorno-fila');
const { dataLocal } = require('../utils/datas');

const Resultado = Object.freeze({
  INCLUIDO: 'INCLUIDO',
  DUPLICADO: 'DUPLICADO',
  FORA_DO_HORARIO: 'FORA_DO_HORARIO',
  REMOVIDO: 'REMOVIDO',
  SEM_PENDENTE: 'SEM_PENDENTE',
  SIMULADO: 'SIMULADO',
  FALHA: 'FALHA',
});

class RetornoFilaService {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ ativo, skillHash, janelaHoras, incluirForaHorario, origem, dryRun, fusoHorario }} deps.cfg
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} deps.repositorio
   * @param {{ registrar(acao: string, dados: object): Promise<object> }} deps.auditoria
   * @param {object} deps.logger
   */
  constructor({ client, cfg, repositorio, auditoria, logger }) {
    Object.assign(this, { client, cfg, repositorio, auditoria, log: logger });
    this.janelaMs = cfg.janelaHoras * 3_600_000;
    this.pendentes = {};
    this.fila = Promise.resolve(); // processa um evento por vez (evita duplicar em rajada)
  }

  inicializar() {
    this.pendentes = limparExpirados(this.repositorio.carregar(), Date.now(), this.janelaMs);
    return this;
  }

  /**
   * Trata um webhook da Argus. Eventos que não interessam são ignorados sem log.
   * @returns {Promise<{ resultado: string }|null>}
   */
  processar(evento) {
    if (!this.cfg.ativo) return Promise.resolve(null);
    const decisao = interpretarEncerramentoUra(evento);
    if (!decisao) return Promise.resolve(null);

    const execucao = this.fila.then(() => this.executar(decisao));
    this.fila = execucao.catch(() => {});
    return execucao;
  }

  async executar(decisao) {
    this.pendentes = limparExpirados(this.pendentes, Date.now(), this.janelaMs);
    const resultado = decisao.acao === Acao.INCLUIR ? await this.incluir(decisao) : await this.remover(decisao);
    const { acao: pedido, ...dados } = decisao; // "acao" é o nome do evento na trilha
    await this.auditoria.registrar(`retorno.${resultado.resultado.toLowerCase()}`, { pedido, ...dados, ...resultado });
    return resultado;
  }

  async incluir(decisao) {
    if (decisao.foraHorario && !this.cfg.incluirForaHorario) return { resultado: Resultado.FORA_DO_HORARIO };
    if (jaTemRetorno(this.pendentes, decisao.telefone, Date.now(), this.janelaMs)) return { resultado: Resultado.DUPLICADO };

    const codCliente = codClienteDoRetorno(decisao.telefone, dataLocal(this.cfg.fusoHorario));
    const lead = montarLead(decisao, { codCliente, origem: this.cfg.origem });
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Incluiria retorno ${decisao.telefone} (${decisao.motivo})`);
      return { resultado: Resultado.SIMULADO, codCliente };
    }

    try {
      const { nrLead } = await this.client.incluirLead(this.cfg.skillHash, lead);
      await this.registrarPendente(decisao.telefone, { codCliente, nrLead, incluidoEm: Date.now() });
      this.log.info(`Retorno incluído: ${decisao.telefone} (${decisao.motivo}) lead ${nrLead}`);
      return { resultado: Resultado.INCLUIDO, codCliente, nrLead };
    } catch (e) {
      this.log.erro(`Falha ao incluir retorno ${decisao.telefone}: ${e.message}`);
      return { resultado: Resultado.FALHA, erro: e.message };
    }
  }

  async remover({ telefone }) {
    const pendente = this.pendentes[telefone];
    if (!pendente) return { resultado: Resultado.SEM_PENDENTE };
    if (this.cfg.dryRun) return { resultado: Resultado.SIMULADO, codCliente: pendente.codCliente };

    try {
      const { excluidos } = await this.client.excluirLead(this.cfg.skillHash, { codCliente: pendente.codCliente });
      await this.registrarPendente(telefone, null);
      this.log.info(`Retorno removido (cliente foi atendido): ${telefone}`);
      return { resultado: Resultado.REMOVIDO, codCliente: pendente.codCliente, excluidos };
    } catch (e) {
      this.log.erro(`Falha ao remover retorno ${telefone}: ${e.message}`);
      return { resultado: Resultado.FALHA, erro: e.message };
    }
  }

  /** Grava (ou apaga, com null) a pendência de um telefone. */
  registrarPendente(telefone, pendente) {
    const { [telefone]: _antigo, ...outros } = this.pendentes;
    this.pendentes = pendente ? { ...outros, [telefone]: pendente } : outros;
    return this.repositorio.salvar(this.pendentes);
  }

  aguardar() {
    return this.fila;
  }
}

module.exports = { RetornoFilaService, Resultado };

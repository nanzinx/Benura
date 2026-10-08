'use strict';
/**
 * Fim de expediente limpo.
 *
 * Uma vez por dia, HORARIO_FIM + FIM_EXPEDIENTE_MARGEM_MIN, confere quem ainda
 * está logado na Argus:
 *   - acao "relatar" (padrão): só avisa a lista pelo notificador;
 *   - acao "deslogar": também desconecta quem está fora de atendimento.
 * Quem está EM ATENDIMENTO nunca é deslogado. Robôs, grupos virtuais e a lista
 * de exceção (plantão) ficam de fora. Respeita DRY_RUN.
 */

const { classificarStatus, Classe } = require('../domain/rodizio');
const {
  Situacao, horarioComMargem, deveExecutar, operadoresParaVerificar, quemFicouLogado,
} = require('../domain/fim-expediente');
const { mapearUsuario } = require('../integrations/argus/diretorio-operadores.service');
const { mapearComLimite } = require('../utils/concorrencia');
const { dataLocal, horaLocal } = require('../utils/datas');

const GRUPO_OPERACIONAL = 1;

class FimExpedienteService {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ ativo, acao, margemMin, ignorarRamais, horarioFim, fusoHorario, grupoRobosId,
   *           descricoesStatus, concorrencia, dryRun }} deps.cfg
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} deps.repositorio
   * @param {{ registrar(acao: string, dados: object): Promise<object> }} deps.auditoria
   * @param {{ notificar(aviso: object): Promise<void> }} deps.notificador
   * @param {object} deps.logger
   */
  constructor({ client, cfg, repositorio, auditoria, notificador, logger }) {
    Object.assign(this, { client, cfg, repositorio, auditoria, notificador, log: logger });
    this.horarioAlvo = horarioComMargem(cfg.horarioFim, cfg.margemMin);
  }

  /** Chamado a cada tique do agendador: executa só na hora certa, uma vez por dia. */
  async tique(agora = new Date()) {
    if (!this.cfg.ativo) return null;
    const data = dataLocal(this.cfg.fusoHorario, agora);
    const hora = horaLocal(this.cfg.fusoHorario, agora);
    const { ultimaExecucao } = this.repositorio.carregar();
    if (!deveExecutar({ hora, data, horarioAlvo: this.horarioAlvo, ultimaExecucao })) return null;

    const relatorio = await this.executar();
    await this.repositorio.salvar({ ultimaExecucao: data });
    return relatorio;
  }

  /** Executa agora, sem olhar o horário (rotinas:agora --forcar). */
  async executar() {
    const operadores = await this.operadoresHumanos();
    const verificados = await mapearComLimite(operadores, this.cfg.concorrencia, (op) => this.verificar(op));
    const logados = quemFicouLogado(verificados);
    const resultados = await mapearComLimite(logados, this.cfg.concorrencia, (op) => this.tratar(op));

    const relatorio = resumir({ modo: this.cfg.acao, dryRun: this.cfg.dryRun, verificados, resultados });
    await this.auditoria.registrar('fim-expediente', relatorio);
    await this.notificar(relatorio);
    return relatorio;
  }

  async operadoresHumanos() {
    const [usuarios, grupos] = await Promise.all([this.client.listarUsuarios(), this.client.listarGrupos()]);
    const ramaisRobos = grupos
      .filter((g) => g.idGrupoUsuario === this.cfg.grupoRobosId || (g.idTipoGrupo && g.idTipoGrupo !== GRUPO_OPERACIONAL))
      .flatMap((g) => g.ramaisOperadores || []);
    return operadoresParaVerificar(usuarios.map(mapearUsuario), { ignorarRamais: this.cfg.ignorarRamais, ramaisRobos });
  }

  async verificar({ ramal, nome }) {
    try {
      const status = await this.client.statusOperador(ramal);
      return { ramal, nome, classe: classificarStatus(status, this.cfg.descricoesStatus) };
    } catch (e) {
      this.log.aviso(`Status do ramal ${ramal} indisponível: ${e.message}`);
      return { ramal, nome, classe: Classe.ERRO };
    }
  }

  /** @returns {Promise<{ ramal, nome, situacao, deslogado: boolean, erro?: string }>} */
  async tratar(op) {
    const base = { ramal: op.ramal, nome: op.nome, situacao: op.situacao, deslogado: false };
    if (op.situacao !== Situacao.DESLOGAR || this.cfg.acao !== 'deslogar') return base;
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Deslogaria ${op.nome} (${op.ramal})`);
      return base;
    }
    try {
      await this.client.deslogarOperador(op.ramal);
      return { ...base, deslogado: true };
    } catch (e) {
      return { ...base, erro: e.message };
    }
  }

  notificar(relatorio) {
    const { logados, emAtendimento, deslogados, falhas } = relatorio;
    if (!logados.length) {
      return this.notificador.notificar({ titulo: 'Fim de expediente', texto: 'Todos os operadores deslogaram.', dados: relatorio });
    }
    const lista = logados.map((o) => `${o.nome} (${o.ramal})${o.situacao === Situacao.EM_ATENDIMENTO ? ' [em atendimento]' : ''}`);
    const partes = [`${logados.length} operador(es) ainda logado(s): ${lista.join(', ')}.`];
    if (deslogados.length) partes.push(`${deslogados.length} deslogado(s) automaticamente.`);
    if (emAtendimento.length) partes.push(`${emAtendimento.length} em atendimento (não mexido).`);
    if (falhas.length) partes.push(`${falhas.length} falha(s) ao deslogar.`);
    return this.notificador.notificar({
      titulo: 'Fim de expediente', texto: partes.join(' '), nivel: falhas.length ? 'erro' : 'aviso', dados: relatorio,
    });
  }
}

function resumir({ modo, dryRun, verificados, resultados }) {
  return {
    modo,
    dryRun,
    verificados: verificados.length,
    semStatus: verificados.filter((v) => v.classe === Classe.ERRO).map((v) => v.ramal),
    logados: resultados,
    emAtendimento: resultados.filter((r) => r.situacao === Situacao.EM_ATENDIMENTO),
    deslogados: resultados.filter((r) => r.deslogado),
    falhas: resultados.filter((r) => r.erro),
  };
}

module.exports = { FimExpedienteService };

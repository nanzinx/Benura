'use strict';
/**
 * Desligados: às 07:30 e no fim do dia, confere quem está Inativo no Vanguard
 * e continua ativo na Argus. Desloga quem estiver logado e avisa a lista para
 * alguém inativar na Argus (a API da Argus não inativa usuário).
 *
 * Nasce desligado (DESLIGADOS_ATIVO=false) e respeita DRY_RUN.
 */

const { quemSaiu } = require('../domain/desligados');
const { horarioPendente } = require('../domain/bases');
const { mapearUsuario } = require('../integrations/argus/diretorio-operadores.service');
const { lerTabela } = require('../utils/planilhas');
const { dataLocal, horaLocal, diaDaSemanaLocal } = require('../utils/datas');

class DesligadosService {
  /**
   * @param {object} deps
   * @param {{ baixarFuncionarios(opcoes: { hoje: string }): Promise<string> }} deps.fonte - robô do Vanguard ou arquivo
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ ativo: boolean, horarios: string[], diasSemana: number[], toleranciaMin: number,
   *           fusoHorario: string, dryRun: boolean }} deps.cfg
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} deps.repositorio
   * @param {{ registrar(acao: string, dados: object): Promise<object> }} deps.auditoria
   * @param {{ notificar(aviso: object): Promise<void> }} deps.notificador
   * @param {object} deps.logger
   */
  constructor({ fonte, client, cfg, repositorio, auditoria, notificador, logger }) {
    Object.assign(this, { fonte, client, cfg, repositorio, auditoria, notificador, log: logger });
  }

  /** Chamado a cada tique: roda nos horários configurados, uma vez cada. */
  async tique(agora = new Date()) {
    if (!this.cfg.ativo) return null;
    const fuso = this.cfg.fusoHorario;
    const data = dataLocal(fuso, agora);
    const horario = horarioPendente({
      horarios: this.cfg.horarios,
      hora: horaLocal(fuso, agora),
      data,
      diaSemana: diaDaSemanaLocal(fuso, agora),
      diasSemana: this.cfg.diasSemana,
      ultima: this.repositorio.carregar().desligados,
      toleranciaMin: this.cfg.toleranciaMin,
    });
    if (!horario) return null;
    // Marca antes: uma falha (ex.: Vanguard fora) não fica repetindo a cada minuto; avisa e espera o próximo horário.
    await this.repositorio.salvar({ ...this.repositorio.carregar(), desligados: { data, horario } });
    return this.executar().catch(() => null);
  }

  async executar() {
    try {
      const relatorio = await this.conferir();
      await this.auditoria.registrar('desligados', relatorio);
      await this.notificar(relatorio);
      return relatorio;
    } catch (e) {
      this.log.erro(`Conferência de desligados falhou: ${e.message}`);
      await this.notificador.notificar({ titulo: 'Desligados: conferência falhou', texto: e.message, nivel: 'erro' });
      throw e;
    }
  }

  async conferir() {
    const funcionarios = await lerTabela(await this.fonte.baixarFuncionarios({ hoje: dataLocal(this.cfg.fusoHorario) }));
    if (!funcionarios.length) throw new Error('A exportação de Funcionários do Vanguard veio vazia.');
    const usuarios = (await this.client.listarUsuarios()).map(mapearUsuario);
    const saiu = quemSaiu(funcionarios, usuarios);
    const resultados = [];
    for (const pessoa of saiu) resultados.push({ ...pessoa, ...(await this.deslogarSeLogado(pessoa)) });
    return { funcionariosNoVanguard: funcionarios.length, dryRun: this.cfg.dryRun, desligados: resultados };
  }

  /** @returns {Promise<{ estavaLogado: boolean, deslogado?: boolean, erro?: string }>} */
  async deslogarSeLogado({ ramal, login }) {
    if (!ramal) return { estavaLogado: false };
    try {
      if (!(await this.client.statusOperador(ramal))) return { estavaLogado: false };
      if (this.cfg.dryRun) {
        this.log.info(`[DRY_RUN] Deslogaria ${login} (${ramal}), Inativo no Vanguard.`);
        return { estavaLogado: true, deslogado: false };
      }
      await this.client.deslogarOperador(ramal);
      return { estavaLogado: true, deslogado: true };
    } catch (e) {
      return { estavaLogado: null, erro: e.message };
    }
  }

  notificar({ desligados }) {
    if (!desligados.length) {
      this.log.info('Desligados: ninguém Inativo no Vanguard continua ativo na Argus.');
      return undefined;
    }
    const linhas = desligados.map((d) => `• ${d.nome} (${d.login}${d.ramal ? `, ramal ${d.ramal}` : ''})`
      + `${d.deslogado ? ' — deslogado agora' : ''}${d.erro ? ` — falha ao deslogar: ${d.erro}` : ''}`);
    return this.notificador.notificar({
      titulo: `Desligados: ${desligados.length} ainda ativo(s) na Argus`,
      texto: `Inativos no Vanguard, mas ativos na Argus. Inative na Argus (Config. › Usuários Operadores):\n${linhas.join('\n')}`,
      nivel: 'aviso',
      dados: { desligados },
    });
  }
}

/** Fonte para ensaio: uma exportação de Funcionários já salva. */
class FuncionariosDeArquivo {
  constructor(arquivo) {
    this.arquivo = arquivo;
  }

  async baixarFuncionarios() {
    return this.arquivo;
  }
}

module.exports = { DesligadosService, FuncionariosDeArquivo };

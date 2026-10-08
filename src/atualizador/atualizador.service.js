'use strict';
/**
 * Atualizador da produção: traz a `main` para esta máquina e reinicia os
 * serviços, com volta automática se algo der errado.
 *
 * Roda NA máquina de produção e busca as mudanças (pull), então não precisa
 * de IP público, porta aberta nem SSH — funciona igual no Windows e no Linux.
 *
 * Uma verificação:
 *   1. fora da janela de deploy (expediente) → não faz nada
 *   2. git fetch; nada novo → não faz nada
 *   3. alteração local em arquivo versionado, ou branch divergente → aborta (não arrisca)
 *   4. fast-forward → npm ci (só se o package-lock mudou) → npm test
 *   5. pm2 startOrReload → espera o /health de cada serviço
 *   Falha em 4 ou 5 → volta ao commit anterior (e recarrega se já tinha recarregado).
 *
 * Cada resultado vai para a trilha de auditoria (logs/deploy.jsonl).
 */

const { podeFazerDeploy } = require('../domain/janela-deploy');

const Resultado = Object.freeze({
  FORA_DA_JANELA: 'FORA_DA_JANELA',
  SEM_MUDANCA: 'SEM_MUDANCA',
  ABORTADO: 'ABORTADO',
  IMPLANTADO: 'IMPLANTADO',
  REVERTIDO: 'REVERTIDO',
});

class FalhaDeEtapa extends Error {
  constructor(etapa, saida) {
    super(`Falhou: ${etapa}`);
    this.etapa = etapa;
    this.saida = saida;
  }
}

class AtualizadorService {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./executor').criarExecutor>} deps.executar
   * @param {(urls: string[], opcoes: object) => Promise<{ ok: boolean, falharam: string[] }>} deps.aguardarSaude
   * @param {{ momento(): { diaSemana: number, hora: string } }} deps.relogio
   * @param {{ branch: string, apps: string[], healthUrls: string[], healthTimeoutMs: number,
   *           expediente: { inicio: string, fim: string } }} deps.cfg
   * @param {{ registrar(acao: string, dados: object): Promise<object> }} deps.auditoria
   * @param {object} deps.logger
   */
  constructor({ executar, aguardarSaude, relogio, cfg, auditoria, logger }) {
    Object.assign(this, { executar, aguardarSaude, relogio, cfg, auditoria, log: logger });
    this.ultimo = null;
  }

  janelaAberta() {
    return podeFazerDeploy({ ...this.relogio.momento(), ...this.cfg.expediente });
  }

  /**
   * Uma verificação completa.
   * @param {{ ignorarJanela?: boolean }} [opcoes]
   * @returns {Promise<{ resultado: string }>}
   */
  async verificar({ ignorarJanela = false } = {}) {
    if (!ignorarJanela && !this.janelaAberta()) return this.concluir({ resultado: Resultado.FORA_DA_JANELA }, false);

    await this.etapa('git fetch', 'git', ['fetch', '--quiet', 'origin', this.cfg.branch]);
    const anterior = await this.revisao('HEAD');
    const alvo = await this.revisao(`origin/${this.cfg.branch}`);
    if (anterior === alvo) return this.concluir({ resultado: Resultado.SEM_MUDANCA, commit: anterior }, false);

    const impedimento = await this.impedimento();
    if (impedimento) return this.concluir({ resultado: Resultado.ABORTADO, motivo: impedimento, anterior, alvo });

    return this.implantar(anterior, alvo);
  }

  /** Motivo para não atualizar, ou null. */
  async impedimento() {
    const status = await this.executar('git', ['status', '--porcelain', '--untracked-files=no']);
    if (status.saida) return `alterações locais em arquivos versionados:\n${status.saida}`;

    const ff = await this.executar('git', ['merge-base', '--is-ancestor', 'HEAD', `origin/${this.cfg.branch}`]);
    if (!ff.ok) return `o código local divergiu de origin/${this.cfg.branch} (não é fast-forward)`;
    return null;
  }

  async implantar(anterior, alvo) {
    const dependenciasMudaram = await this.lockMudou(anterior, alvo);
    this.log.info(`Atualizando ${anterior.slice(0, 7)} → ${alvo.slice(0, 7)}${dependenciasMudaram ? ' (com npm ci)' : ''}`);

    try {
      await this.instalarETestar(alvo, dependenciasMudaram);
    } catch (e) {
      await this.reverter(anterior, { dependenciasMudaram, recarregar: false });
      return this.concluir({ resultado: Resultado.REVERTIDO, etapa: e.etapa, saida: e.saida, anterior, alvo });
    }

    const falha = await this.ativar();
    if (!falha) return this.concluir({ resultado: Resultado.IMPLANTADO, anterior, alvo });

    await this.reverter(anterior, { dependenciasMudaram, recarregar: true });
    return this.concluir({ resultado: Resultado.REVERTIDO, ...falha, anterior, alvo });
  }

  async instalarETestar(alvo, dependenciasMudaram) {
    await this.etapa('git merge --ff-only', 'git', ['merge', '--ff-only', '--quiet', alvo]);
    if (dependenciasMudaram) await this.etapa('npm ci', 'npm', ['ci', '--no-audit', '--no-fund']);
    await this.etapa('npm test', 'npm', ['test']);
  }

  /** Recarrega os serviços e espera a saúde. @returns {Promise<object|null>} falha, ou null se ok */
  async ativar() {
    const recarga = await this.recarregar();
    if (!recarga.ok) return { etapa: 'pm2 startOrReload', saida: recarga.saida };

    const saude = await this.aguardarSaude(this.cfg.healthUrls, { timeoutMs: this.cfg.healthTimeoutMs });
    if (!saude.ok) return { etapa: 'health', saida: `sem resposta: ${saude.falharam.join(', ')}` };
    return null;
  }

  recarregar() {
    return this.executar('npx', ['pm2', 'startOrReload', 'ecosystem.config.js', '--only', this.cfg.apps.join(',')]);
  }

  /** Volta ao commit anterior; reinstala e recarrega se preciso. */
  async reverter(anterior, { dependenciasMudaram, recarregar }) {
    this.log.aviso(`Revertendo para ${anterior.slice(0, 7)}...`);
    await this.executar('git', ['reset', '--hard', '--quiet', anterior]);
    if (dependenciasMudaram) await this.executar('npm', ['ci', '--no-audit', '--no-fund']);
    if (!recarregar) return;

    await this.recarregar();
    const saude = await this.aguardarSaude(this.cfg.healthUrls, { timeoutMs: this.cfg.healthTimeoutMs });
    if (!saude.ok) this.log.erro(`Mesmo após reverter, sem resposta de: ${saude.falharam.join(', ')}. Verifique a máquina.`);
  }

  async lockMudou(anterior, alvo) {
    const diff = await this.executar('git', ['diff', '--quiet', anterior, alvo, '--', 'package-lock.json']);
    return !diff.ok;
  }

  async revisao(ref) {
    const r = await this.etapa(`git rev-parse ${ref}`, 'git', ['rev-parse', ref]);
    return r.saida.trim();
  }

  /** Executa um comando que precisa dar certo. @throws {FalhaDeEtapa} */
  async etapa(nome, comando, args) {
    const r = await this.executar(comando, args);
    if (!r.ok) throw new FalhaDeEtapa(nome, r.saida);
    return r;
  }

  /** Guarda o último resultado; registra na auditoria os que importam. */
  async concluir(resultado, auditar = true) {
    this.ultimo = { ...resultado, em: new Date().toISOString() };
    if (!auditar) return resultado;

    await this.auditoria.registrar(`deploy.${resultado.resultado.toLowerCase()}`, resultado);
    const nivel = resultado.resultado === Resultado.IMPLANTADO ? 'info' : 'erro';
    this.log[nivel](`Deploy: ${resultado.resultado}${resultado.etapa ? ` (etapa: ${resultado.etapa})` : ''}`
      + `${resultado.motivo ? ` — ${resultado.motivo}` : ''}`);
    return resultado;
  }
}

module.exports = { AtualizadorService, Resultado, FalhaDeEtapa };

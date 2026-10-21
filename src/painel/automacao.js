'use strict';
/**
 * Botões "Desligar automação" e "Religar automação" do painel.
 *
 * Desligar (em segundo plano; o andamento aparece em /api/visao):
 *   1. marca a automação como desligada (AUTOMACAO_FILE): se algum serviço subir
 *      de novo (PC reiniciado, pm2 start, atualizador), ele espera sem mexer na Argus;
 *   2. o rodízio para de mover gente e desliga os robôs parados; os em ligação
 *      terminam a chamada (o painel pede de novo a cada poucos segundos). Passado
 *      AUTOMACAO_ESPERA_ROBOS_MS, derruba os que sobrarem;
 *   3. para roteador, rodízio e rotinas (npx pm2 stop). O painel continua no ar.
 * Religar: tira a marca e sobe os três de novo (npx pm2 startOrRestart). Os
 * robôs continuam desligados: quem liga é a supervisão, pela Argus.
 */

const { lerAutomacao, gravarAutomacao } = require('../utils/automacao');

const APPS = ['benura-roteador', 'benura-rodizio', 'benura-rotinas'];
const REPETIR_ROBOS_MS = 5000;
const esperarMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

class ControleAutomacao {
  /**
   * @param {object} deps
   * @param {{ arquivo: string, esperaRobosMs: number }} deps.cfg - cfg.automacao
   * @param {import('./servicos').Servicos} deps.servicos
   * @param {(comando: string, args: string[], opcoes?: object) => Promise<{ ok: boolean, saida: string }>} deps.executar
   * @param {object} deps.logger
   */
  constructor({ cfg, servicos, executar, logger, agora = Date.now, esperar = esperarMs }) {
    Object.assign(this, { cfg, servicos, executar, log: logger, agora, esperar });
    /** Em andamento: { estado: 'desligando'|'religando', etapa, aviso } | null */
    this.andamento = null;
    this.ultimoAviso = null;
  }

  /** Para o /api/visao. */
  estado() {
    const gravado = lerAutomacao(this.cfg.arquivo);
    if (this.andamento) return { ...this.andamento, desde: gravado.desde, por: gravado.por };
    return { estado: gravado.desligada ? 'desligada' : 'ligada', etapa: null, desde: gravado.desde, por: gravado.por, aviso: this.ultimoAviso };
  }

  /** @returns {{ iniciado: boolean, motivo?: string }} */
  desligar(por) {
    if (this.andamento) return { iniciado: false, motivo: `Já está ${this.andamento.estado === 'desligando' ? 'desligando' : 'religando'}.` };
    if (lerAutomacao(this.cfg.arquivo).desligada) return { iniciado: false, motivo: 'A automação já está desligada.' };
    this.andamento = { estado: 'desligando', etapa: 'marcando a automação como desligada', aviso: null };
    this.ultimoAviso = null;
    this.executarDesligamento(por).catch((e) => this.falhou('desligar', e));
    return { iniciado: true };
  }

  /** @returns {{ iniciado: boolean, motivo?: string }} */
  religar(por) {
    if (this.andamento) return { iniciado: false, motivo: 'Espere terminar o que está em andamento.' };
    this.andamento = { estado: 'religando', etapa: 'subindo os serviços', aviso: null };
    this.ultimoAviso = null;
    this.executarReligamento(por).catch((e) => this.falhou('religar', e));
    return { iniciado: true };
  }

  async executarDesligamento(por) {
    this.log.aviso(`Painel: automação sendo DESLIGADA (${por}).`);
    await gravarAutomacao(this.cfg.arquivo, { desligada: true, desde: new Date(this.agora()).toISOString(), por }, this.log);
    await this.desligarRobos();
    this.andamento.etapa = 'parando roteador, rodízio e rotinas';
    const r = await this.executar('npx', ['pm2', 'stop', ...APPS], { timeoutMs: 60_000 });
    if (!r.ok) this.avisar(`Não foi possível parar os serviços pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npx pm2 stop all.`);
    this.log.aviso(`Painel: automação DESLIGADA (${por}).${this.andamento.aviso ? ` Atenção: ${this.andamento.aviso}` : ''}`);
    this.concluir();
  }

  /** Robôs parados saem já; os em ligação terminam a chamada; passado o prazo, derruba os que sobraram. */
  async desligarRobos() {
    const inicio = this.agora();
    for (;;) {
      const derrubar = this.agora() - inicio >= this.cfg.esperaRobosMs;
      const r = await this.servicos.chamar('rodizio', '/automacao/encerrar-robos', { metodo: 'POST', corpo: JSON.stringify({ derrubar }), timeoutMs: 30_000 });
      if (r.status !== 200) {
        this.avisar(`Rodízio sem resposta (${r.corpo?.erro ?? `HTTP ${r.status}`}): desligue os robôs pelo painel da Argus.`);
        return;
      }
      const ligados = r.corpo?.ligados;
      if (!ligados || derrubar) {
        if (ligados) this.avisar(`${ligados} robô(s) continuavam ligados depois de ${Math.round(this.cfg.esperaRobosMs / 1000)} s: confira no painel da Argus.`);
        return;
      }
      this.andamento.etapa = `desligando os robôs: ${ligados} ainda em ligação, terminando a chamada`;
      await this.esperar(REPETIR_ROBOS_MS);
    }
  }

  async executarReligamento(por) {
    this.log.aviso(`Painel: automação sendo RELIGADA (${por}).`);
    await gravarAutomacao(this.cfg.arquivo, { desligada: false, desde: new Date(this.agora()).toISOString(), por }, this.log);
    const r = await this.executar('npx', ['pm2', 'startOrRestart', 'ecosystem.config.js', '--only', APPS.join(',')], { timeoutMs: 60_000 });
    if (!r.ok) this.avisar(`Não foi possível subir os serviços pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npm run pm2:iniciar.`);
    this.log.aviso(`Painel: automação RELIGADA (${por}). Os robôs continuam desligados: quem liga é a supervisão, pela Argus.`);
    this.concluir();
  }

  avisar(texto) {
    this.andamento.aviso = this.andamento.aviso ? `${this.andamento.aviso} ${texto}` : texto;
    this.log.aviso(`Painel: ${texto}`);
  }

  concluir() {
    this.ultimoAviso = this.andamento?.aviso ?? null;
    this.andamento = null;
  }

  falhou(acao, e) {
    this.log.erro(`Painel: falha ao ${acao} a automação: ${e.message}`);
    this.ultimoAviso = `Falha ao ${acao} a automação: ${e.message}`;
    this.andamento = null;
  }
}

const ultimaLinha = (saida) => String(saida || 'sem saída').trim().split(/\r?\n/).pop().slice(0, 200);

module.exports = { ControleAutomacao, APPS };

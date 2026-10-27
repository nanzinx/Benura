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
 *
 * Modo simulação (DRY_RUN): grava a escolha (SIMULACAO_FILE) e reinicia os três
 * (o DRY_RUN só é lido quando o serviço sobe). Com a automação desligada, só grava.
 *
 * [NOVO] Dois PCs (trava.js): desligar ou ligar a simulação soltam a trava no fim;
 * religar e sair da simulação pegam antes (prepararParaAgir), e recusam com o outro
 * PC agindo de verdade.
 *
 * [NOVO] Cada componente (roteador, rodízio, rotinas) liga e desliga sozinho
 * (desligarComponente / religarComponente): a marca fica em `componentes` no mesmo
 * arquivo. Desligar o rodízio desliga os robôs antes (ninguém mais desligaria). O
 * desligar/religar da automação toda mantém as marcas: religar sobe só os que não
 * foram desligados à mão. Com os três desligados, este PC solta a trava.
 */

const { COMPONENTES, componenteAtivo, lerAutomacao, gravarAutomacao, lerSimulacao } = require('../utils/automacao');

const APPS = COMPONENTES;
const NOMES = { 'benura-roteador': 'roteador', 'benura-rodizio': 'rodízio', 'benura-rotinas': 'rotinas' };
const REPETIR_ROBOS_MS = 5000;
const esperarMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

class ControleAutomacao {
  /**
   * @param {object} deps
   * @param {{ arquivo: string, esperaRobosMs: number, arquivoSimulacao: string, dryRunPeloEnv?: boolean }} deps.cfg
   *        cfg.automacao + DRY_RUN do .env
   * @param {import('./servicos').Servicos} deps.servicos
   * @param {(comando: string, args: string[], opcoes?: object) => Promise<{ ok: boolean, saida: string }>} deps.executar
   * @param {object} deps.logger
   */
  constructor({ cfg, servicos, executar, logger, agora = Date.now, esperar = esperarMs, trava = null, parceiro = null }) {
    Object.assign(this, { cfg, servicos, executar, log: logger, agora, esperar, trava, parceiro });
    /** Em andamento: { estado: 'desligando'|'religando'|'reiniciando', etapa, aviso } | null */
    this.andamento = null;
    this.ultimoAviso = null;
  }

  /** Para o /api/visao. */
  estado() {
    const gravado = lerAutomacao(this.cfg.arquivo);
    const sim = lerSimulacao(this.cfg.arquivoSimulacao);
    const simulacao = { escolhida: sim.ligada, fixaPeloEnv: Boolean(this.cfg.dryRunPeloEnv), desde: sim.desde, por: sim.por };
    const { componentes } = gravado;
    if (this.andamento) return { ...this.andamento, desde: gravado.desde, por: gravado.por, simulacao, componentes };
    return { estado: gravado.desligada ? 'desligada' : 'ligada', etapa: null, desde: gravado.desde, por: gravado.por, aviso: this.ultimoAviso, simulacao, componentes };
  }

  /** [NOVO] Este PC deve agir de verdade agora? (automação ligada, algum componente ligado, fora da simulação) */
  agindoDeVerdade() {
    const gravado = lerAutomacao(this.cfg.arquivo);
    return APPS.some((app) => componenteAtivo(gravado, app)) && !this.cfg.dryRunPeloEnv && !lerSimulacao(this.cfg.arquivoSimulacao).ligada;
  }

  /** [NOVO] Os apps que devem rodar agora (a automação ligada e não desligados à mão). */
  appsAtivos(gravado = lerAutomacao(this.cfg.arquivo)) {
    return APPS.filter((app) => !gravado.componentes[app]?.desligado);
  }

  /** Grava a automação toda sem perder as marcas de cada componente (e vice-versa). */
  gravar(mudanca) {
    const atual = lerAutomacao(this.cfg.arquivo);
    const { desligada, desde, por, componentes } = { ...atual, ...mudanca };
    return gravarAutomacao(this.cfg.arquivo, { desligada, desde, por, componentes }, this.log);
  }

  /**
   * [NOVO] Antes de religar ou sair da simulação: copia o estado do dia do outro PC (se ele
   * esteve com a trava por último) e pega a trava. Com o outro PC agindo, recusa.
   * @returns {Promise<{ ok: boolean, motivo?: string }>}
   */
  async prepararParaAgir(por) {
    if (!this.trava?.ativa) return { ok: true };
    if (this.andamento) return { ok: false, motivo: 'Espere terminar o que está em andamento.' };
    const antes = await this.trava.podePegar({ venceu: true });
    if (!antes.ok) return antes;
    await this.parceiro?.copiarDia().catch((e) => this.log.aviso(`Dois PCs: não foi possível copiar o estado do dia (${e.message}).`));
    return this.trava.pegar(por, { venceu: true });
  }

  /** [NOVO] Perdeu a trava: os robôs parados desligam já (os serviços param sozinhos sem a posse). */
  async pararPelaTrava(motivo) {
    const r = await this.servicos.chamar('rodizio', '/automacao/encerrar-robos', { metodo: 'POST', corpo: JSON.stringify({ derrubar: false }), timeoutMs: 30_000 });
    if (r.status !== 200) this.log.aviso(`Painel: rodízio sem resposta ao perder a trava (${motivo}): confira os robôs no painel da Argus.`);
  }

  /**
   * Liga ou desliga o modo simulação (DRY_RUN) e reinicia os serviços para valer.
   * @returns {{ iniciado: boolean, motivo?: string }}
   */
  definirSimulacao(ligada, por) {
    if (this.andamento) return { iniciado: false, motivo: 'Espere terminar o que está em andamento.' };
    if (!ligada && this.cfg.dryRunPeloEnv) return { iniciado: false, motivo: 'A simulação está fixa pelo .env (DRY_RUN=1): troque para DRY_RUN=0 no PC do BenURA.' };
    if (lerSimulacao(this.cfg.arquivoSimulacao).ligada === ligada) return { iniciado: false, motivo: `A simulação já está ${ligada ? 'ligada' : 'desligada'}.` };
    this.andamento = { estado: 'reiniciando', etapa: `${ligada ? 'ligando' : 'desligando'} a simulação: reiniciando roteador, rodízio e rotinas`, aviso: null };
    this.ultimoAviso = null;
    this.executarSimulacao(ligada, por).catch((e) => this.falhou(`${ligada ? 'ligar' : 'desligar'} a simulação`, e));
    return { iniciado: true };
  }

  async executarSimulacao(ligada, por) {
    await gravarAutomacao(this.cfg.arquivoSimulacao, { ligada, desde: new Date(this.agora()).toISOString(), por }, this.log);
    if (lerAutomacao(this.cfg.arquivo).desligada) {
      this.log.aviso(`Painel: simulação ${ligada ? 'LIGADA' : 'DESLIGADA'} (${por}); vale quando a automação for religada.`);
      return this.concluir();
    }
    const apps = this.appsAtivos();
    const r = apps.length ? await this.executar('npx', ['pm2', 'startOrRestart', 'ecosystem.config.js', '--only', apps.join(',')], { timeoutMs: 60_000 }) : { ok: true };
    if (!r.ok) this.avisar(`Não foi possível reiniciar os serviços pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npx pm2 restart all.`);
    this.log.aviso(`Painel: simulação ${ligada ? 'LIGADA: o BenURA só mostra o que faria' : 'DESLIGADA: o BenURA volta a agir de verdade'} (${por}).`);
    if (ligada) await this.trava?.soltar();
    return this.concluir();
  }

  /** @returns {{ iniciado: boolean, motivo?: string }} */
  desligar(por) {
    if (this.andamento) return { iniciado: false, motivo: `Já está ${this.andamento.estado === 'desligando' ? 'desligando' : 'religando'}.` };
    if (lerAutomacao(this.cfg.arquivo).desligada) return { iniciado: false, motivo: 'A automação já está desligada.' };
    this.andamento = { estado: 'desligando', etapa: 'marcando a automação como desligada', aviso: null };
    this.ultimoAviso = null;
    this.executarDesligamento(por).catch((e) => this.falhou('desligar a automação', e));
    return { iniciado: true };
  }

  /** @returns {{ iniciado: boolean, motivo?: string }} */
  religar(por) {
    if (this.andamento) return { iniciado: false, motivo: 'Espere terminar o que está em andamento.' };
    this.andamento = { estado: 'religando', etapa: 'subindo os serviços', aviso: null };
    this.ultimoAviso = null;
    this.executarReligamento(por).catch((e) => this.falhou('religar a automação', e));
    return { iniciado: true };
  }

  async executarDesligamento(por) {
    this.log.aviso(`Painel: automação sendo DESLIGADA (${por}).`);
    const rodizioJaParado = Boolean(lerAutomacao(this.cfg.arquivo).componentes['benura-rodizio']);
    await this.gravar({ desligada: true, desde: new Date(this.agora()).toISOString(), por });
    if (!rodizioJaParado) await this.desligarRobos(); // desligado à mão, os robôs já saíram antes
    this.andamento.etapa = 'parando roteador, rodízio e rotinas';
    const r = await this.executar('npx', ['pm2', 'stop', ...APPS], { timeoutMs: 60_000 });
    if (!r.ok) this.avisar(`Não foi possível parar os serviços pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npx pm2 stop all.`);
    this.log.aviso(`Painel: automação DESLIGADA (${por}).${this.andamento.aviso ? ` Atenção: ${this.andamento.aviso}` : ''}`);
    await this.trava?.soltar();
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
    await this.gravar({ desligada: false, desde: new Date(this.agora()).toISOString(), por });
    const apps = this.appsAtivos();
    const r = apps.length ? await this.executar('npx', ['pm2', 'startOrRestart', 'ecosystem.config.js', '--only', apps.join(',')], { timeoutMs: 60_000 }) : { ok: true };
    if (!r.ok) this.avisar(`Não foi possível subir os serviços pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npm run pm2:iniciar.`);
    const parados = APPS.filter((app) => !apps.includes(app)).map((app) => NOMES[app]);
    this.log.aviso(`Painel: automação RELIGADA (${por}).${parados.length ? ` Continuam desligados à mão: ${parados.join(', ')}.` : ''} Os robôs continuam desligados: quem liga é a supervisão, pela Argus.`);
    this.concluir();
  }

  /**
   * [NOVO] Desliga só um componente (botão no cartão dele, aba Serviços).
   * @param {string} app - benura-roteador | benura-rodizio | benura-rotinas
   * @returns {{ iniciado: boolean, motivo?: string }}
   */
  desligarComponente(app, por) {
    if (!APPS.includes(app)) return { iniciado: false, motivo: `Componente desconhecido: ${app}.` };
    if (this.andamento) return { iniciado: false, motivo: 'Espere terminar o que está em andamento.' };
    if (lerAutomacao(this.cfg.arquivo).componentes[app]) return { iniciado: false, motivo: `O ${NOMES[app]} já está desligado.` };
    this.andamento = { estado: 'reiniciando', etapa: `desligando o ${NOMES[app]}`, aviso: null };
    this.ultimoAviso = null;
    this.executarDesligarComponente(app, por).catch((e) => this.falhou(`desligar o ${NOMES[app]}`, e));
    return { iniciado: true };
  }

  async executarDesligarComponente(app, por) {
    this.log.aviso(`Painel: ${NOMES[app]} sendo DESLIGADO sozinho (${por}).`);
    const antes = lerAutomacao(this.cfg.arquivo);
    await this.gravar({ componentes: { ...antes.componentes, [app]: { desligado: true, desde: new Date(this.agora()).toISOString(), por } } });
    if (!antes.desligada) {
      // Sem o rodízio, ninguém desliga os robôs: desliga antes.
      if (app === 'benura-rodizio') await this.desligarRobos();
      this.andamento.etapa = `parando o ${NOMES[app]}`;
      const r = await this.executar('npx', ['pm2', 'stop', app], { timeoutMs: 60_000 });
      if (!r.ok) this.avisar(`Não foi possível parar o ${NOMES[app]} pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npx pm2 stop ${app}.`);
    }
    this.log.aviso(`Painel: ${NOMES[app]} DESLIGADO (${por}); o resto da automação segue.${this.andamento.aviso ? ` Atenção: ${this.andamento.aviso}` : ''}`);
    if (!this.appsAtivos().length) await this.trava?.soltar(); // os três parados: este PC não age mais
    this.concluir();
  }

  /** [NOVO] Liga de novo um componente desligado à mão. @returns {{ iniciado: boolean, motivo?: string }} */
  religarComponente(app, por) {
    if (!APPS.includes(app)) return { iniciado: false, motivo: `Componente desconhecido: ${app}.` };
    if (this.andamento) return { iniciado: false, motivo: 'Espere terminar o que está em andamento.' };
    if (!lerAutomacao(this.cfg.arquivo).componentes[app]) return { iniciado: false, motivo: `O ${NOMES[app]} já está ligado.` };
    this.andamento = { estado: 'reiniciando', etapa: `ligando o ${NOMES[app]}`, aviso: null };
    this.ultimoAviso = null;
    this.executarReligarComponente(app, por).catch((e) => this.falhou(`ligar o ${NOMES[app]}`, e));
    return { iniciado: true };
  }

  async executarReligarComponente(app, por) {
    const antes = lerAutomacao(this.cfg.arquivo);
    const componentes = { ...antes.componentes };
    delete componentes[app];
    await this.gravar({ componentes });
    if (antes.desligada) {
      this.log.aviso(`Painel: ${NOMES[app]} marcado para ligar (${por}); sobe quando a automação for religada.`);
      return this.concluir();
    }
    const r = await this.executar('npx', ['pm2', 'startOrRestart', 'ecosystem.config.js', '--only', app], { timeoutMs: 60_000 });
    if (!r.ok) this.avisar(`Não foi possível subir o ${NOMES[app]} pelo PM2 (${ultimaLinha(r.saida)}). No PC do BenURA: npm run pm2:iniciar.`);
    this.log.aviso(`Painel: ${NOMES[app]} LIGADO de novo (${por}).`);
    return this.concluir();
  }

  avisar(texto) {
    this.andamento.aviso = this.andamento.aviso ? `${this.andamento.aviso} ${texto}` : texto;
    this.log.aviso(`Painel: ${texto}`);
  }

  concluir() {
    this.ultimoAviso = this.andamento?.aviso ?? null;
    this.andamento = null;
  }

  falhou(oQue, e) {
    this.log.erro(`Painel: falha ao ${oQue}: ${e.message}`);
    this.ultimoAviso = `Falha ao ${oQue}: ${e.message}`;
    this.andamento = null;
  }
}

const ultimaLinha = (saida) => String(saida || 'sem saída').trim().split(/\r?\n/).pop().slice(0, 200);

module.exports = { ControleAutomacao, APPS, NOMES_DOS_COMPONENTES: NOMES };

'use strict';
/**
 * Robôs por livre que se ajustam pelos callbacks, como a supervisão faria.
 *
 * O ROBOS_POR_LIVRE (7) é a média que funciona na maioria dos dias; numa URA
 * mais agressiva, dois clientes pedem humano juntos e o segundo espera na fila.
 * Cada callback (webhook "encerramento de URA" com abandono ou time-out na
 * fila) baixa um degrau (7→6→5…, até o piso). Sem callback por um tempo, sobe
 * um degrau de volta, até o valor do .env.
 *
 * Só baixa: reduzir robôs nunca derruba quem está em ligação (os poupados saem
 * ao terminar) e nunca gera callback. Pior caso: deriva menos até recuperar.
 *
 * Fica gravado em arquivo: reiniciar no mesmo dia retoma o degrau em que estava
 * (senão voltaria a 7 de uma vez no meio de um dia agressivo).
 */

/** O mesmo callback repetido pela Argus (reenvio) não conta duas vezes. */
const LEMBRAR_CALLBACK_MS = 10 * 60_000;

class AjustePorCallback {
  /**
   * @param {object} deps
   * @param {{ base: number, piso: number, recuperarAposMs: number, intervaloMinMs: number }} deps.cfg
   * @param {object} deps.logger
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} [deps.repositorio]
   * @param {() => string} [deps.hoje] - AAAA-MM-DD no fuso da operação
   */
  constructor({ cfg, logger, repositorio = null, hoje = () => '' }) {
    Object.assign(this, { cfg, log: logger, repositorio, hoje });
    this.porLivre = cfg.base;
    this.ultimaMudanca = 0; // última queda, subida ou callback (a recuperação conta daqui)
    this.ultimaQueda = -Infinity;
    this.callbacks = 0;
    this.ultimoCallbackEm = 0;
    /** chave do callback → quando chegou */
    this.vistos = new Map();
  }

  /** Retoma o ajuste gravado hoje (reinício no meio do dia). */
  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    if (!salvo.data || salvo.data !== this.hoje()) return this;
    this.porLivre = Math.min(this.cfg.base, Math.max(this.cfg.piso, Number(salvo.porLivre) || this.cfg.base));
    this.ultimaMudanca = Number(salvo.ultimaMudanca) || 0;
    this.ultimaQueda = Number(salvo.ultimaQueda) || -Infinity;
    this.callbacks = Number(salvo.callbacks) || 0;
    this.ultimoCallbackEm = Number(salvo.ultimoCallbackEm) || 0;
    if (this.porLivre < this.cfg.base) this.log.info(`Ajuste dos robôs retomado: ${this.porLivre} por livre (${this.callbacks} callback(s) hoje).`);
    return this;
  }

  salvar() {
    if (!this.repositorio) return;
    const { porLivre, ultimaMudanca, callbacks, ultimoCallbackEm } = this;
    const ultimaQueda = Number.isFinite(this.ultimaQueda) ? this.ultimaQueda : null;
    this.repositorio.salvar({ data: this.hoje(), porLivre, ultimaMudanca, ultimaQueda, callbacks, ultimoCallbackEm });
  }

  /** Robôs por livre agora; sobe um degrau a cada `recuperarAposMs` sem callback. */
  atual(agora = Date.now()) {
    if (this.porLivre >= this.cfg.base || agora - this.ultimaMudanca < this.cfg.recuperarAposMs) return this.porLivre;
    this.mudar(this.porLivre + 1, agora, `${Math.round(this.cfg.recuperarAposMs / 60_000)} min sem callback`);
    return this.porLivre;
  }

  /**
   * @param {{ motivo: string, chave: string|null }} callback
   * @param {{ agora?: number, manual?: boolean, situacao?: string }} [contexto]
   *        manual: a supervisão comanda os robôs (o callback não é do BenURA);
   *        situacao: livres/robôs no momento, para o log
   * @returns {boolean} true se baixou um degrau
   */
  registrarCallback({ motivo, chave }, { agora = Date.now(), manual = false, situacao = '' } = {}) {
    if (this.repetido(chave, agora)) return false;
    this.callbacks++;
    this.ultimoCallbackEm = agora;
    const descricao = `Callback (${motivo})${situacao ? ` com ${situacao}` : ''}`;

    if (manual) return this.anotar(`${descricao}. Robôs no modo manual: não ajusta.`);
    this.ultimaMudanca = agora; // adia a recuperação
    if (this.porLivre <= this.cfg.piso) return this.anotar(`${descricao}. Já no mínimo de ${this.cfg.piso} robôs por livre.`);
    if (agora - this.ultimaQueda < this.cfg.intervaloMinMs) return this.anotar(`${descricao}. Já baixou há menos de ${Math.round(this.cfg.intervaloMinMs / 1000)} s.`);

    this.ultimaQueda = agora;
    this.mudar(this.porLivre - 1, agora, descricao);
    return true;
  }

  repetido(chave, agora) {
    for (const [k, quando] of this.vistos) {
      if (agora - quando > LEMBRAR_CALLBACK_MS) this.vistos.delete(k);
    }
    if (!chave) return false;
    if (this.vistos.has(chave)) return true;
    this.vistos.set(chave, agora);
    return false;
  }

  /** Callback que não baixou o degrau: registra (e grava a contagem). */
  anotar(mensagem) {
    this.log.aviso(mensagem);
    this.salvar();
    return false;
  }

  mudar(novo, agora, motivo) {
    this.log.aviso(`${motivo}: robôs por livre ${this.porLivre}→${novo}.`);
    this.porLivre = novo;
    this.ultimaMudanca = agora;
    this.salvar();
  }

  resumo(agora = Date.now()) {
    return {
      porLivre: this.atual(agora),
      base: this.cfg.base,
      piso: this.cfg.piso,
      callbacks: this.callbacks,
      ultimoCallback: this.ultimoCallbackEm ? new Date(this.ultimoCallbackEm).toISOString() : null,
    };
  }
}

module.exports = { AjustePorCallback };

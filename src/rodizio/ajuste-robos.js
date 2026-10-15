'use strict';
/**
 * Robôs por livre que se ajustam ao dia, como a supervisão faria.
 *
 * O ROBOS_POR_LIVRE (7) é o ponto de partida. A URA muda de um dia para o outro:
 *  - agressiva: dois clientes pedem humano juntos e o segundo espera na fila.
 *    Cada callback (webhook "encerramento de URA" com abandono ou time-out na
 *    fila) baixa um degrau, até o piso;
 *  - passiva: os livres ficam parados sem receber derivação. Com os robôs já
 *    todos no alvo e ninguém da URA atendendo há ROBOS_PASSIVA_APOS_MIN, sobe
 *    um degrau, até o máximo (no máximo um degrau a cada esse tempo).
 * Abaixo do ROBOS_POR_LIVRE, sem callback por ROBOS_RECUPERAR_APOS_MIN, sobe 1
 * de volta. A supervisão também ajusta à mão (página /ura); o automático
 * continua a partir do valor escolhido.
 *
 * Fica gravado em arquivo: reiniciar no mesmo dia retoma o valor em que estava.
 */

/** O mesmo callback repetido pela Argus (reenvio) não conta duas vezes. */
const LEMBRAR_CALLBACK_MS = 10 * 60_000;

class AjusteRobos {
  /**
   * @param {object} deps
   * @param {{ base: number, piso: number, maximo: number, degrau: number, recuperarAposMs: number,
   *           intervaloMinMs: number, passivaMs: number, automatico?: boolean }} deps.cfg
   * @param {object} deps.logger
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} [deps.repositorio]
   * @param {() => string} [deps.hoje] - AAAA-MM-DD no fuso da operação
   */
  constructor({ cfg, logger, repositorio = null, hoje = () => '' }) {
    Object.assign(this, { cfg: { automatico: true, ...cfg }, log: logger, repositorio, hoje });
    this.porLivre = cfg.base;
    this.ultimaMudanca = 0; // última queda, subida ou callback (a recuperação conta daqui)
    this.ultimaQueda = -Infinity;
    this.ultimaSubida = -Infinity; // subida por URA passiva ou ajuste manual
    this.callbacks = 0;
    this.ultimoCallbackEm = 0;
    this.ajustadoAMaoEm = 0;
    /** chave do callback → quando chegou */
    this.vistos = new Map();
  }

  limitar(valor) {
    return Math.min(this.cfg.maximo, Math.max(this.cfg.piso, Math.round(Number(valor))));
  }

  /** Retoma o ajuste gravado hoje (reinício no meio do dia). */
  carregar() {
    const salvo = this.repositorio?.carregar() || {};
    if (!salvo.data || salvo.data !== this.hoje()) return this;
    this.porLivre = this.limitar(Number(salvo.porLivre) || this.cfg.base);
    this.ultimaMudanca = Number(salvo.ultimaMudanca) || 0;
    this.ultimaQueda = Number(salvo.ultimaQueda) || -Infinity;
    this.ultimaSubida = Number(salvo.ultimaSubida) || -Infinity;
    this.callbacks = Number(salvo.callbacks) || 0;
    this.ultimoCallbackEm = Number(salvo.ultimoCallbackEm) || 0;
    this.ajustadoAMaoEm = Number(salvo.ajustadoAMaoEm) || 0;
    if (this.porLivre !== this.cfg.base) this.log.info(`Ajuste dos robôs retomado: ${this.porLivre} por livre (${this.callbacks} callback(s) hoje).`);
    return this;
  }

  salvar() {
    if (!this.repositorio) return;
    const finito = (v) => (Number.isFinite(v) ? v : null);
    const { porLivre, ultimaMudanca, callbacks, ultimoCallbackEm, ajustadoAMaoEm } = this;
    this.repositorio.salvar({
      data: this.hoje(), porLivre, ultimaMudanca, ultimaQueda: finito(this.ultimaQueda), ultimaSubida: finito(this.ultimaSubida),
      callbacks, ultimoCallbackEm, ajustadoAMaoEm,
    });
  }

  /** Robôs por livre agora; abaixo do .env, sobe 1 a cada `recuperarAposMs` sem callback. */
  atual(agora = Date.now()) {
    if (!this.cfg.automatico || this.porLivre >= this.cfg.base || agora - this.ultimaMudanca < this.cfg.recuperarAposMs) {
      return this.porLivre;
    }
    this.mudar(this.porLivre + 1, agora, `${Math.round(this.cfg.recuperarAposMs / 60_000)} min sem callback`);
    return this.porLivre;
  }

  /**
   * URA passiva: sobe um degrau (até o máximo), no máximo uma vez a cada `passivaMs`.
   * @param {number} agora
   * @param {string} situacao - para o log (ex.: "2 min sem derivação com 1 livre(s)")
   * @returns {boolean} true se subiu
   */
  subirPorPassividade(agora, situacao) {
    if (!this.cfg.automatico || this.porLivre >= this.cfg.maximo) return false;
    if (agora - this.ultimaSubida < this.cfg.passivaMs) return false;
    this.ultimaSubida = agora;
    this.mudar(this.limitar(this.porLivre + this.cfg.degrau), agora, `URA passiva (${situacao})`);
    return true;
  }

  /**
   * Ajuste manual (página /ura). O automático continua a partir daqui.
   * @returns {number} valor aplicado (limitado entre o piso e o máximo)
   */
  definir(valor, agora = Date.now()) {
    const novo = this.limitar(valor);
    this.ajustadoAMaoEm = agora;
    this.ultimaSubida = agora; // a passividade conta de novo a partir do ajuste
    this.mudar(novo, agora, 'Ajuste manual');
    return novo;
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
    if (!this.cfg.automatico) return this.anotar(`${descricao}. Ajuste automático desligado.`);
    this.ultimaMudanca = agora; // adia a recuperação
    if (this.porLivre <= this.cfg.piso) return this.anotar(`${descricao}. Já no mínimo de ${this.cfg.piso} robôs por livre.`);
    if (agora - this.ultimaQueda < this.cfg.intervaloMinMs) return this.anotar(`${descricao}. Já baixou há menos de ${Math.round(this.cfg.intervaloMinMs / 1000)} s.`);

    this.ultimaQueda = agora;
    this.mudar(this.limitar(this.porLivre - this.cfg.degrau), agora, descricao);
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

  /** Callback que não mudou o valor: registra (e grava a contagem). */
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
    const iso = (t) => (t > 0 && Number.isFinite(t) ? new Date(t).toISOString() : null);
    return {
      porLivre: this.atual(agora),
      base: this.cfg.base,
      piso: this.cfg.piso,
      maximo: this.cfg.maximo,
      degrau: this.cfg.degrau,
      automatico: this.cfg.automatico,
      callbacks: this.callbacks,
      ultimoCallback: iso(this.ultimoCallbackEm),
      ultimaSubida: iso(this.ultimaSubida),
      ajustadoAMao: iso(this.ajustadoAMaoEm),
    };
  }
}

module.exports = { AjusteRobos };

'use strict';
/**
 * Termômetro da URA: calma, normal ou agressiva, medido nos últimos minutos.
 *
 * A medida é quanto tempo de gente livre a URA gasta para cada derivação
 * (minutos-livres ÷ derivações). Com 2 livres por 10 min e 5 derivações, são
 * 4 min por derivação: a URA está calma. Só conta o tempo com robô ligado:
 * robô desligado não diz nada sobre a URA (claro que ninguém recebe ligação).
 *
 * Calma, o pânico age como na "URA passiva hoje" (com 1 fixo livre, os robôs
 * seguem). Callback na janela = agressiva, na hora.
 */

const Estado = Object.freeze({ MEDINDO: 'medindo', CALMA: 'calma', NORMAL: 'normal', AGRESSIVA: 'agressiva' });

/** Entre dois ciclos, no máximo isto conta (o rodízio pode ter ficado parado). */
const MAX_INTERVALO_MS = 30_000;
/** Derivação logo depois de desligar os robôs ainda é deles (ligação que já estava no ar). */
const DERIVACAO_APOS_ROBOS_MS = 60_000;

class TermometroUra {
  /**
   * @param {object} deps
   * @param {{ janelaMs: number, calmaMs: number, agressivaMs: number, minObservadoMs: number }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ cfg, logger }) {
    Object.assign(this, { cfg, log: logger });
    /** { ts, dt, livres } de cada ciclo com robô ligado */
    this.amostras = [];
    this.derivacoes = [];
    this.callbacks = [];
    this.ultimaAmostraEm = null;
    this.robosLigadosEm = -Infinity;
    this.estado = Estado.MEDINDO;
    this.desde = null;
  }

  /** Um ciclo da URA: quantos livres e quantos robôs ligados agora. @returns {string} o estado */
  amostrar(agora, { livres, robosLigados }) {
    const dt = this.ultimaAmostraEm == null ? 0 : Math.min(Math.max(agora - this.ultimaAmostraEm, 0), MAX_INTERVALO_MS);
    this.ultimaAmostraEm = agora;
    if (robosLigados > 0) {
      this.robosLigadosEm = agora;
      if (dt > 0) this.amostras.push({ ts: agora, dt, livres: Math.max(0, livres || 0) });
    }
    return this.reavaliar(agora);
  }

  /** Alguém da URA começou a atender (derivação de robô). */
  registrarDerivacao(agora) {
    if (agora - this.robosLigadosEm <= DERIVACAO_APOS_ROBOS_MS) this.derivacoes.push(agora);
  }

  /** Cliente desistiu da fila: a URA está agressiva agora. */
  registrarCallback(ts, agora = Date.now()) {
    this.callbacks.push(Math.min(ts ?? agora, agora));
    this.reavaliar(agora);
  }

  podar(agora) {
    const limite = agora - this.cfg.janelaMs;
    while (this.amostras.length && this.amostras[0].ts < limite) this.amostras.shift();
    while (this.derivacoes.length && this.derivacoes[0] < limite) this.derivacoes.shift();
    while (this.callbacks.length && this.callbacks[0] < limite) this.callbacks.shift();
  }

  /** @returns {{ observadoMs: number, livreMs: number, derivacoes: number, porDerivacaoMs: number|null }} */
  medida(agora) {
    this.podar(agora);
    const observadoMs = this.amostras.reduce((s, a) => s + a.dt, 0);
    const livreMs = this.amostras.reduce((s, a) => s + a.dt * a.livres, 0);
    const derivacoes = this.derivacoes.length;
    // Sem derivação: com gente livre esperando, é "infinito" (calma); sem ninguém livre, não há medida.
    const porDerivacaoMs = derivacoes ? livreMs / derivacoes : livreMs > 0 ? Infinity : null;
    return { observadoMs, livreMs, derivacoes, porDerivacaoMs };
  }

  classificar(agora) {
    const { observadoMs, porDerivacaoMs } = this.medida(agora);
    if (this.callbacks.length) return Estado.AGRESSIVA;
    if (observadoMs < this.cfg.minObservadoMs || porDerivacaoMs == null) return Estado.MEDINDO;
    // Histerese: já calma, só sai quando cair bem abaixo do limite (não fica piscando).
    const limiteCalma = this.estado === Estado.CALMA ? this.cfg.calmaMs * (2 / 3) : this.cfg.calmaMs;
    if (porDerivacaoMs >= limiteCalma) return Estado.CALMA;
    if (porDerivacaoMs < this.cfg.agressivaMs) return Estado.AGRESSIVA;
    return Estado.NORMAL;
  }

  reavaliar(agora) {
    const novo = this.classificar(agora);
    if (novo === this.estado) return novo;
    const anterior = this.estado;
    this.estado = novo;
    this.desde = agora;
    if (novo !== Estado.MEDINDO) this.log.info(`Termômetro da URA: ${anterior} → ${novo} (${this.descrever(agora)}).`);
    return novo;
  }

  calma() {
    return this.estado === Estado.CALMA;
  }

  descrever(agora) {
    const { derivacoes, porDerivacaoMs } = this.medida(agora);
    const janela = Math.round(this.cfg.janelaMs / 60_000);
    if (this.callbacks.length) return `callback nos últimos ${janela} min`;
    if (porDerivacaoMs === Infinity) return `nenhuma derivação em ${janela} min com gente livre`;
    return `${(porDerivacaoMs / 60_000).toFixed(1).replace('.', ',')} min livres por derivação, ${derivacoes} derivação(ões) em ${janela} min`;
  }

  resumo(agora = Date.now()) {
    const { observadoMs, derivacoes, porDerivacaoMs } = this.medida(agora);
    return {
      estado: this.estado,
      desde: this.desde ? new Date(this.desde).toISOString() : null,
      // null = sem medida; -1 = nenhuma derivação com gente livre (JSON não tem infinito)
      minutosPorDerivacao: porDerivacaoMs == null ? null : porDerivacaoMs === Infinity ? -1 : Math.round(porDerivacaoMs / 6_000) / 10,
      derivacoes,
      callbacks: this.callbacks.length,
      observadoMin: Math.round(observadoMs / 6_000) / 10,
      janelaMin: Math.round(this.cfg.janelaMs / 60_000),
      calmaMin: this.cfg.calmaMs / 60_000,
      agressivaSeg: Math.round(this.cfg.agressivaMs / 1000),
      minObservadoMin: this.cfg.minObservadoMs / 60_000,
    };
  }
}

module.exports = { TermometroUra, Estado };

'use strict';
/**
 * Relatório do dia da URA (painel): quanto tempo houve gente livre, quantas
 * derivações, quanto tempo com gente livre e nenhum robô ligado (a ociosidade
 * que o pânico causa), tempo em pânico e em cada estado do termômetro, leads
 * derivados e transbordos (webhooks 4 e 5 da Argus) e pausas por tipo. Tudo
 * também por hora. Gravado em arquivo: um reinício no mesmo dia continua; na
 * virada do dia começa do zero.
 */

const { dataLocal, horaLocal } = require('../utils/datas');

/** Entre dois ciclos, no máximo isto conta (o rodízio pode ter ficado parado). */
const MAX_INTERVALO_MS = 30_000;
const TIPOS_PANICO = ['zero', 'saindo', 'fixo'];
const ESTADOS_TERMOMETRO = ['medindo', 'calma', 'normal', 'agressiva'];

const zerados = (chaves) => Object.fromEntries(chaves.map((k) => [k, 0]));
const hora = () => ({ livresMs: 0, derivacoes: 0, ociosoSemRobosMs: 0, panicoMs: 0, calmaMs: 0, agressivaMs: 0, leadsDerivados: 0, transbordos: 0 });
const diaNovo = (dia) => ({
  dia,
  livresMs: 0,
  derivacoes: 0,
  ociosoSemRobosMs: 0,
  panicoMs: zerados(TIPOS_PANICO),
  panicoVezes: zerados(TIPOS_PANICO),
  termometroMs: zerados(ESTADOS_TERMOMETRO),
  // [NOVO] ligações da URA: para um humano (lead derivado) ou não (transbordo, por motivo)
  leadsDerivados: 0,
  transbordos: 0,
  transbordosPorMotivo: {},
  filaSegSoma: 0,
  filaQtd: 0,
  // [NOVO] tempo em pausa dos humanos da URA, por tipo (descricaoPausa da Argus)
  pausasMs: {},
  horas: {},
});

const minutos = (ms) => Math.round(ms / 6_000) / 10;

class EstatisticasDia {
  /**
   * @param {object} deps
   * @param {import('../utils/persistencia-json').ArquivoDeEstado} [deps.repositorio]
   * @param {string} deps.fusoHorario
   * @param {number} [deps.gravarACadaMs]
   */
  constructor({ repositorio = null, fusoHorario, gravarACadaMs = 60_000 }) {
    Object.assign(this, { repositorio, fusoHorario, gravarACadaMs });
    this.estado = diaNovo(dataLocal(fusoHorario));
    this.ultimaAmostraEm = null;
    this.gravadoEm = 0;
    /** Ligações já contadas hoje (a Argus pode reenviar o mesmo webhook). */
    this.contadas = new Set();
  }

  carregar(agora = Date.now()) {
    const salvo = this.repositorio?.carregar();
    if (salvo?.dia === dataLocal(this.fusoHorario, new Date(agora))) this.estado = { ...diaNovo(salvo.dia), ...salvo };
    return this;
  }

  /** Começa o dia novo se virou. @returns {object} as horas do dia, para acumular */
  doDia(agora) {
    const dia = dataLocal(this.fusoHorario, new Date(agora));
    if (dia !== this.estado.dia) {
      this.estado = diaNovo(dia);
      this.ultimaAmostraEm = null;
      this.contadas.clear();
    }
    const h = horaLocal(this.fusoHorario, new Date(agora)).slice(0, 2);
    this.estado.horas[h] ??= hora();
    return this.estado.horas[h];
  }

  /**
   * Um ciclo da URA.
   * @param {number} agora
   * @param {{ livres: number|null, robosLigados: number|null, panico: string|null, termometro: string|null, pausas?: string[] }} s
   *        pausas: o tipo da pausa de cada humano da URA em pausa agora
   */
  amostrar(agora, { livres, robosLigados, panico, termometro, pausas = [] }) {
    const h = this.doDia(agora); // virou o dia: zera, e o intervalo até a última amostra não conta
    const dt = this.ultimaAmostraEm == null ? 0 : Math.min(Math.max(agora - this.ultimaAmostraEm, 0), MAX_INTERVALO_MS);
    this.ultimaAmostraEm = agora;
    if (dt > 0) {
      const e = this.estado;
      const comLivres = livres > 0;
      e.livresMs += dt * (livres || 0);
      h.livresMs += dt * (livres || 0);
      if (comLivres && robosLigados === 0) {
        e.ociosoSemRobosMs += dt;
        h.ociosoSemRobosMs += dt;
      }
      if (panico && panico in e.panicoMs) {
        e.panicoMs[panico] += dt;
        h.panicoMs += dt;
      }
      if (termometro && termometro in e.termometroMs) e.termometroMs[termometro] += dt;
      if (termometro === 'calma') h.calmaMs += dt;
      if (termometro === 'agressiva') h.agressivaMs += dt;
      for (const tipo of pausas) e.pausasMs[tipo] = (e.pausasMs[tipo] ?? 0) + dt;
    }
    if (agora - this.gravadoEm >= this.gravarACadaMs) this.gravar(agora);
  }

  registrarDerivacao(agora) {
    this.doDia(agora).derivacoes += 1;
    this.estado.derivacoes += 1;
  }

  /**
   * [NOVO] Uma ligação da URA terminou (webhook 4 ou 5): lead derivado ou transbordo.
   * @param {{ chave: string|null, derivou: boolean, motivo: string, filaSeg: number|null }} encerramento
   * @returns {boolean} false se já tinha sido contada
   */
  registrarEncerramento(agora, { chave, derivou, motivo, filaSeg }) {
    const h = this.doDia(agora);
    if (chave && this.contadas.has(chave)) return false;
    if (chave) this.contadas.add(chave);
    const e = this.estado;
    if (derivou) {
      e.leadsDerivados += 1;
      h.leadsDerivados += 1;
    } else {
      e.transbordos += 1;
      h.transbordos += 1;
      e.transbordosPorMotivo[motivo] = (e.transbordosPorMotivo[motivo] ?? 0) + 1;
    }
    if (filaSeg != null) {
      e.filaSegSoma += filaSeg;
      e.filaQtd += 1;
    }
    return true;
  }

  /** O pânico começou (ou trocou de motivo) agora. */
  registrarPanico(tipo, agora) {
    this.doDia(agora);
    if (tipo in this.estado.panicoVezes) this.estado.panicoVezes[tipo] += 1;
  }

  gravar(agora = Date.now()) {
    this.gravadoEm = agora;
    return this.repositorio?.salvar(this.estado);
  }

  /** Para o /health e o painel. Minutos com uma casa decimal. */
  resumo() {
    const e = this.estado;
    const porDerivacao = (livresMs, derivacoes) => (derivacoes ? Math.round(livresMs / derivacoes / 1000) : null);
    const mapa = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, minutos(v)]));
    return {
      dia: e.dia,
      livresMin: minutos(e.livresMs),
      derivacoes: e.derivacoes,
      esperaPorDerivacaoSeg: porDerivacao(e.livresMs, e.derivacoes),
      ociosoSemRobosMin: minutos(e.ociosoSemRobosMs),
      panicoMin: mapa(e.panicoMs),
      panicoVezes: { ...e.panicoVezes },
      termometroMin: mapa(e.termometroMs),
      leadsDerivados: e.leadsDerivados,
      transbordos: e.transbordos,
      transbordosPorMotivo: { ...e.transbordosPorMotivo },
      filaMediaSeg: e.filaQtd ? Math.round(e.filaSegSoma / e.filaQtd) : null,
      pausasMin: mapa(e.pausasMs),
      horas: Object.entries(e.horas).sort(([a], [b]) => a.localeCompare(b)).map(([h, v]) => ({
        hora: h,
        livresMin: minutos(v.livresMs),
        derivacoes: v.derivacoes,
        esperaPorDerivacaoSeg: porDerivacao(v.livresMs, v.derivacoes),
        ociosoSemRobosMin: minutos(v.ociosoSemRobosMs),
        panicoMin: minutos(v.panicoMs),
        calmaMin: minutos(v.calmaMs),
        agressivaMin: minutos(v.agressivaMs),
        leadsDerivados: v.leadsDerivados ?? 0,
        transbordos: v.transbordos ?? 0,
      })),
    };
  }
}

module.exports = { EstatisticasDia };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TermometroUra } = require('../../src/rodizio/termometro-ura');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;
const cfg = { janelaMs: 15 * MIN, calmaMs: 3 * MIN, agressivaMs: 45_000, minObservadoMs: 5 * MIN };

function novo() {
  const logs = [];
  const t = new TermometroUra({ cfg, logger: { ...loggerNulo, info: (m) => logs.push(m) } });
  return { t, logs };
}

/** `minutos` de ciclos de 5 s com `livres` e `robos`; uma derivação a cada `aCadaS` segundos. */
function rodar(t, inicio, minutos, { livres = 2, robos = 5, aCadaS = 0 } = {}) {
  let agora = inicio;
  for (let s = 5; s <= minutos * 60; s += 5) {
    agora = inicio + s * 1000;
    if (aCadaS && s % aCadaS === 0) t.registrarDerivacao(agora);
    t.amostrar(agora, { livres, robosLigados: robos });
  }
  return agora;
}

test('termômetro: medindo até 5 min com robô ligado; o tempo sem robô não conta', () => {
  const { t } = novo();
  let agora = rodar(t, 0, 10, { robos: 0 });
  assert.equal(t.estado, 'medindo', 'robôs desligados não medem a URA');
  agora = rodar(t, agora, 4, { aCadaS: 30 });
  assert.equal(t.estado, 'medindo');
  rodar(t, agora, 2, { aCadaS: 30 });
  assert.notEqual(t.estado, 'medindo');
});

test('termômetro: 2 livres e 1 derivação a cada 2 min = 4 min por derivação: calma (e loga a troca)', () => {
  const { t, logs } = novo();
  rodar(t, 0, 10, { aCadaS: 120 });
  assert.equal(t.estado, 'calma');
  assert.ok(t.calma());
  assert.match(logs.at(-1), /^Termômetro da URA: medindo → calma \(\d+,\d min livres por derivação/);
  assert.equal(t.resumo(10 * MIN).minutosPorDerivacao, 4);
});

test('termômetro: derivação a cada 30 s com 1 livre = agressiva; a cada 90 s = normal', () => {
  const a = novo().t;
  rodar(a, 0, 10, { livres: 1, aCadaS: 30 });
  assert.equal(a.estado, 'agressiva');
  const n = novo().t;
  rodar(n, 0, 10, { livres: 1, aCadaS: 90 });
  assert.equal(n.estado, 'normal');
});

test('termômetro: sem nenhuma derivação com gente livre esperando = calma', () => {
  const { t } = novo();
  rodar(t, 0, 6);
  assert.equal(t.estado, 'calma');
  assert.equal(t.resumo(6 * MIN).minutosPorDerivacao, -1);
});

test('termômetro: callback na janela = agressiva na hora; sai dela quando o callback deixa a janela', () => {
  const { t } = novo();
  let agora = rodar(t, 0, 10, { aCadaS: 120 });
  t.registrarCallback(agora - 1000, agora);
  assert.equal(t.estado, 'agressiva');
  agora = rodar(t, agora, 14, { aCadaS: 120 });
  assert.equal(t.estado, 'agressiva');
  rodar(t, agora, 2, { aCadaS: 120 });
  assert.equal(t.estado, 'calma');
});

test('termômetro: histerese — já calma, só sai abaixo de 2 min por derivação', () => {
  const { t } = novo();
  let agora = rodar(t, 0, 15, { livres: 1, aCadaS: 240 });
  assert.equal(t.estado, 'calma');
  agora = rodar(t, agora, 15, { livres: 1, aCadaS: 150 }); // 2,5 min: entre 2 e 3
  assert.equal(t.estado, 'calma', 'não volta a normal com 2,5 min');
  rodar(t, agora, 15, { livres: 1, aCadaS: 90 });
  assert.equal(t.estado, 'normal');
});

test('termômetro: derivação muito depois de desligar os robôs não conta (não é dos robôs)', () => {
  const { t } = novo();
  rodar(t, 0, 6, { robos: 5 });
  t.amostrar(10 * MIN, { livres: 2, robosLigados: 0 });
  t.registrarDerivacao(10 * MIN);
  assert.equal(t.medida(10 * MIN).derivacoes, 0);
});

// ───────────── Relatório do dia ─────────────

const FUSO = 'America/Sao_Paulo';
const as = (hhmm) => new Date(`2026-10-21T${hhmm}:00-03:00`).getTime();

test('relatório do dia: acumula livres, ociosidade sem robô, pânico, termômetro e por hora', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO });
  let agora = as('09:00');
  e.amostrar(agora, { livres: 2, robosLigados: 5, panico: null, termometro: 'normal' });
  for (let i = 0; i < 12; i += 1) { // 1 min com 2 livres e robôs
    agora += 5000;
    e.amostrar(agora, { livres: 2, robosLigados: 5, panico: null, termometro: 'normal' });
  }
  e.registrarDerivacao(agora);
  e.registrarPanico('fixo', agora);
  for (let i = 0; i < 24; i += 1) { // 2 min com 1 livre e nenhum robô (pânico do fixo)
    agora += 5000;
    e.amostrar(agora, { livres: 1, robosLigados: 0, panico: 'fixo', termometro: 'calma' });
  }
  const r = e.resumo();
  assert.equal(r.dia, '2026-10-21');
  assert.equal(r.livresMin, 4);
  assert.equal(r.derivacoes, 1);
  assert.equal(r.esperaPorDerivacaoSeg, 240);
  assert.equal(r.ociosoSemRobosMin, 2);
  assert.deepEqual(r.panicoMin, { zero: 0, saindo: 0, fixo: 2 });
  assert.deepEqual(r.panicoVezes, { zero: 0, saindo: 0, fixo: 1 });
  assert.equal(r.termometroMin.calma, 2);
  assert.equal(r.termometroMin.normal, 1);
  assert.deepEqual(r.horas.map((h) => h.hora), ['09']);
  assert.equal(r.horas[0].ociosoSemRobosMin, 2);
});

test('relatório do dia: buraco entre ciclos conta no máximo 30 s; vira o dia e zera; grava e retoma', () => {
  let gravado = null;
  const repositorio = { carregar: () => gravado, salvar: (x) => { gravado = structuredClone(x); } };
  const e = new EstatisticasDia({ repositorio, fusoHorario: FUSO, gravarACadaMs: 0 });
  e.amostrar(as('10:00'), { livres: 1, robosLigados: 1 });
  e.amostrar(as('10:10'), { livres: 1, robosLigados: 1 });
  assert.equal(e.resumo().livresMin, 0.5);

  const outra = new EstatisticasDia({ repositorio, fusoHorario: FUSO }).carregar(as('11:00'));
  assert.equal(outra.resumo().livresMin, 0.5, 'reinício no mesmo dia continua');
  const amanha = new EstatisticasDia({ repositorio, fusoHorario: FUSO }).carregar(as('11:00') + 24 * 3600_000);
  assert.equal(amanha.resumo().livresMin, 0, 'outro dia começa do zero');

  e.amostrar(as('23:59'), { livres: 1, robosLigados: 1 });
  e.amostrar(as('23:59') + 120_000, { livres: 1, robosLigados: 1 });
  assert.equal(e.resumo().dia, '2026-10-22');
  assert.equal(e.resumo().livresMin, 0);
});

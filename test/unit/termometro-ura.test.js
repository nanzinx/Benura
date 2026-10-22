'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TermometroUra, estadoDaEspera } = require('../../src/rodizio/termometro-ura');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');
const LIMIARES = require('../../src/config/uraThresholds');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;

function novo() {
  const logs = [];
  const t = new TermometroUra({ logger: { ...loggerNulo, info: (m) => logs.push(m) } });
  return { t, logs };
}

test('termômetro: as faixas de uraThresholds (0–60 agressiva, 60–120 normal, ≥120 calma)', () => {
  assert.deepEqual([0, 59, 60, 119, 120, 600].map((s) => estadoDaEspera(s)), ['agressiva', 'agressiva', 'normal', 'normal', 'calma', 'calma']);
  assert.equal(LIMIARES.janelaMs, 5 * MIN);
});

test('termômetro: média das esperas dos últimos 5 min (atendimentos e quem está livre agora)', () => {
  const { t, logs } = novo();
  assert.equal(t.estado, 'medindo');
  t.registrarDerivacao(0, 30_000);
  t.registrarDerivacao(10_000, 50_000);
  assert.equal(t.amostrar(10_000), 'agressiva', 'média 40 s');
  assert.match(logs.at(-1), /^Termômetro da URA: medindo → agressiva \(livres esperando 40 s em média/);

  assert.equal(t.amostrar(20_000, { esperasEmCursoMs: [100_000] }), 'normal', '(30+50+100)/3 = 60 s');
  assert.equal(t.amostrar(30_000, { esperasEmCursoMs: [300_000, 280_000] }), 'calma', 'livres esperando muito');
  assert.equal(t.resumo(30_000).esperaSeg, 165);
});

test('termômetro: a espera sai da média depois de 5 min; sem dado, o estado fica como estava', () => {
  const { t } = novo();
  t.registrarDerivacao(0, 10_000);
  assert.equal(t.amostrar(1000), 'agressiva');
  assert.equal(t.amostrar(6 * MIN), 'agressiva', 'ninguém livre e nada na janela: fica como estava');
  assert.equal(t.resumo(6 * MIN).esperaSeg, null);
  assert.equal(t.amostrar(6 * MIN + 1000, { esperasEmCursoMs: [150_000] }), 'calma');
});

test('termômetro: callback nos últimos 5 min = agressiva, seja qual for a espera', () => {
  const { t } = novo();
  assert.equal(t.amostrar(0, { esperasEmCursoMs: [200_000] }), 'calma');
  t.registrarCallback(1000, 1000);
  assert.equal(t.estado, 'agressiva');
  assert.equal(t.amostrar(4 * MIN, { esperasEmCursoMs: [200_000] }), 'agressiva');
  assert.equal(t.amostrar(6 * MIN + 2000, { esperasEmCursoMs: [200_000] }), 'calma', 'o callback saiu da janela');
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

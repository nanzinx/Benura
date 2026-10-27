'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');

const FUSO = 'America/Sao_Paulo';
const em = (hora) => new Date(`2026-10-27T${hora}:00-03:00`).getTime();

test('[NOVO] TME: média do tempo livre de cada operador antes de cada ligação (dia e hora)', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO });
  e.registrarDerivacao(em('09:10'), '201', 60_000);
  e.registrarDerivacao(em('09:20'), '202', 120_000);
  e.registrarDerivacao(em('10:05'), '201', 30_000);
  e.registrarDerivacao(em('10:06'), '203', null); // sem o tempo livre: conta na OPL, não no TME
  const r = e.resumo();
  assert.equal(r.tmeSeg, 70, '(60 + 120 + 30) / 3');
  assert.deepEqual(r.horas.map((h) => [h.hora, h.tmeSeg, h.esperaQtd, h.esperaSomaSeg]), [['09', 90, 2, 180], ['10', 30, 1, 30]]);
  assert.equal(r.derivacoes, 4, 'a OPL continua dividindo por todas as ligações vistas');
});

test('[NOVO] TME: sem ligação com tempo livre conhecido, fica vazio', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO });
  assert.equal(e.resumo().tmeSeg, null);
});

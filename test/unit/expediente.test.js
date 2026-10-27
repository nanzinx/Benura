'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');

const FUSO = 'America/Sao_Paulo';
const em = (hora) => new Date(`2026-10-27T${hora}:00-03:00`).getTime();
const panico = { livres: 0, robosLigados: 0, panico: 'zero', termometro: 'normal' };

/** Amostras a cada 10 s por `minutos` a partir de `hora`. */
function amostrarPor(e, hora, minutos, dados) {
  for (let t = em(hora); t <= em(hora) + minutos * 60_000; t += 10_000) e.amostrar(t, dados);
}

test('[NOVO] expediente: fora das 08:00–18:00 a amostra não soma (TPA, TOR, termômetro)', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: { inicio: '08:00', fim: '18:00' } });
  amostrarPor(e, '03:00', 10, panico);
  let r = e.resumo();
  assert.deepEqual([r.panicoMin.zero, r.termometroMin.normal], [0, 0], 'a madrugada não conta');
  amostrarPor(e, '09:00', 10, panico);
  r = e.resumo();
  // 10 min de amostras (+ até 30 s da lacuna antes delas, regra de sempre: a lacuna caiu no expediente)
  assert.ok(r.panicoMin.zero >= 10 && r.panicoMin.zero <= 10.5, `no expediente conta (${r.panicoMin.zero})`);
  const antes = r.panicoMin.zero;
  amostrarPor(e, '18:00', 10, panico);
  assert.equal(e.resumo().panicoMin.zero, antes, 'depois das 18:00 não conta');
});

test('[NOVO] expediente: a primeira amostra das 08:00 não junta a noite', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: { inicio: '08:00', fim: '18:00' } });
  e.amostrar(em('07:59'), panico);
  e.amostrar(em('08:00') + 5000, panico);
  assert.ok(e.resumo().panicoMin.zero < 0.2);
});

test('[NOVO] expediente: o relatório só traz as horas das 08h às 17h', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: { inicio: '08:00', fim: '18:00' } });
  for (const h of ['03', '08', '17', '18']) e.registrarEncerramento(em(`${h}:30`), { chave: h, derivou: true, motivo: 'derivou', filaSeg: null });
  assert.deepEqual(e.resumo().horas.map((x) => x.hora), ['08', '17']);
  assert.equal(e.resumo().leadsDerivados, 4, 'o total de leads do dia continua o dia todo');
});

test('[NOVO] expediente: sem horário, conta o dia todo (como antes)', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO });
  amostrarPor(e, '03:00', 10, panico);
  assert.equal(e.resumo().panicoMin.zero, 10);
  assert.deepEqual(e.resumo().horas.map((x) => x.hora), ['03']);
});

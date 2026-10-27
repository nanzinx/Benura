'use strict';
/** [NOVO] Texto do resumo das 18:00 (o mesmo relatório do painel). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { textoDoResumo, duracao, minutos } = require('../../src/notificacoes/resumo-do-dia');

const hora = (h, x) => ({ hora: h, livresMin: 0, derivacoes: 0, esperaSomaSeg: 0, esperaQtd: 0, ociosoSemRobosMin: 0, panicoMin: 0, calmaMin: 0, ...x });
const relatorio = {
  dia: '2026-10-27', leadsDerivados: 88, transbordos: 4, panicoVezes: { zero: 3, saindo: 1, fixo: 1 },
  horas: [
    hora('08', { livresMin: 60, derivacoes: 30, esperaSomaSeg: 1800, esperaQtd: 30, ociosoSemRobosMin: 4, panicoMin: 6 }),
    hora('09', { livresMin: 30, derivacoes: 10, esperaSomaSeg: 1800, esperaQtd: 10, ociosoSemRobosMin: 2, panicoMin: 3 }),
  ],
  comparacao: {
    anterior: { dia: '2026-10-26', transbordos: 6, leadsDerivados: 190, torMin: 12, tpaMin: 20, tmeSeg: 90, oplSeg: 137 },
    semana: { dias: 5, transbordos: 5, leadsDerivados: 175, torMin: 9.4, tpaMin: 17, tmeSeg: 98, oplSeg: 140 },
  },
};

test('resumo: os números dos quadros, com o dia anterior e a semana', () => {
  const t = textoDoResumo(relatorio);
  assert.match(t, /^Resumo de ter 27\/10/);
  assert.match(t, /Transbordos: 4 \(seg 26\/10: 6 · 7 dias: 5\)/);
  assert.match(t, /Leads derivados: 88 \(seg 26\/10: 190 · 7 dias: 175\)/);
  assert.match(t, /TME: 1 min 30 s/, 'soma das esperas ÷ ligações: 3600 / 40');
  assert.match(t, /OPL: 2 min 15 s/, '90 min livres × 60 / 40');
  assert.match(t, /TOR: 6 min/);
  assert.match(t, /TPA: 9 min \(5 vezes\)/);
});

test('resumo: sem comparação e sem ligações, não quebra', () => {
  const t = textoDoResumo({ dia: '2026-10-27', horas: [], panicoVezes: { zero: 0, saindo: 0, fixo: 0 } });
  assert.match(t, /Transbordos: 0$/m);
  assert.match(t, /TME: –/);
});

test('formatos como no painel', () => {
  assert.deepEqual([duracao(45), duracao(185), duracao(null), minutos(65), minutos(12.4)], ['45 s', '3 min 05 s', '–', '1 h 05 min', '12 min']);
});

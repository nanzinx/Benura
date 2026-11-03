'use strict';
/** [NOVO] Feriados nacionais (de lei, Carnaval e Corpus Christi) e dias úteis. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pascoa, feriados, feriadoEm, diaUtil, ultimoDiaUtilAntes, lerFeriadosExtras } = require('../../src/domain/calendario');

test('Páscoa e os feriados móveis', () => {
  assert.equal(pascoa(2026), '2026-04-05');
  assert.equal(pascoa(2027), '2027-03-28');
  assert.equal(pascoa(2025), '2025-04-20');
  const f2026 = feriados(2026);
  assert.equal(f2026.get('2026-04-03'), 'Sexta-feira Santa');
  assert.equal(f2026.get('2026-02-16'), 'Carnaval');
  assert.equal(f2026.get('2026-02-17'), 'Carnaval');
  assert.equal(f2026.get('2026-06-04'), 'Corpus Christi');
  assert.equal(feriados(2027).get('2027-03-26'), 'Sexta-feira Santa');
});

test('os fixos de lei, inclusive Finados e a Consciência Negra', () => {
  const f = feriados(2026);
  for (const [dia, nome] of [['01-01', 'Confraternização Universal'], ['04-21', 'Tiradentes'], ['05-01', 'Dia do Trabalho'], ['09-07', 'Independência'],
    ['10-12', 'Nossa Senhora Aparecida'], ['11-02', 'Finados'], ['11-15', 'Proclamação da República'], ['11-20', 'Consciência Negra'], ['12-25', 'Natal']]) {
    assert.equal(f.get(`2026-${dia}`), nome, dia);
  }
});

test('dia útil: segunda a sexta fora dos feriados; o último dia útil antes de hoje', () => {
  assert.equal(diaUtil('2026-11-02'), false, 'Finados (segunda)');
  assert.equal(diaUtil('2026-10-31'), false, 'sábado');
  assert.equal(diaUtil('2026-11-03'), true);
  assert.equal(ultimoDiaUtilAntes('2026-11-03'), '2026-10-30', 'pula Finados e o fim de semana');
  assert.equal(ultimoDiaUtilAntes('2026-11-04'), '2026-11-03');
  assert.equal(ultimoDiaUtilAntes('2026-02-18'), '2026-02-13', 'depois do Carnaval');
  assert.equal(feriadoEm('2026-11-02'), 'Finados');
  assert.equal(feriadoEm('2026-11-03'), null);
});

test('FERIADOS_EXTRAS: AAAA-MM-DD (um dia) ou DD/MM (todo ano); lixo ignorado', () => {
  const extras = lerFeriadosExtras('2026-11-30, 25/01, lixo, 31/02');
  assert.equal(diaUtil('2026-11-30', extras), false);
  assert.equal(diaUtil('2027-01-25', extras), false, 'DD/MM vale todo ano');
  assert.equal(diaUtil('2027-11-30', extras), true, 'AAAA-MM-DD só naquele ano');
  assert.equal(feriadoEm('2026-11-30', extras), 'Feriado (FERIADOS_EXTRAS)');
  assert.equal(ultimoDiaUtilAntes('2026-12-01', extras), '2026-11-27');
});

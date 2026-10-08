'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paraNumero, formatarReais } = require('../../src/utils/moeda');
const { dataLocal, horaLocal, dentroDoIntervalo } = require('../../src/utils/datas');

test('paraNumero aceita número, string US e string BR', () => {
  assert.equal(paraNumero(12500), 12500);
  assert.equal(paraNumero('12500.50'), 12500.5);
  assert.equal(paraNumero('12.500,50'), 12500.5);
  assert.equal(paraNumero('R$ 1.234,56'), 1234.56);
  assert.equal(paraNumero(null), 0);
  assert.equal(paraNumero('abc'), 0);
  assert.equal(paraNumero(NaN), 0);
});

test('formatarReais usa padrão brasileiro', () => {
  assert.match(formatarReais(50000), /R\$\s50\.000,00/);
});

test('dataLocal respeita o fuso (23h em SP ainda é o mesmo dia)', () => {
  const instante = new Date('2026-10-09T02:30:00Z'); // 23:30 de 08/10 em SP
  assert.equal(dataLocal('America/Sao_Paulo', instante), '2026-10-08');
  assert.equal(horaLocal('America/Sao_Paulo', instante), '23:30');
  assert.equal(dataLocal('UTC', instante), '2026-10-09');
});

test('dentroDoIntervalo é inclusivo', () => {
  assert.ok(dentroDoIntervalo('08:00', '08:00', '18:00'));
  assert.ok(dentroDoIntervalo('18:00', '08:00', '18:00'));
  assert.ok(!dentroDoIntervalo('18:01', '08:00', '18:00'));
});

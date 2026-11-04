'use strict';
/** [NOVO] Mapa de risco dos robôs: livres × robôs ligados (e o status da URA) → leads e callbacks. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { faixaDeLivres, faixaDeRobos, chave, anotar, somarMapas, celulas, FAIXAS_LIVRES, FAIXAS_ROBOS } = require('../../src/domain/mapa-risco');

test('faixas: livres 0, 1, 2, 3, 4+; robôs 0, 1-10, 11-20, 21-30, 31-40, 41+; sem dado = null', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(faixaDeLivres), ['0', '1', '2', '3', '4+', '4+']);
  assert.deepEqual([0, 1, 10, 11, 20, 21, 30, 31, 40, 41, 58].map(faixaDeRobos), ['0', '1-10', '1-10', '11-20', '11-20', '21-30', '21-30', '31-40', '31-40', '41+', '41+']);
  assert.equal(faixaDeRobos(null), null);
  assert.equal(faixaDeLivres(undefined), null);
  assert.deepEqual(FAIXAS_LIVRES, ['0', '1', '2', '3', '4+']);
  assert.deepEqual(FAIXAS_ROBOS, ['0', '1-10', '11-20', '21-30', '31-40', '41+']);
  assert.equal(chave({ livres: 1, robos: 14, status: 'calma' }), '1|11-20|calma');
  assert.equal(chave({ livres: 1, robos: 14, status: null }), '1|11-20|medindo', 'sem status: medindo');
  assert.equal(chave({ livres: 1, robos: null, status: 'calma' }), null, 'sem robôs: não entra');
});

test('anotar: lead conta como lead; callback com livre é invisível; com 0 livres é de fila', () => {
  const mapa = {};
  anotar(mapa, { livres: 2, robos: 20, status: 'normal' }, { derivou: true });
  anotar(mapa, { livres: 2, robos: 20, status: 'normal' }, { derivou: true });
  anotar(mapa, { livres: 1, robos: 40, status: 'calma' }, { derivou: false });
  anotar(mapa, { livres: 0, robos: 40, status: 'calma' }, { derivou: false });
  assert.deepEqual(mapa, {
    '2|11-20|normal': { leads: 2, fila: 0, invisiveis: 0 },
    '1|31-40|calma': { leads: 0, fila: 0, invisiveis: 1 },
    '0|31-40|calma': { leads: 0, fila: 1, invisiveis: 0 },
  });
  assert.equal(anotar(mapa, null, { derivou: true }), false, 'sem foto: não anota');
});

test('somar e células: por status ou todos; taxa = fila / (leads + fila); pouca amostra abaixo de 50', () => {
  const dia1 = { '1|31-40|calma': { leads: 120, fila: 2, invisiveis: 1 }, '3|41+|normal': { leads: 30, fila: 0, invisiveis: 0 } };
  const dia2 = { '1|31-40|calma': { leads: 78, fila: 0, invisiveis: 0 }, '1|31-40|agressiva': { leads: 10, fila: 1, invisiveis: 2 } };
  const total = somarMapas([dia1, dia2, undefined]);
  assert.deepEqual(total['1|31-40|calma'], { leads: 198, fila: 2, invisiveis: 1 });

  const todos = celulas(total);
  const c = todos.find((x) => x.livres === '1' && x.robos === '31-40');
  assert.deepEqual(c, { livres: '1', robos: '31-40', leads: 208, fila: 3, invisiveis: 3, taxaFila: 3 / 211, amostra: 'ok' });
  assert.equal(todos.length, FAIXAS_LIVRES.length * FAIXAS_ROBOS.length, 'a grade inteira, mesmo vazia');
  assert.deepEqual(todos.find((x) => x.livres === '0' && x.robos === '0'), { livres: '0', robos: '0', leads: 0, fila: 0, invisiveis: 0, taxaFila: null, amostra: 'vazia' });

  const calma = celulas(total, { status: 'calma' }).find((x) => x.livres === '1' && x.robos === '31-40');
  assert.deepEqual([calma.leads, calma.fila], [198, 2]);
  assert.equal(celulas(total, { status: 'normal' }).find((x) => x.livres === '3' && x.robos === '41+').amostra, 'pouca', '30 ligações');
});

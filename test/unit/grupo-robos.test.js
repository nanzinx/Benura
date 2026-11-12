'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { GrupoRobos } = require('../../src/rodizio/grupo-robos');

const loggerMock = {
  info: () => {},
  aviso: () => {},
  erro: () => {},
  debug: () => {},
};

test('GrupoRobos: inicia com grupoId null quando sem arquivo salvo', () => {
  const gr = new GrupoRobos({ arquivo: null, logger: loggerMock });
  gr.carregar();
  assert.equal(gr.grupoId, null);
  assert.deepEqual(gr.resumo(), { grupoId: null, desde: null, por: null, escolhido: false });
});

test('GrupoRobos: salva grupoId numérico e recarrega do arquivo', async () => {
  const tmp = path.join(os.tmpdir(), `grupo-robos-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const gr1 = new GrupoRobos({ arquivo: tmp, logger: loggerMock });
    gr1.carregar();
    const r1 = gr1.definir(30, 'supervisor@teste.com');
    assert.equal(r1.mudou, true);
    assert.equal(r1.grupoId, 30);
    assert.equal(gr1.grupoId, 30);
    await gr1.aguardar();

    const gr2 = new GrupoRobos({ arquivo: tmp, logger: loggerMock });
    gr2.carregar();
    assert.equal(gr2.grupoId, 30);
    assert.equal(gr2.resumo().por, 'supervisor@teste.com');
    assert.equal(gr2.resumo().escolhido, true);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
});

test('GrupoRobos: definir grupoId igual não muda estado', () => {
  const gr = new GrupoRobos({ arquivo: null, logger: loggerMock });
  gr.definir(20, 'sup1');
  const r2 = gr.definir(20, 'sup2');
  assert.equal(r2.mudou, false);
  assert.equal(gr.grupoId, 20);
});

test('GrupoRobos: definir null, 0 ou "todos" volta ao automático (null)', () => {
  const gr = new GrupoRobos({ arquivo: null, logger: loggerMock });
  gr.definir(10, 'sup');
  assert.equal(gr.grupoId, 10);

  const r1 = gr.definir('todos', 'sup');
  assert.equal(r1.mudou, true);
  assert.equal(r1.grupoId, null);
  assert.equal(gr.grupoId, null);
  assert.equal(gr.resumo().escolhido, false);

  gr.definir(10, 'sup');
  const r2 = gr.definir(null, 'sup');
  assert.equal(r2.mudou, true);
  assert.equal(r2.grupoId, null);
});

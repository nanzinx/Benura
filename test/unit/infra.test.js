'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { requisitar, comRetry, HttpError } = require('../../src/utils/http-client');
const { EstadoRepository } = require('../../src/repositories/estado.repository');
const { criarServidor } = require('../../src/http/server');
const { loggerNulo } = require('../../src/utils/logger');

function subir(servidor) {
  return new Promise((r) => servidor.listen(0, () => r(`http://127.0.0.1:${servidor.address().port}`)));
}

test('comRetry repete em 5xx e não repete em 4xx', async (t) => {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.url === '/instavel' && hits < 3) { res.writeHead(503).end(); return; }
    if (req.url === '/proibido') { res.writeHead(401).end('{"erro":"x"}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  const base = await subir(srv);
  t.after(() => srv.close());

  assert.deepEqual(await comRetry(() => requisitar(`${base}/instavel`), { tentativas: 3, baseMs: 1 }), { ok: true });
  assert.equal(hits, 3);

  hits = 0;
  await assert.rejects(
    comRetry(() => requisitar(`${base}/proibido`), { tentativas: 3, baseMs: 1 }),
    (e) => e instanceof HttpError && e.status === 401 && e.corpo.erro === 'x',
  );
  assert.equal(hits, 1);
});

test('requisitar lança HttpError com timeout', async (t) => {
  const srv = http.createServer(() => {});
  const base = await subir(srv);
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  await assert.rejects(requisitar(base, { timeoutMs: 50 }), (e) => e.timeout === true && e.retentavel);
});

test('EstadoRepository salva, recarrega e migra formato legado', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estado-'));
  const arquivo = path.join(dir, 'state.json');
  const repo = new EstadoRepository({ arquivo, logger: loggerNulo });

  fs.writeFileSync(arquivo, JSON.stringify({
    data: '2026-10-08', vendedoresUra: ['1'], vendedoresAtivo: ['2'],
    historico: { 1: { nome: 'A', vendaOntem: 60000 }, 2: { nome: 'B' } },
  }));
  const migrado = repo.carregar();
  assert.equal(migrado.versao, 2);
  assert.equal(migrado.vendedores['1'].fila, 'URA');
  assert.equal(migrado.vendedores['2'].fila, 'ATIVO');

  await repo.salvar(migrado);
  fs.writeFileSync(arquivo, '{corrompido');
  assert.equal(repo.carregar().vendedores['1'].nome, 'A'); // recuperado do .bak
  fs.rmSync(dir, { recursive: true });
});

test('servidor HTTP: rotas, autenticação e erros', async (t) => {
  const controllers = {
    health: async () => ({ status: 200, corpo: { status: 'ok' } }),
    status: async () => ({ status: 200, corpo: {} }),
    recarregar: async () => ({ status: 202, corpo: {} }),
    webhookVenda: async ({ corpo }) => ({ status: 200, corpo }),
  };
  const srv = criarServidor({ controllers, cfg: { tokenAdmin: 'segredo', limiteCorpoBytes: 100 }, logger: loggerNulo });
  const base = await subir(srv);
  t.after(() => srv.close());

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/nada`)).status, 404);
  assert.equal((await fetch(`${base}/webhook/venda`, { method: 'POST', body: '{}' })).status, 401);

  const auth = { Authorization: 'Bearer segredo' };
  const ok = await fetch(`${base}/webhook/venda`, { method: 'POST', headers: auth, body: '{"ramal":"1"}' });
  assert.deepEqual(await ok.json(), { ramal: '1' });
  assert.equal((await fetch(`${base}/webhook/venda`, { method: 'POST', headers: auth, body: '{x' })).status, 400);
  const grande = await fetch(`${base}/webhook/venda`, { method: 'POST', headers: auth, body: 'x'.repeat(500) }).catch(() => null);
  assert.ok(grande === null || grande.status === 413);
});

'use strict';
/** [NOVO] Saúde da Argus: chamadas, erros, lentidão e pedidos de desacelerar (429) dos últimos 15 min. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { SaudeDaArgus } = require('../../src/integrations/argus/saude-argus');
const { ArgusClient } = require('../../src/integrations/argus/argus.client');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;

test('saúde: soma os últimos 15 min por minuto; o que é mais antigo sai', () => {
  const s = new SaudeDaArgus();
  const t0 = Date.UTC(2026, 10, 2, 12, 0, 0);
  s.registrar({ ms: 200, resultado: 'ok' }, t0);
  s.registrar({ ms: 4000, resultado: 'ok' }, t0 + 1000); // lenta (3 s ou mais)
  s.registrar({ ms: 100, resultado: 'erro', texto: 'tempo esgotado' }, t0 + 2 * MIN);
  s.registrar({ ms: 50, resultado: 'limite' }, t0 + 3 * MIN);
  s.registrar({ ms: 0, resultado: 'segurada' }, t0 + 3 * MIN);
  const r = s.resumo(t0 + 4 * MIN);
  assert.equal(r.janelaMin, 15);
  assert.equal(r.chamadas, 4, 'a segurada (não saiu por causa da pausa) não conta como chamada');
  assert.equal(r.erros, 1);
  assert.equal(r.limites, 1);
  assert.equal(r.seguradas, 1);
  assert.equal(r.lentas, 1);
  assert.equal(r.msMedio, Math.round((200 + 4000 + 100 + 50) / 4));
  assert.equal(r.ultimoErro.texto, 'tempo esgotado');
  assert.equal(r.ultimoLimiteEm, new Date(t0 + 3 * MIN).toISOString());
  const depois = s.resumo(t0 + 16 * MIN + 1000);
  assert.equal(depois.chamadas, 2, 'as dos primeiros minutos saíram da janela');
  assert.equal(s.resumo(t0 + 60 * MIN).chamadas, 0);
});

test('ArgusClient: cada chamada entra na saúde (ok, erro, 429 e a pausa)', async (t) => {
  let resposta = [200, { codStatus: 1, grupos: [] }];
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(resposta[0], { 'Content-Type': 'application/json' }).end(JSON.stringify(resposta[1])));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const client = new ArgusClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 't', timeoutMs: 5000, tentativas: 1, pausaLimiteMs: 60_000 }, loggerNulo);
  await client.listarGrupos();
  resposta = [500, {}];
  await assert.rejects(client.listarGrupos());
  resposta = [429, {}];
  await assert.rejects(client.listarGrupos());
  await assert.rejects(client.listarGrupos(), /pausa/); // em pausa: nem sai
  const r = client.saude.resumo();
  assert.deepEqual([r.chamadas, r.erros, r.limites, r.seguradas], [3, 1, 1, 1]);
  assert.ok(r.pausaAte, 'a pausa por limite aparece');
});

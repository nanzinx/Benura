'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const FUNCTION = pathToFileURL(path.join(__dirname, '..', '..', 'functions', 'api', '[[caminho]].js')).href;
const ENV = { PAINEL_PROXY_SEGREDO: 'segredo', CF_ACCESS_CLIENT_ID: 'id.access', CF_ACCESS_CLIENT_SECRET: 'secret.access' };

/** "Servidor do BenURA" de mentira: guarda o pedido e responde com cookie. */
async function servidorFalso() {
  const pedidos = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (d) => { corpo += d; });
    req.on('end', () => {
      pedidos.push({ metodo: req.method, url: req.url, headers: req.headers, corpo });
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'benura_painel=abc; HttpOnly; SameSite=Strict; Secure' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { servidor, pedidos, url: `http://127.0.0.1:${servidor.address().port}` };
}

test('Function do Pages: leva o /api ao servidor com o service token, o segredo e o IP de quem abriu', async (t) => {
  const { onRequest } = await import(FUNCTION);
  const { servidor, pedidos, url } = await servidorFalso();
  t.after(() => servidor.close());

  const request = new Request('https://benura.benconsig.com.br/api/rodizio/panico?x=1', {
    method: 'POST',
    headers: { Cookie: 'benura_painel=sessao', 'X-Painel': '1', Origin: 'https://benura.benconsig.com.br', 'CF-Connecting-IP': '200.1.2.3', 'X-Benura-Proxy': 'tentativa-do-navegador', 'Content-Type': 'application/json' },
    body: '{"a":1}',
  });
  const resposta = await onRequest({ request, env: { ...ENV, BENURA_API_URL: url } });

  assert.equal(resposta.status, 201);
  assert.match(resposta.headers.get('set-cookie'), /^benura_painel=abc/, 'o cookie da sessão volta para o navegador');
  const [p] = pedidos;
  assert.deepEqual([p.metodo, p.url, p.corpo], ['POST', '/api/rodizio/panico?x=1', '{"a":1}']);
  assert.equal(p.headers['x-benura-proxy'], 'segredo', 'o segredo é o do Pages, não o que o navegador mandou');
  assert.equal(p.headers['x-benura-cliente-ip'], '200.1.2.3');
  assert.deepEqual([p.headers['cf-access-client-id'], p.headers['cf-access-client-secret']], ['id.access', 'secret.access']);
  assert.deepEqual([p.headers.cookie, p.headers['x-painel'], p.headers.origin], ['benura_painel=sessao', '1', 'https://benura.benconsig.com.br']);
  assert.notEqual(p.headers.host, 'benura.benconsig.com.br', 'o host é o do servidor');
});

test('Function do Pages: GET sem corpo; servidor fora do ar = 502; sem configuração = 500', async (t) => {
  const { onRequest } = await import(FUNCTION);
  const { servidor, pedidos, url } = await servidorFalso();
  t.after(() => servidor.close());

  await onRequest({ request: new Request('https://benura.benconsig.com.br/api/visao'), env: { ...ENV, BENURA_API_URL: url } });
  assert.deepEqual([pedidos[0].metodo, pedidos[0].corpo], ['GET', '']);

  const fora = await onRequest({ request: new Request('https://benura.benconsig.com.br/api/visao'), env: { ...ENV, BENURA_API_URL: 'http://127.0.0.1:9' } });
  assert.equal(fora.status, 502);
  assert.match((await fora.json()).erro, /fora do ar/);

  const sem = await onRequest({ request: new Request('https://benura.benconsig.com.br/api/visao'), env: {} });
  assert.equal(sem.status, 500);
});

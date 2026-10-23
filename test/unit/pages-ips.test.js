'use strict';
/** [NOVO] Pages: só os IPs da empresa entram (functions/_middleware.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MIDDLEWARE = pathToFileURL(path.join(__dirname, '..', '..', 'functions', '_middleware.js')).href;
const LISTA = '2804:431:80f7:7700::/48, 2804:1b3:a5e7:c3c7::/48, 201.93.163.133, 2804:1b3:a5e7:2c83::/48, 201.93.159.169, 2804:1b3:a5e7:8e38::/48';

test('faixas de IP: IPv4 exato, IPv6 /48 dentro e fora, :: abreviado, IPv4 dentro do IPv6, lixo ignorado', async () => {
  const { lerLista, permitido, lerIp } = await import(MIDDLEWARE);
  const faixas = lerLista(`${LISTA}, lixo, 1.2.3.4/40, 10.0.0.0/8`);
  assert.equal(faixas.length, 7, 'as 6 da empresa + 10.0.0.0/8; lixo e prefixo impossível ficam de fora');
  for (const ip of ['201.93.163.133', '201.93.159.169', '2804:431:80f7:7700::1', '2804:431:80f7:ffff:1:2:3:4', '2804:1b3:a5e7:8e38:abcd::9', '::ffff:201.93.163.133', '10.20.30.40']) {
    assert.equal(permitido(ip, faixas), true, ip);
  }
  for (const ip of ['201.93.163.134', '8.8.8.8', '2804:431:80f8::1', '2804:1b3:a5e8::1', '2001:db8::1', '', 'lixo']) {
    assert.equal(permitido(ip, faixas), false, ip || '(vazio)');
  }
  assert.deepEqual(lerIp('::1'), { v: 6, n: 1n });
  assert.equal(lerIp('1::2::3'), null);
  assert.equal(lerIp('300.1.1.1'), null);
});

test('middleware: IP de fora → 403 com o IP; da empresa passa; /trava passa; sem a lista passa com aviso', async () => {
  const { onRequest } = await import(MIDDLEWARE);
  const pedir = (url, ip, env = { BENURA_IPS_PERMITIDOS: LISTA }) => onRequest({
    request: new Request(url, { headers: ip ? { 'CF-Connecting-IP': ip } : {} }),
    env,
    next: async () => new Response('painel', { status: 200 }),
  });
  const fora = await pedir('https://benura.benconsig.com.br/', '187.10.20.30');
  assert.equal(fora.status, 403);
  assert.equal(fora.headers.get('cache-control'), 'no-store');
  assert.match(await fora.text(), /Acesso só pela rede da Benconsig[\s\S]*187\.10\.20\.30/);
  assert.equal((await pedir('https://benura.benconsig.com.br/api/visao', '187.10.20.30')).status, 403, 'o /api também');
  assert.equal((await pedir('https://benura.benconsig.com.br/', '201.93.163.133')).status, 200);
  assert.equal((await pedir('https://benura.benconsig.com.br/api/visao', '2804:1b3:a5e7:c3c7:1::2')).status, 200);
  assert.equal((await pedir('https://benura.benconsig.com.br/trava/renovar', '187.10.20.30')).status, 200, 'a trava tem o próprio segredo');
  assert.equal((await pedir('https://benura.benconsig.com.br/', null)).status, 403, 'sem CF-Connecting-IP: bloqueia');
  const sem = await pedir('https://benura.benconsig.com.br/', '187.10.20.30', {});
  assert.equal(sem.status, 200);
  assert.match(sem.headers.get('x-benura-aviso'), /não configurado/);
  assert.match(await (await pedir('https://x/', '<script>', { BENURA_IPS_PERMITIDOS: LISTA })).text(), /&lt;script&gt;/, 'o IP vai escapado na página');
});

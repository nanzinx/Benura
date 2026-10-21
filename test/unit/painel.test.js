'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lerMudancaDeLivres, lerCallback, lerAviso, tokenRecusadoRecentemente, segundosDoDia } = require('../../src/domain/painel');
const { Sessoes } = require('../../src/painel/sessoes');
const { Servicos } = require('../../src/painel/servicos');
const { DadosDoDia } = require('../../src/painel/dados-do-dia');
const { criarServidorDoPainel } = require('../../src/painel/servidor');
const { loggerNulo } = require('../../src/utils/logger');

const SENHA = 'senha-da-supervisao';

test('painel: lê as linhas dos logs do dia (livres, callbacks, avisos)', () => {
  assert.deepEqual(lerMudancaDeLivres('08:42:18 [INFO] [rodizio] URA: livres 2→1 | humanos 5 | robôs ligados 10 (alvo 7) | livres: 2266423 (grupo 7)'),
    { hora: '08:42:18', livres: 1, humanos: 5, robos: 10 });
  assert.deepEqual(lerMudancaDeLivres('08:42:18 [INFO] [rodizio] URA: livres ?→3 | humanos 4 | robôs ligados ?'), { hora: '08:42:18', livres: 3, humanos: 4, robos: null });
  assert.equal(lerMudancaDeLivres('08:42:18 [INFO] [rodizio] outra coisa'), null);

  assert.deepEqual(lerCallback('09:46:20 [AVISO] [callbacks] CALLBACK 09:46:13 Oper Virtual 7, 12 s | sem livre útil na URA | às 09:46:15: livres nenhum | robôs 9/7'), {
    hora: '09:46:13', robo: 'Oper Virtual 7', duracaoSeg: 12, conclusao: 'sem livre útil na URA', detalhes: ['às 09:46:15: livres nenhum', 'robôs 9/7'],
  });
  assert.equal(lerCallback('09:46:20 [AVISO] [callbacks] CALLBACK 09:46:13, 3 s').robo, null);

  assert.deepEqual(lerAviso('10:30:11 [roteador] [ERRO] [carrossel] Carrossel fora do ar.'), { hora: '10:30:11', servico: 'roteador', nivel: 'ERRO', texto: 'Carrossel fora do ar.' });
  assert.equal(lerAviso('10:30:11 [rodizio] [AVISO]  sem escopo').texto, 'sem escopo');

  const avisos = [{ hora: '10:00:00', texto: 'Argus recusou o token em /statusoperador (HTTP 403).' }];
  assert.equal(tokenRecusadoRecentemente(avisos, segundosDoDia('10:05:00')), true);
  assert.equal(tokenRecusadoRecentemente(avisos, segundosDoDia('10:30:00')), false, 'mais de 15 min atrás');
});

test('painel: sessão só com a senha certa; sair invalida; 5 erros bloqueiam o endereço', () => {
  let agora = 1_000_000;
  const s = new Sessoes({ senha: SENHA, segredo: 'seg', horas: 12, agora: () => agora });
  assert.equal(s.entrar('errada', '1.1.1.1').ok, false);
  const r = s.entrar(SENHA, '1.1.1.1', { seguro: true });
  assert.equal(r.ok, true);
  assert.match(r.cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const req = { headers: { cookie: r.cookie.split(';')[0] } };
  assert.ok(s.validar(req));
  assert.equal(s.validar({ headers: { cookie: r.cookie.split(';')[0].replace(/.$/, 'x') } }), null, 'assinatura adulterada');
  assert.equal(new Sessoes({ senha: 'outra-senha-123', segredo: 'seg', horas: 12, agora: () => agora }).validar(req), null, 'trocar a senha derruba as sessões');
  s.sair(req);
  assert.equal(s.validar(req), null, 'saiu');

  const b = s.entrar(SENHA, '2.2.2.2');
  agora += 13 * 3_600_000;
  assert.equal(s.validar({ headers: { cookie: b.cookie.split(';')[0] } }), null, 'venceu');

  for (let i = 0; i < 5; i++) s.entrar('errada', '3.3.3.3');
  assert.deepEqual(s.entrar(SENHA, '3.3.3.3'), { ok: false, bloqueado: true }, 'bloqueado mesmo com a senha certa');
  assert.equal(s.entrar(SENHA, '4.4.4.4').ok, true, 'outro endereço entra');
  assert.equal(new Sessoes({ senha: '', segredo: 'seg', horas: 12 }).entrar('', 'x').ok, false, 'sem PAINEL_SENHA ninguém entra');
});

test('painel: lê os logs do dia aos poucos e recomeça na virada do dia', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-'));
  let agora = new Date('2026-10-20T15:00:00Z');
  const dir = (dia) => { fs.mkdirSync(path.join(pasta, dia), { recursive: true }); return path.join(pasta, dia); };
  const d = new DadosDoDia({ pasta, fuso: 'America/Sao_Paulo', agora: () => agora });
  assert.deepEqual(d.resumo().linhaDoTempo, [], 'sem arquivos ainda');

  const arquivo = path.join(dir('2026-10-20'), 'rodizio.txt');
  fs.writeFileSync(arquivo, '08:00:00 [INFO] [rodizio] URA: livres ?→2 | humanos 3 | robôs ligados 5\n08:05:00 [INFO] [rodizio] URA: livres 2→1 | humanos 3 | robôs liga');
  assert.equal(d.resumo().linhaDoTempo.length, 1, 'a linha pela metade espera');
  fs.appendFileSync(arquivo, 'dos 4\n');
  assert.deepEqual(d.resumo().linhaDoTempo.map((p) => p.livres), [2, 1]);
  fs.writeFileSync(path.join(pasta, '2026-10-20', 'avisos.txt'), '09:00:00 [rodizio] [AVISO] [robos] a\n09:01:00 [rodizio] [ERRO] [robos] b\n');
  assert.deepEqual(d.resumo().avisos.map((a) => a.texto), ['b', 'a'], 'mais recentes primeiro');

  agora = new Date('2026-10-21T12:00:00Z');
  const r = d.resumo();
  assert.equal(r.dia, '2026-10-21');
  assert.deepEqual([r.linhaDoTempo, r.avisos], [[], []]);
});

/** Painel de verdade (porta aleatória) com os serviços respondendo por um fetch falso. */
async function subir() {
  const chamadas = [];
  const fetchFalso = async (url, opcoes) => {
    chamadas.push({ url, metodo: opcoes.method, auth: opcoes.headers.Authorization, corpo: opcoes.body });
    if (url.startsWith('http://rotinas')) throw new TypeError('fetch failed');
    const corpo = url.endsWith('/health') ? { uptime: 10, lastLoopUra: new Date().toISOString() } : { ligado: opcoes.method === 'POST', mudou: true };
    return { status: 200, text: async () => JSON.stringify(corpo) };
  };
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-'));
  const servidor = criarServidorDoPainel({
    sessoes: new Sessoes({ senha: SENHA, segredo: 's', horas: 1 }),
    servicos: new Servicos({ cfg: { servicos: { rodizio: 'http://rodizio', roteador: 'http://roteador', rotinas: 'http://rotinas' }, timeoutMs: 1000 }, token: 'tok', fetch: fetchFalso }),
    dados: new DadosDoDia({ pasta, fuso: 'America/Sao_Paulo' }),
    automacao: {
      estado: () => ({ estado: chamadas.some((c) => c.url === 'desligar') ? 'desligando' : 'ligada' }),
      desligar: (por) => { chamadas.push({ url: 'desligar', por }); return { iniciado: true }; },
      religar: () => ({ iniciado: false, motivo: 'Espere terminar o que está em andamento.' }),
    },
    cfg: { fuso: 'America/Sao_Paulo' },
    logger: loggerNulo,
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = (metodo, caminho, { corpo, cookie, painel = true, origem } = {}) => fetch(base + caminho, {
    method: metodo,
    headers: { ...(painel ? { 'X-Painel': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origem ? { Origin: origem } : {}), 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { servidor, chamadas, pedir };
}

test('painel: exige sessão, leva o token aos serviços e só passa os comandos da lista', async (t) => {
  const { servidor, chamadas, pedir } = await subir();
  t.after(() => servidor.close());

  const pagina = await pedir('GET', '/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await pedir('GET', '/api/visao')).status, 401);
  assert.equal((await pedir('POST', '/api/rodizio/panico')).status, 401);
  assert.equal((await pedir('POST', '/api/automacao/desligar')).status, 401, 'sem sessão não desliga');
  assert.equal((await pedir('POST', '/api/entrar', { corpo: { senha: 'errada' } })).status, 401);
  assert.equal((await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, painel: false })).status, 403, 'sem o cabeçalho do painel');

  const entrada = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } });
  assert.equal(entrada.status, 200);
  const cookie = entrada.headers.get('set-cookie').split(';')[0];

  const visao = await (await pedir('GET', '/api/visao', { cookie })).json();
  assert.equal(visao.servicos.rodizio.online, true);
  assert.equal(visao.servicos.rotinas.online, false, 'serviço fora do ar aparece como fora');
  assert.equal(visao.argus.respondendo, true);

  const r = await pedir('POST', '/api/rodizio/panico', { cookie });
  assert.deepEqual(await r.json(), { ligado: true, mudou: true });
  const comando = chamadas.find((c) => c.url === 'http://rodizio/panico');
  assert.deepEqual([comando.metodo, comando.auth], ['POST', 'Bearer tok'], 'o token vai do painel ao serviço');

  assert.equal((await pedir('POST', '/api/rodizio/panico', { cookie, painel: false })).status, 403);
  assert.equal((await pedir('POST', '/api/rodizio/panico', { cookie, origem: 'http://outro-site.com' })).status, 403);
  assert.equal((await pedir('POST', '/api/rodizio/webhook', { cookie })).status, 404, 'webhook da Argus não passa pelo painel');

  await pedir('POST', '/api/roteador/manual', { cookie, corpo: { texto: 'a;b' } });
  assert.equal(chamadas.find((c) => c.url === 'http://roteador/manual').corpo, '{"texto":"a;b"}');

  assert.equal((await pedir('POST', '/api/automacao/desligar', { cookie, painel: false })).status, 403, 'desligar exige o cabeçalho do painel');
  const desligar = await pedir('POST', '/api/automacao/desligar', { cookie });
  assert.equal(desligar.status, 202);
  assert.equal((await desligar.json()).estado, 'desligando');
  assert.equal(chamadas.find((c) => c.url === 'desligar').por, '127.0.0.1', 'registra quem pediu');
  assert.equal((await pedir('POST', '/api/automacao/religar', { cookie })).status, 409, 'em andamento: recusa');
  assert.equal((await (await pedir('GET', '/api/visao', { cookie })).json()).automacao.estado, 'desligando');

  assert.equal((await pedir('POST', '/api/sair', { cookie })).status, 200);
  assert.equal((await pedir('GET', '/api/visao', { cookie })).status, 401, 'saiu');
});

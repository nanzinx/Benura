'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lerMudancaDeLivres, lerCallback, lerAviso, tokenRecusadoRecentemente, segundosDoDia } = require('../../src/domain/painel');
const { Sessoes } = require('../../src/painel/sessoes');
const { Usuarios } = require('../../src/painel/usuarios');
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

const semUsuarios = () => new Usuarios({ arquivo: null, logger: loggerNulo });

test('painel: emergência (sem usuários) só com a senha certa; sair invalida; 5 erros bloqueiam o endereço', async () => {
  let agora = 1_000_000;
  const usuarios = semUsuarios();
  const s0 = new Sessoes({ senha: SENHA, segredo: 'seg', horas: 12, usuarios, agora: () => agora });
  const s = { ...s0, entrar: (senha, ip, op) => s0.entrar({ senha }, ip, op), validar: (r) => s0.validar(r), sair: (r) => s0.sair(r) };
  assert.equal((await s.entrar('errada', '1.1.1.1')).ok, false);
  const r = await s.entrar(SENHA, '1.1.1.1', { seguro: true });
  assert.equal(r.ok, true);
  assert.match(r.cookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
  const req = { headers: { cookie: r.cookie.split(';')[0] } };
  assert.ok(s.validar(req));
  assert.equal(s.validar({ headers: { cookie: r.cookie.split(';')[0].replace(/.$/, 'x') } }), null, 'assinatura adulterada');
  assert.equal(s.validar(req).usuario.papel, 'administrador', 'emergência entra como administrador');
  assert.equal(new Sessoes({ senha: 'outra-senha-123', segredo: 'seg', horas: 12, usuarios, agora: () => agora }).validar(req), null, 'trocar a senha derruba as sessões');
  s.sair(req);
  assert.equal(s.validar(req), null, 'saiu');

  const b = await s.entrar(SENHA, '2.2.2.2');
  agora += 13 * 3_600_000;
  assert.equal(s.validar({ headers: { cookie: b.cookie.split(';')[0] } }), null, 'venceu');

  for (let i = 0; i < 5; i++) await s.entrar('errada', '3.3.3.3');
  assert.deepEqual(await s.entrar(SENHA, '3.3.3.3'), { ok: false, bloqueado: true }, 'bloqueado mesmo com a senha certa');
  const c = await s.entrar(SENHA, '4.4.4.4');
  assert.equal(c.ok, true, 'outro endereço entra');
  assert.equal((await new Sessoes({ senha: '', segredo: 'seg', horas: 12, usuarios }).entrar({ senha: '' }, 'x')).ok, false, 'sem PAINEL_SENHA ninguém entra');

  // Criou o primeiro usuário: a senha de emergência deixa de valer, inclusive a sessão aberta.
  await usuarios.criar({ email: 'ana@empresa.com', nome: 'Ana', papel: 'administrador', senha: 'senha-da-ana-1' });
  assert.equal(s.validar({ headers: { cookie: c.cookie.split(';')[0] } }), null);
  assert.equal((await s.entrar(SENHA, '5.5.5.5')).ok, false);
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
async function subir(cfgExtra = {}, usuarios = semUsuarios(), { robos = false, robosFora = false, alertas = null } = {}) {
  const chamadas = [];
  const fetchFalso = async (url, opcoes) => {
    chamadas.push({ url, metodo: opcoes.method, auth: opcoes.headers.Authorization, corpo: opcoes.body });
    if (url.startsWith('http://rotinas') || (robosFora && url.startsWith('http://robos'))) throw new TypeError('fetch failed');
    // [NOVO] alertas de cliente de risco controlados pelo teste (null: a resposta genérica de sempre)
    if (alertas && url.endsWith('/alertas')) {
      if (alertas.fora) throw new DOMException('demorou', 'TimeoutError');
      return { status: 200, text: async () => JSON.stringify({ ativo: true, alertas: [], perfis: { risco: alertas.risco } }) };
    }
    // [NOVO] o benura-robos responde só o que é dele
    if (url === 'http://robos/health') {
      return { status: 200, text: async () => JSON.stringify({ papel: 'robos', robos: { ligados: 5, modo: 'automatico' }, panico: { ligado: true, tipo: 'saindo' }, ajusteRobos: { atual: 9 }, ultimoLivreSaindo: null }) };
    }
    const corpo = url.endsWith('/health') ? { uptime: 10, lastLoopUra: new Date().toISOString(), robos: { ligados: 1 }, panico: { ligado: false } } : { ligado: opcoes.method === 'POST', mudou: true };
    return { status: 200, text: async () => JSON.stringify(corpo) };
  };
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-'));
  const servidor = criarServidorDoPainel({
    sessoes: new Sessoes({ senha: SENHA, segredo: 's', horas: 1, usuarios }),
    servicos: new Servicos({
      cfg: { servicos: { rodizio: 'http://rodizio', roteador: 'http://roteador', rotinas: 'http://rotinas', ...(robos ? { robos: 'http://robos' } : {}) }, timeoutMs: 1000 }, token: 'tok', fetch: fetchFalso,
    }),
    dados: new DadosDoDia({ pasta, fuso: 'America/Sao_Paulo' }),
    automacao: {
      estado: () => ({ estado: chamadas.some((c) => c.url === 'desligar') ? 'desligando' : 'ligada' }),
      desligar: (por) => { chamadas.push({ url: 'desligar', por }); return { iniciado: true }; },
      religar: () => ({ iniciado: false, motivo: 'Espere terminar o que está em andamento.' }),
      definirSimulacao: (ligada, por) => { chamadas.push({ url: 'simulacao', ligada, por }); return { iniciado: true }; },
    },
    cfg: { fuso: 'America/Sao_Paulo', ...cfgExtra },
    logger: { ...loggerNulo, info: (m) => logs.push(m), aviso: (m) => logs.push(m) },
  });
  const logs = [];
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = (metodo, caminho, { corpo, cookie, painel = true, origem, extras = {} } = {}) => fetch(base + caminho, {
    method: metodo,
    headers: { ...(painel ? { 'X-Painel': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origem ? { Origin: origem } : {}), 'Content-Type': 'application/json', ...extras },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { servidor, chamadas, pedir, logs };
}

const PAGES = 'https://benura.benconsig.com.br';
const SEGREDO = 'segredo-do-proxy-com-32-caracteres!!';
/** Como chega pela Function do Pages: pelo túnel (localhost + CF-Connecting-IP), com o segredo e o IP de quem abriu. */
const pelaFunction = (ip = '200.1.2.3', segredo = SEGREDO) => ({ 'CF-Connecting-IP': '172.70.0.1', 'X-Benura-Proxy': segredo, 'X-Benura-Cliente-IP': ip });

test('painel pelo Cloudflare Pages: só pela Function, com a origem do Pages e o IP de quem abriu', async (t) => {
  const { servidor, chamadas, pedir, logs } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());

  const semSegredo = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: { 'CF-Connecting-IP': '200.1.2.3' } });
  assert.equal(semSegredo.status, 403, 'pelo túnel sem o segredo: recusa');
  assert.equal((await pedir('GET', '/', { extras: pelaFunction('200.1.2.3', 'errado') })).status, 403, 'segredo errado: recusa');

  const entrada = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: pelaFunction() });
  assert.equal(entrada.status, 200);
  assert.ok(logs.includes('Painel: entrada com a senha do painel, sem usuários criados (200.1.2.3).'), 'o log traz quem abriu a página, não a Cloudflare');
  const cookie = entrada.headers.get('set-cookie').split(';')[0];

  const r = await pedir('POST', '/api/rodizio/panico', { cookie, origem: PAGES, extras: pelaFunction() });
  assert.equal(r.status, 200, 'escrita com a origem do Pages passa');
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/panico'));
  assert.equal((await pedir('POST', '/api/rodizio/panico', { cookie, origem: 'https://outro.com.br', extras: pelaFunction() })).status, 403, 'outra origem: recusa');

  // No próprio servidor (localhost, sem túnel), continua como antes.
  const local = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } });
  assert.equal(local.status, 200);
  assert.ok(logs.includes('Painel: entrada com a senha do painel, sem usuários criados (127.0.0.1).'));
});

test('painel pelo Pages: o e-mail do Cloudflare Access vai para o log e para o "por"; o cookie sai com Secure', async (t) => {
  const { servidor, chamadas, pedir, logs } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());
  // Pelo Tailscale Funnel a Function chega sem CF-Connecting-IP: o segredo basta.
  const funnel = (extras = {}) => ({ 'X-Forwarded-For': '100.64.0.1', 'X-Benura-Proxy': SEGREDO, 'X-Benura-Cliente-IP': '200.1.2.3', 'X-Benura-Cliente-Email': 'ana@empresa.com', ...extras });

  const entrada = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: funnel() });
  assert.equal(entrada.status, 200);
  assert.match(entrada.headers.get('set-cookie'), /; Secure/, 'a página no Pages é https');
  assert.ok(logs.includes('Painel: entrada com a senha do painel, sem usuários criados (ana@empresa.com (200.1.2.3)).'));
  const cookie = entrada.headers.get('set-cookie').split(';')[0];

  await pedir('POST', '/api/rodizio/panico', { cookie, origem: PAGES, extras: funnel() });
  assert.ok(logs.some((l) => l === 'Painel: supervisão pediu para ligar o pânico (ana@empresa.com (200.1.2.3)) — ok.'));
  await pedir('POST', '/api/automacao/desligar', { cookie, origem: PAGES, extras: funnel() });
  assert.equal(chamadas.find((c) => c.url === 'desligar').por, 'ana@empresa.com (200.1.2.3)', 'a faixa "desligada por" mostra o e-mail');

  // Sem e-mail (página sem Access): só o IP, como antes.
  await pedir('POST', '/api/rodizio/panico', { cookie, origem: PAGES, extras: funnel({ 'X-Benura-Cliente-Email': '' }) });
  assert.ok(logs.some((l) => l === 'Painel: supervisão pediu para ligar o pânico (200.1.2.3) — ok.'));
});

test('painel com o Tailscale Funnel: pelo túnel sem o segredo, 403; e-mail sem o segredo não vale', async (t) => {
  const { servidor, pedir, logs } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());
  assert.equal((await pedir('GET', '/', { extras: { 'X-Forwarded-For': '8.8.8.8', 'X-Forwarded-Proto': 'https' } })).status, 403, 'direto no endereço ts.net');
  assert.equal((await pedir('GET', '/api/sessao', { extras: { 'Tailscale-Funnel-Request': '?1' } })).status, 403);
  const falso = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, extras: { 'X-Benura-Cliente-Email': 'chefe@empresa.com' } });
  assert.equal(falso.status, 200, 'no localhost puro continua entrando');
  assert.ok(logs.includes('Painel: entrada com a senha do painel, sem usuários criados (127.0.0.1).'), 'sem o segredo, o e-mail mandado é ignorado');
});

test('painel pelo Pages: senha errada bloqueia quem errou, não todo mundo que vem pela Cloudflare', async (t) => {
  const { servidor, pedir } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());
  for (let i = 0; i < 5; i += 1) await pedir('POST', '/api/entrar', { corpo: { senha: 'errada' }, origem: PAGES, extras: pelaFunction('200.9.9.9') });
  assert.equal((await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: pelaFunction('200.9.9.9') })).status, 429);
  assert.equal((await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: pelaFunction('200.1.1.1') })).status, 200);
});

test('painel: sem PAINEL_PROXY_SEGREDO, o X-Benura-Cliente-IP é ignorado (não dá para fugir do bloqueio)', async (t) => {
  const { servidor, pedir, logs } = await subir();
  t.after(() => servidor.close());
  await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, extras: { 'X-Benura-Cliente-IP': '1.2.3.4', 'X-Benura-Proxy': 'x' } });
  assert.ok(logs.includes('Painel: entrada com a senha do painel, sem usuários criados (127.0.0.1).'));
});

test('painel: exige sessão, leva o token aos serviços e só passa os comandos da lista', async (t) => {
  const { servidor, chamadas, pedir } = await subir();
  t.after(() => servidor.close());

  const pagina = await pedir('GET', '/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers.get('content-security-policy'), /script-src 'self'/);
  // [NOVO] Endereço de cada aba, sem #: a mesma página (o painel decide a aba pelo caminho).
  const fs = require('fs');
  const rotasDoPainel = fs.readFileSync(require('path').join(__dirname, '..', '..', 'painel-web', 'src', 'rotas.ts'), 'utf8');
  const caminhos = [...rotasDoPainel.matchAll(/^\s+\w+: '(\/[a-z]*)',$/gm)].map((m) => m[1]);
  assert.deepEqual(caminhos, ['/', '/relatorios', '/receptivo', '/robos', '/esteira', '/servicos', '/ajuda'], 'os mesmos caminhos do painel-web/src/rotas.ts');
  const html = await pagina.text();
  for (const c of caminhos) {
    const r = await pedir('GET', c);
    assert.equal(r.status, 200, c);
    assert.equal(await r.text(), html, `${c}: a mesma página`);
  }
  assert.equal((await pedir('GET', '/robos/')).status, 200, 'com barra no fim');
  assert.equal((await pedir('GET', '/nao-existe')).status, 404, 'o resto continua 404');
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

  assert.equal((await pedir('POST', '/api/simulacao', { cookie, painel: false, corpo: { ligada: true } })).status, 403, 'simulação exige o cabeçalho do painel');
  assert.equal((await pedir('POST', '/api/simulacao', { cookie, corpo: { ligada: 'sim' } })).status, 400);
  assert.equal((await pedir('POST', '/api/simulacao', { cookie, corpo: { ligada: true } })).status, 202);
  assert.deepEqual(chamadas.find((c) => c.url === 'simulacao'), { url: 'simulacao', ligada: true, por: '127.0.0.1' });
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

test('config do painel: avisa o Pages pela metade e a origem que não é https', () => {
  const { carregarConfig, validarConfig } = require('../../src/config');
  const validar = (painel) => validarConfig(carregarConfig({ painel: { senha: SENHA, ...painel } }), { escopo: 'painel' });
  assert.deepEqual(validar({ origensPermitidas: [PAGES], proxySegredo: SEGREDO }).fatais, []);
  assert.match(validar({ origensPermitidas: [PAGES], proxySegredo: '' }).avisos.join(), /sem PAINEL_PROXY_SEGREDO/);
  assert.match(validar({ origensPermitidas: [], proxySegredo: SEGREDO }).avisos.join(), /sem PAINEL_ORIGENS_PERMITIDAS/);
  assert.match(validar({ origensPermitidas: [PAGES], proxySegredo: 'curto' }).avisos.join(), /curto demais/);
  assert.match(validar({ origensPermitidas: ['http://benura.benconsig.com.br/painel'], proxySegredo: SEGREDO }).avisos.join(), /https sem caminho/);
});

test('painel [NOVO]: PUT /api/ura/status e "alocar todos no Ativo" levam quem pediu; métricas por GET', async (t) => {
  const { servidor, chamadas, pedir } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());
  const pelaPagina = { 'X-Forwarded-For': '100.64.0.1', 'X-Benura-Proxy': SEGREDO, 'X-Benura-Cliente-IP': '200.1.2.3', 'X-Benura-Cliente-Email': 'ana@empresa.com' };
  const cookie = (await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: pelaPagina })).headers.get('set-cookie').split(';')[0];

  assert.equal((await pedir('PUT', '/api/ura/status', { cookie, origem: PAGES, extras: pelaPagina, corpo: { status: 'calma', modo: 'manual', por: 'falso' } })).status, 200);
  const status = chamadas.find((c) => c.url === 'http://rodizio/ura/status');
  assert.equal(status.metodo, 'PUT');
  assert.deepEqual(JSON.parse(status.corpo), { status: 'calma', modo: 'manual', por: 'ana@empresa.com (200.1.2.3)' }, 'o "por" é o do painel, não o do navegador');

  await pedir('POST', '/api/operadores/transferir-ura-ativo', { cookie, origem: PAGES, extras: pelaPagina });
  assert.deepEqual(JSON.parse(chamadas.find((c) => c.url === 'http://rodizio/operadores/transferir-ura-ativo').corpo), { por: 'ana@empresa.com (200.1.2.3)' });
  assert.equal((await pedir('POST', '/api/operadores/transferir-ura-ativo', { cookie, painel: false })).status, 403, 'escrita exige o cabeçalho do painel');

  assert.equal((await pedir('GET', '/api/metricas/hoje', { cookie, origem: PAGES, extras: pelaPagina })).status, 200);
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/metricas/hoje' && c.metodo === 'GET'));
  // [NOVO] relatório de 7 e 30 dias
  assert.equal((await pedir('GET', '/api/relatorio/semana', { cookie, origem: PAGES, extras: pelaPagina })).status, 200);
  assert.equal((await pedir('GET', '/api/relatorio/mes', { cookie, origem: PAGES, extras: pelaPagina })).status, 200);
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/relatorio/periodo?dias=7' && c.metodo === 'GET'));
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/relatorio/periodo?dias=30' && c.metodo === 'GET'));
  assert.equal((await pedir('PUT', '/api/ura/status', { cookie, origem: PAGES, extras: pelaPagina, corpo: [1] })).status, 400);
});

test('painel [NOVO]: ações por atendente levam o ramal e quem pediu; a lista de pausas não leva quem pediu', async (t) => {
  const { servidor, chamadas, pedir } = await subir({ origensPermitidas: [PAGES], proxySegredo: SEGREDO });
  t.after(() => servidor.close());
  const pelaPagina = { 'X-Forwarded-For': '100.64.0.1', 'X-Benura-Proxy': SEGREDO, 'X-Benura-Cliente-IP': '200.1.2.3', 'X-Benura-Cliente-Email': 'ana@empresa.com' };
  const cookie = (await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, origem: PAGES, extras: pelaPagina })).headers.get('set-cookie').split(';')[0];
  const enviar = (caminho, corpo) => pedir('POST', caminho, { cookie, origem: PAGES, extras: pelaPagina, corpo });

  await enviar('/api/operadores/pausar', { ramal: '202', idPausa: 1 });
  assert.deepEqual(JSON.parse(chamadas.find((c) => c.url === 'http://rodizio/operadores/pausar').corpo),
    { ramal: '202', idPausa: 1, por: 'ana@empresa.com (200.1.2.3)' });
  for (const rota of ['sair-pausa', 'ficar-disponivel', 'deslogar', 'liberar']) {
    await enviar(`/api/operadores/${rota}`, { ramal: '202' });
    assert.equal(JSON.parse(chamadas.find((c) => c.url === `http://rodizio/operadores/${rota}`).corpo).por, 'ana@empresa.com (200.1.2.3)', rota);
  }
  await enviar('/api/operadores/mover', { ramal: '301', para: 'ura' });
  assert.equal(JSON.parse(chamadas.find((c) => c.url === 'http://rodizio/operadores/mover').corpo).para, 'ura');
  await enviar('/api/operadores/pausas', { ramal: '202' });
  assert.deepEqual(JSON.parse(chamadas.find((c) => c.url === 'http://rodizio/operadores/pausas').corpo), { ramal: '202' });
  assert.equal((await pedir('POST', '/api/operadores/deslogar', { cookie, painel: false, corpo: { ramal: '202' } })).status, 403, 'escrita exige o cabeçalho do painel');
  await pedir('PUT', '/api/robos/modo', { cookie, origem: PAGES, extras: pelaPagina, corpo: { modo: 'desligados' } });
  const modo = chamadas.find((c) => c.url === 'http://rodizio/robos/modo');
  assert.deepEqual([modo.metodo, JSON.parse(modo.corpo)], ['PUT', { modo: 'desligados', por: 'ana@empresa.com (200.1.2.3)' }]);
});

test('[NOVO] robôs separados: os comandos dos robôs vão ao benura-robos, e a visão junta o que é dele no rodízio', async (t) => {
  const { servidor, chamadas, pedir } = await subir({}, semUsuarios(), { robos: true });
  t.after(() => servidor.close());
  const cookie = (await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } })).headers.get('set-cookie').split(';')[0];
  assert.equal((await pedir('POST', '/api/rodizio/panico', { cookie })).status, 200);
  assert.equal((await pedir('PUT', '/api/robos/modo', { cookie, corpo: { modo: 'panico' } })).status, 200);
  assert.equal((await pedir('POST', '/api/rodizio/risco/desligar', { cookie })).status, 200);
  assert.ok(chamadas.some((c) => c.url === 'http://robos/panico' && c.metodo === 'POST'));
  assert.ok(chamadas.some((c) => c.url === 'http://robos/robos/modo' && c.metodo === 'PUT'));
  assert.ok(chamadas.some((c) => c.url === 'http://robos/risco/desligar'));
  assert.ok(!chamadas.some((c) => c.url === 'http://rodizio/panico'));
  // as pessoas continuam no rodízio
  await pedir('PUT', '/api/ura/status', { cookie, corpo: { status: 'calma', modo: 'manual' } });
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/ura/status'));

  const v = await (await pedir('GET', '/api/visao', { cookie })).json();
  assert.equal(v.servicos.robos.online, true);
  assert.equal(v.servicos.robos.nome, 'Robôs da URA');
  assert.equal(v.servicos.rodizio.nome, 'Rodízio de pessoas');
  assert.equal(v.servicos.rodizio.dados.robos.ligados, 5, 'o que vale é o do benura-robos');
  assert.equal(v.servicos.rodizio.dados.panico.tipo, 'saindo');
  assert.equal(v.servicos.rodizio.dados.ajusteRobos.atual, 9);
  assert.ok(chamadas.some((c) => c.url === 'http://robos/alertas'), 'os alertas de cliente de risco vêm do benura-robos');
});

test('[NOVO] robôs no rodízio (ROBOS_SERVICO_PROPRIO=false): os comandos dos robôs vão ao rodízio, como antes', async (t) => {
  const { servidor, chamadas, pedir } = await subir();
  t.after(() => servidor.close());
  const cookie = (await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } })).headers.get('set-cookie').split(';')[0];
  await pedir('POST', '/api/rodizio/panico', { cookie });
  assert.ok(chamadas.some((c) => c.url === 'http://rodizio/panico'));
  const v = await (await pedir('GET', '/api/visao', { cookie })).json();
  assert.equal(v.servicos.robos, undefined);
  assert.equal(v.servicos.rodizio.nome, 'Rodízio e robôs');
});

test('[NOVO] só os IPs da empresa pelo túnel (BENURA_IPS_PERMITIDOS no painel); na rede da empresa, direto, entra', async (t) => {
  const { servidor, pedir } = await subir({ ipsPermitidos: '201.93.163.133, 2804:1b3:a5e7:c3c7::/48' });
  t.after(() => servidor.close());
  const fora = await pedir('GET', '/', { extras: { 'CF-Connecting-IP': '187.10.20.30' } });
  assert.equal(fora.status, 403);
  assert.match(fora.headers.get('content-type'), /text\/html/);
  const htmlFora = await fora.text();
  assert.match(htmlFora, /Acesso só pela rede da Benconsig[\s\S]*187\.10\.20\.30/);
  const nonce = /'nonce-([^']+)'/.exec(fora.headers.get('content-security-policy'))?.[1];
  assert.ok(nonce && htmlFora.includes(`<script nonce="${nonce}">`), 'o script da tela roda (o nonce da resposta)');
  assert.equal(fora.headers.get('cache-control'), 'no-store');
  assert.equal((await pedir('GET', '/receptivo', { extras: { 'CF-Connecting-IP': '187.10.20.30' } })).status, 403, 'as abas também');
  const api = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA }, extras: { 'CF-Connecting-IP': '187.10.20.30' } });
  assert.equal(api.status, 403, 'o /api também');
  assert.match((await api.json()).erro, /187\.10\.20\.30/);
  assert.equal((await pedir('GET', '/', { extras: { 'CF-Connecting-IP': '201.93.163.133' } })).status, 200, 'IP da empresa pelo túnel');
  assert.equal((await pedir('GET', '/', { extras: { 'CF-Connecting-IP': '2804:1b3:a5e7:c3c7:9::1' } })).status, 200, 'IPv6 da empresa');
  assert.equal((await pedir('GET', '/')).status, 200, 'direto (http://IP:3010, na rede da empresa)');
});

test('[NOVO] sem BENURA_IPS_PERMITIDOS no painel, o túnel continua como antes', async (t) => {
  const { servidor, pedir } = await subir();
  t.after(() => servidor.close());
  assert.equal((await pedir('GET', '/', { extras: { 'CF-Connecting-IP': '187.10.20.30' } })).status, 200);
});

test('[NOVO] serviço interno fora do ar: 503 com o motivo e o que fazer (o 502 vira página da Cloudflare pelo túnel)', async (t) => {
  const { servidor, pedir } = await subir({}, semUsuarios(), { robos: true, robosFora: true });
  t.after(() => servidor.close());
  const entrada = await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } });
  const cookie = entrada.headers.get('set-cookie').split(';')[0];
  const r = await pedir('PUT', '/api/robos/modo', { cookie, corpo: { modo: 'automatico' } });
  assert.equal(r.status, 503);
  const { erro } = await r.json();
  assert.match(erro, /Robôs da URA fora do ar/);
  assert.match(erro, /npx pm2 logs benura-robos/, 'diz o que fazer no PC do BenURA');
});

test('[NOVO] alertas de cliente de risco: uma resposta perdida não some com o bloco (vale a última por 2 min)', async (t) => {
  const alertas = { fora: false, risco: 3 };
  let agora = Date.parse('2026-11-04T12:00:00Z');
  const { servidor, pedir } = await subir({ agora: () => agora }, semUsuarios(), { alertas });
  t.after(() => servidor.close());
  const cookie = (await pedir('POST', '/api/entrar', { corpo: { senha: SENHA } })).headers.get('set-cookie').split(';')[0];
  const visao = async () => (await (await pedir('GET', '/api/visao', { cookie })).json()).alertas;
  assert.equal((await visao()).perfis.risco, 3);
  alertas.fora = true;
  agora += 60_000;
  assert.equal((await visao())?.perfis?.risco, 3, 'o serviço dos robôs demorou: fica a última resposta');
  agora += 61_000;
  assert.equal(await visao(), null, 'mais de 2 min sem resposta: some (o serviço está mesmo fora)');
  alertas.fora = false;
  alertas.risco = 4;
  assert.equal((await visao()).perfis.risco, 4);
});

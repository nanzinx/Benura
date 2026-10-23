'use strict';
/** [NOVO] Dois PCs (servidor e reserva): a trava na Cloudflare, a posse dos serviços e a cópia entre os PCs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { DatabaseSync } = require('node:sqlite');
const { Trava } = require('../../src/painel/trava');
const { Parceiro } = require('../../src/painel/parceiro');
const { ControleAutomacao } = require('../../src/painel/automacao');
const { posseValida, vigiarPosse, gravarPosse, apagarPosse, lerPosse } = require('../../src/utils/posse');
const { aguardarAutomacaoLigada, gravarAutomacao } = require('../../src/utils/automacao');
const { loggerNulo } = require('../../src/utils/logger');

const FUNCTION = pathToFileURL(path.join(__dirname, '..', '..', 'functions', 'trava', '[[acao]].js')).href;
const SEGREDO = 'segredo-da-trava-com-32-caracteres!';
const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trava-'));

/** D1 de mentira sobre o SQLite do Node: a mesma SQL da Function. */
function d1() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const o = {
        bind: (...a) => { args = a; return o; },
        run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
        first: async () => st.get(...args) ?? null,
      };
      return o;
    },
  };
}

/** A "Cloudflare": a Function de verdade, com relógio controlado e a internet que pode cair. */
async function nuvem() {
  const { onRequest } = await import(FUNCTION);
  const env = { TRAVA_DB: d1(), TRAVA_SEGREDO: SEGREDO };
  const estado = { agora: 1_000_000, fora: false };
  const fetch = async (url, opcoes = {}) => {
    if (estado.fora) throw new TypeError('fetch failed');
    const acao = new URL(url).pathname.replace(/^\/trava\/?/, '');
    const original = Date.now;
    Date.now = () => estado.agora;
    try {
      return await onRequest({ request: new Request(url, { method: opcoes.method ?? 'GET', headers: opcoes.headers, body: opcoes.body }), env, params: acao ? { acao: acao.split('/') } : {} });
    } finally {
      Date.now = original;
    }
  };
  return { fetch, estado };
}

const cfgTrava = (nomePc) => ({ url: 'https://benura.exemplo.com/trava', segredo: SEGREDO, nomePc, validadeMs: 120_000, renovarMs: 30_000, parceiroUrl: '', segredoLocal: '' });

test('Function da trava: segredo, pegar, recusar, vencer, renovar só o dono e soltar', async () => {
  const { fetch, estado } = await nuvem();
  const pedir = (acao, corpo, segredo = SEGREDO) => fetch(`https://x/trava${acao ? `/${acao}` : ''}`, { method: corpo ? 'POST' : 'GET', headers: { 'X-Benura-Trava': segredo }, body: corpo ? JSON.stringify(corpo) : undefined });
  assert.equal((await pedir('', null, 'errado')).status, 403);
  assert.equal((await pedir('pegar', { dono: 'servidor', por: 'Ana' })).status, 200);
  const outro = await pedir('pegar', { dono: 'pc-chefe' });
  assert.equal(outro.status, 409);
  assert.equal((await outro.json()).dono, 'servidor');
  assert.equal((await pedir('pegar', { dono: 'pc-chefe', venceu: true })).status, 409, 'ainda vale');
  estado.agora += 121_000;
  assert.equal((await pedir('pegar', { dono: 'pc-chefe' })).status, 409, 'vencida de outro: só com clique (venceu)');
  assert.equal((await pedir('pegar', { dono: 'pc-chefe', venceu: true, por: 'Chefe' })).status, 200);
  assert.equal((await pedir('renovar', { dono: 'servidor' })).status, 409, 'o antigo dono não renova');
  await pedir('soltar', { dono: 'servidor' });
  assert.equal((await (await pedir('')).json()).dono, 'pc-chefe', 'soltar de quem não é dono não faz nada');
  await pedir('soltar', { dono: 'pc-chefe' });
  const livre = await (await pedir('')).json();
  assert.deepEqual([livre.dono, livre.vale], [null, false]);
  assert.equal((await pedir('pegar', { dono: 'servidor' })).status, 200, 'livre: qualquer um pega');
});

test('posse: sem trava não exige; velha não vale; a subida espera; o vigia encerra o serviço', async () => {
  const arquivo = path.join(pasta(), 'state-posse.json');
  assert.equal(posseValida({ exigir: false, arquivo }), true);
  const posse = { exigir: true, arquivo, maxMs: 90_000 };
  assert.equal(posseValida(posse), false, 'sem arquivo');
  gravarPosse(arquivo, 'servidor', new Date());
  assert.equal(posseValida(posse), true);
  assert.equal(posseValida(posse, Date.now() + 91_000), false, 'velha');
  apagarPosse(arquivo);
  assert.equal(posseValida(posse), false);
  assert.ok(lerPosse(arquivo).ultimaPosse, 'guarda a última posse');

  const avisos = [];
  let esperas = 0;
  await aguardarAutomacaoLigada({ arquivo: path.join(path.dirname(arquivo), 'automacao.json'), posse, intervaloMs: 1 }, { ...loggerNulo, aviso: (m) => avisos.push(m) }, 'rodízio', {
    esperar: async () => { if (++esperas === 2) gravarPosse(arquivo, 'servidor'); },
  });
  assert.equal(esperas, 2);
  assert.match(avisos[0], /não está com ela .* o rodízio espera, sem mexer na Argus/);

  let saiu = 0;
  const erros = [];
  const vigia = vigiarPosse(posse, { ...loggerNulo, erro: (m) => erros.push(m) }, 'rodízio', { intervaloMs: 5, sair: () => { saiu += 1; } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(saiu, 0, 'posse recente: segue');
  apagarPosse(arquivo);
  await new Promise((r) => setTimeout(r, 30));
  vigia.parar();
  assert.equal(saiu, 1);
  assert.match(erros[0], /perdeu a posse/);
});

/** Um "PC": painel (ControleAutomacao + Trava) com o PM2 e o rodízio falsos. */
function montarPc(nome, fetch, relogio) {
  const dir = pasta();
  const arquivo = path.join(dir, 'state-automacao.json');
  const arquivoSimulacao = path.join(dir, 'state-simulacao.json');
  const posse = { exigir: true, arquivo: path.join(dir, 'state-posse.json'), maxMs: 90_000 };
  const chamadas = [];
  const servicos = { chamar: async (s, caminho, { corpo }) => { chamadas.push(`${caminho} ${corpo}`); return { status: 200, corpo: { ligados: 0 } }; } };
  let controle = null;
  const trava = new Trava({ cfg: cfgTrava(nome), arquivoPosse: posse.arquivo, fetch, logger: loggerNulo, agora: () => relogio.agora, aoPerder: (m) => controle.pararPelaTrava(m) });
  controle = new ControleAutomacao({
    cfg: { arquivo, arquivoSimulacao, esperaRobosMs: 1000 }, servicos, logger: loggerNulo, trava, agora: () => relogio.agora,
    executar: async (c, args) => { chamadas.push(`$ ${args.join(' ')}`); return { ok: true, saida: '' }; }, esperar: async () => {},
  });
  const terminar = async () => { while (controle.andamento) await new Promise((r) => setImmediate(r)); };
  const tique = () => trava.tique({ deveAgir: controle.agindoDeVerdade(), ocupado: Boolean(controle.andamento) });
  const age = () => posseValida(posse, relogio.agora);
  return { nome, controle, trava, chamadas, terminar, tique, age, posse };
}

test('dois PCs: em nenhum momento os dois agem de verdade juntos', async () => {
  const { fetch, estado } = await nuvem();
  const relogio = estado; // o mesmo relógio para a Cloudflare e os PCs
  const servidor = montarPc('servidor', fetch, relogio);
  const chefe = montarPc('pc-chefe', fetch, relogio);
  const nuncaJuntos = (quando) => assert.ok(!(servidor.age() && chefe.age()), `os dois agindo: ${quando}`);
  const passar = async (ms) => { relogio.agora += ms; await servidor.tique(); await chefe.tique(); nuncaJuntos(`+${ms} ms`); };

  await servidor.tique(); // sobe ligado: pega a trava livre sozinho
  await chefe.tique(); // o chefe também sobe ligado (de propósito): fica esperando
  nuncaJuntos('subida');
  assert.equal(servidor.age(), true);
  assert.equal(chefe.age(), false);
  const recusa = await chefe.controle.prepararParaAgir('Chefe');
  assert.equal(recusa.ok, false);
  assert.match(recusa.motivo, /O PC servidor está agindo de verdade desde .*Peça para desligar a automação dele ou pôr em Modo simulação/);
  await passar(30_000);
  await passar(30_000);

  // O usuário desliga a automação do servidor: ele solta, e o chefe pega com um clique.
  servidor.controle.desligar('Ana');
  await servidor.terminar();
  assert.equal(servidor.age(), false);
  assert.ok(servidor.chamadas.some((c) => c.startsWith('$ pm2 stop')), 'parou os serviços');
  assert.deepEqual(await chefe.controle.prepararParaAgir('Chefe'), { ok: true });
  nuncaJuntos('chefe pegou');
  assert.equal(chefe.age(), true);
  await passar(30_000);

  // O servidor tenta religar com o chefe agindo: recusa.
  assert.match((await servidor.controle.prepararParaAgir('Ana')).motivo, /O PC pc-chefe está agindo de verdade .*por Chefe/);

  // O chefe liga a simulação: solta; o servidor religa.
  chefe.controle.definirSimulacao(true, 'Chefe');
  await chefe.terminar();
  assert.equal(chefe.age(), false);
  assert.deepEqual(await servidor.controle.prepararParaAgir('Ana'), { ok: true });
  servidor.controle.religar('Ana');
  await servidor.terminar();
  await passar(30_000);
  assert.equal(servidor.age(), true);

  // O servidor cai (para de renovar). O chefe sai da simulação: só depois de vencer, e com clique.
  await chefe.controle.definirSimulacao(false, 'Chefe');
  await chefe.terminar();
  relogio.agora += 60_000;
  await chefe.tique();
  nuncaJuntos('servidor caído, 60 s');
  assert.equal(chefe.age(), false, 'sozinho não pega a de outro PC');
  relogio.agora += 61_000;
  await chefe.tique();
  assert.equal(chefe.age(), false, 'nem vencida, sem clique');
  assert.deepEqual(await chefe.controle.prepararParaAgir('Chefe'), { ok: true }, 'Assumir');
  assert.equal(chefe.age(), true);

  // O servidor volta: a renovação é recusada, ele perde a trava e desliga os robôs parados.
  await servidor.tique();
  nuncaJuntos('servidor voltou');
  assert.equal(servidor.age(), false);
  assert.equal(servidor.trava.minha, false);
  assert.ok(servidor.chamadas.includes('/automacao/encerrar-robos {"derrubar":false}'));
  await passar(30_000);
  assert.equal(chefe.age(), true, 'o chefe segue');
});

test('dois PCs: sem internet, quem tinha a trava para sozinho antes de ela vencer', async () => {
  const { fetch, estado } = await nuvem();
  const servidor = montarPc('servidor', fetch, estado);
  await servidor.tique();
  assert.equal(servidor.age(), true);
  estado.fora = true;
  estado.agora += 30_000;
  await servidor.tique();
  assert.equal(servidor.trava.minha, true, 'uma falha só: segue');
  estado.agora += 31_000;
  await servidor.tique();
  assert.equal(servidor.age(), false, 'mais de metade da validade sem renovar: para');
  assert.ok(servidor.chamadas.some((c) => c.startsWith('/automacao/encerrar-robos')));
  assert.match(servidor.trava.resumo().erro, /sem resposta da Cloudflare/);
  estado.fora = false;
  await servidor.tique();
  assert.equal(servidor.age(), true, 'a internet voltou e ninguém pegou: retoma a sua');
});

test('reinício: o PC retoma a própria trava sozinho; sem TRAVA_URL nada muda', async () => {
  const { fetch, estado } = await nuvem();
  const antes = montarPc('servidor', fetch, estado);
  await antes.tique();
  estado.agora += 200_000; // reiniciou e demorou: a trava venceu, mas ninguém pegou
  const depois = montarPc('servidor', fetch, estado);
  depois.trava.iniciar(() => ({ deveAgir: true, ocupado: false })).parar();
  await depois.tique();
  assert.equal(depois.trava.minha, true);

  const semTrava = new Trava({ cfg: { ...cfgTrava('x'), url: '' }, arquivoPosse: path.join(pasta(), 'p.json'), logger: loggerNulo });
  assert.deepEqual(await semTrava.pegar('Ana'), { ok: true });
  assert.deepEqual(semTrava.resumo(), { ativa: false });
});

test('cópia entre os PCs: só com o segredo; usuários mais novos ganham; o estado do dia vem de quem esteve com a trava por último', async () => {
  const montar = (nome) => {
    const dir = pasta();
    const arquivos = { usuarios: path.join(dir, 'u.json'), posse: path.join(dir, 'p.json'), dia: { modoRobos: path.join(dir, 'modo.json'), travas: path.join(dir, 'travas.json') } };
    return { dir, arquivos, nome };
  };
  const a = montar('servidor');
  const b = montar('pc-chefe');
  const pcs = {};
  const http = (destino) => async (url, opcoes) => {
    const p = pcs[destino];
    if (!p.parceiro.autorizado({ headers: { 'x-benura-interno': opcoes.headers['X-Benura-Interno'] } })) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => JSON.parse(JSON.stringify(p.parceiro.servir({ agindo: p.agindo }))) };
  };
  const cfg = (nome, segredo = 'segredo-local-com-32-caracteres!!') => ({ nomePc: nome, parceiroUrl: 'http://outro:3010', segredoLocal: segredo, copiarMs: 60_000 });
  pcs.servidor = { agindo: true, parceiro: new Parceiro({ cfg: cfg('servidor'), arquivos: a.arquivos, fetch: http('pc-chefe'), logger: loggerNulo }) };
  pcs['pc-chefe'] = { agindo: false, parceiro: new Parceiro({ cfg: cfg('pc-chefe'), arquivos: b.arquivos, fetch: http('servidor'), logger: loggerNulo }) };

  assert.equal(pcs.servidor.parceiro.autorizado({ headers: { 'x-benura-interno': 'errado' } }), false);
  fs.writeFileSync(a.arquivos.usuarios, JSON.stringify({ usuarios: [{ id: '1', email: 'ana@e.com' }] }));
  assert.equal(await pcs['pc-chefe'].parceiro.copiarUsuarios(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.arquivos.usuarios, 'utf8')).usuarios.map((u) => u.email), ['ana@e.com']);
  assert.equal(await pcs['pc-chefe'].parceiro.copiarUsuarios(), false, 'iguais: não regrava');
  assert.equal(await pcs.servidor.parceiro.copiarUsuarios(), false, 'os do outro não são mais novos');

  gravarPosse(a.arquivos.posse, 'servidor', new Date('2026-10-23T10:00:00Z'));
  fs.writeFileSync(a.arquivos.dia.modoRobos, JSON.stringify({ modo: 'desligados', por: 'Ana' }));
  assert.equal(await pcs['pc-chefe'].parceiro.copiarDia(), true, 'o servidor esteve com a trava, o chefe nunca');
  assert.equal(JSON.parse(fs.readFileSync(b.arquivos.dia.modoRobos, 'utf8')).modo, 'desligados');
  gravarPosse(b.arquivos.posse, 'pc-chefe', new Date('2026-10-23T11:00:00Z'));
  assert.equal(await pcs['pc-chefe'].parceiro.copiarDia(), false, 'o chefe esteve com ela depois: não traz o estado velho');

  const semSegredo = new Parceiro({ cfg: cfg('pc-chefe', 'outro-segredo-com-32-caracteres!!!'), arquivos: b.arquivos, fetch: http('servidor'), logger: loggerNulo });
  assert.equal(await semSegredo.copiarUsuarios(), false);
  assert.match(semSegredo.resumo().erro, /não respondeu: HTTP 404/);
});

test('config da trava: avisa o que está pela metade', () => {
  const { carregarConfig, validarConfig } = require('../../src/config');
  const avisos = (trava) => validarConfig(carregarConfig({ trava }), { escopo: 'painel' }).avisos.join(' | ');
  assert.match(avisos({ url: 'https://x/trava', segredo: '' }), /TRAVA_URL sem TRAVA_SEGREDO/);
  assert.match(avisos({ url: 'http://x/trava', segredo: 's' }), /use o endereço https/);
  assert.match(avisos({ parceiroUrl: 'http://192.168.0.20:3010', segredoLocal: '' }), /sem TRAVA_SEGREDO_LOCAL/);
  assert.match(avisos({ url: 'https://x/trava', segredo: 's', renovarMs: 60_000, validadeMs: 120_000 }), /menos da metade/);
});

test('painel com dois PCs: religar e sair da simulação pedem a trava; Assumir só administrador; /api/interno/estado só com o segredo e fora do túnel', async (t) => {
  const { Sessoes } = require('../../src/painel/sessoes');
  const { Usuarios } = require('../../src/painel/usuarios');
  const { Servicos } = require('../../src/painel/servicos');
  const { DadosDoDia } = require('../../src/painel/dados-do-dia');
  const { criarServidorDoPainel } = require('../../src/painel/servidor');
  const usuarios = new Usuarios({ arquivo: null, logger: loggerNulo });
  await usuarios.criar({ email: 'ana@e.com', nome: 'Ana', papel: 'administrador', senha: 'senha-da-ana-1' });
  await usuarios.criar({ email: 'bia@e.com', nome: 'Bia', papel: 'supervisor', senha: 'senha-da-bia-1' });
  const chamadas = [];
  let recusar = true;
  const automacao = {
    estado: () => ({ estado: 'ligada', simulacao: { fixaPeloEnv: false } }),
    agindoDeVerdade: () => true,
    prepararParaAgir: async (por) => { chamadas.push(`trava ${por}`); return recusar ? { ok: false, motivo: 'O PC pc-chefe está agindo de verdade desde 10:42.' } : { ok: true }; },
    religar: () => ({ iniciado: true }), desligar: () => ({ iniciado: true }), definirSimulacao: () => ({ iniciado: true }),
  };
  const dir = pasta();
  const parceiro = new Parceiro({ cfg: { nomePc: 'servidor', parceiroUrl: 'http://outro', segredoLocal: 'segredo-local-com-32-caracteres!!' }, arquivos: { usuarios: path.join(dir, 'u.json'), posse: path.join(dir, 'p.json'), dia: {} }, logger: loggerNulo });
  const trava = { ativa: true, minha: false, resumo: () => ({ ativa: true, pc: 'servidor', dono: 'pc-chefe' }) };
  const servidor = criarServidorDoPainel({
    sessoes: new Sessoes({ senha: '', segredo: 's', horas: 1, usuarios }),
    servicos: new Servicos({ cfg: { servicos: { rodizio: 'http://rodizio' }, timeoutMs: 1000 }, token: 't', fetch: async () => ({ status: 200, text: async () => '{}' }) }),
    dados: new DadosDoDia({ pasta: dir, fuso: 'America/Sao_Paulo' }), automacao, trava, parceiro, cfg: { fuso: 'America/Sao_Paulo' }, logger: loggerNulo,
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  t.after(() => servidor.close());
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (metodo, caminho, { corpo, cookie, extras = {} } = {}) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'X-Painel': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extras }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const ana = (await pedir('POST', '/api/entrar', { corpo: { email: 'ana@e.com', senha: 'senha-da-ana-1' } })).cookie;
  const bia = (await pedir('POST', '/api/entrar', { corpo: { email: 'bia@e.com', senha: 'senha-da-bia-1' } })).cookie;

  const religar = await pedir('POST', '/api/automacao/religar', { cookie: ana });
  assert.deepEqual([religar.status, religar.corpo.erro], [409, 'O PC pc-chefe está agindo de verdade desde 10:42.']);
  assert.equal((await pedir('POST', '/api/simulacao', { cookie: ana, corpo: { ligada: false } })).status, 409, 'sair da simulação pede a trava');
  assert.equal((await pedir('POST', '/api/simulacao', { cookie: ana, corpo: { ligada: true } })).status, 202, 'entrar na simulação não pede');
  assert.equal((await pedir('POST', '/api/automacao/desligar', { cookie: ana })).status, 202, 'desligar não pede');
  assert.equal((await pedir('POST', '/api/trava/assumir', { cookie: bia })).status, 403);
  assert.equal((await pedir('POST', '/api/trava/assumir', { cookie: ana })).status, 409);
  recusar = false;
  assert.equal((await pedir('POST', '/api/trava/assumir', { cookie: ana })).status, 200);
  assert.equal((await pedir('POST', '/api/automacao/religar', { cookie: ana })).status, 202);
  assert.deepEqual(chamadas.filter((c) => c.startsWith('trava')).length, 5);
  assert.equal((await pedir('GET', '/api/visao', { cookie: ana })).corpo.doisPcs.trava.dono, 'pc-chefe');

  assert.equal((await pedir('GET', '/api/interno/estado')).status, 404, 'sem o segredo');
  const interno = { 'X-Benura-Interno': 'segredo-local-com-32-caracteres!!' };
  assert.equal((await pedir('GET', '/api/interno/estado', { extras: interno })).corpo.pc, 'servidor');
  assert.equal((await pedir('GET', '/api/interno/estado', { extras: { ...interno, 'CF-Connecting-IP': '8.8.8.8' } })).status, 404, 'pelo túnel, nunca');
});

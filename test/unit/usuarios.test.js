'use strict';
/** [NOVO] Login por usuário: e-mail, senha (scrypt) e papel. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { Usuarios, podeFazer } = require('../../src/painel/usuarios');
const { Sessoes } = require('../../src/painel/sessoes');
const { Servicos } = require('../../src/painel/servicos');
const { DadosDoDia } = require('../../src/painel/dados-do-dia');
const { criarServidorDoPainel } = require('../../src/painel/servidor');
const { executar, criarLeitor } = require('../../scripts/usuarios');
const { loggerNulo } = require('../../src/utils/logger');

const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usuarios-'));

test('papéis: visualização < supervisor < administrador', () => {
  assert.equal(podeFazer('administrador', 'supervisor'), true);
  assert.equal(podeFazer('supervisor', 'supervisor'), true);
  assert.equal(podeFazer('supervisor', 'administrador'), false);
  assert.equal(podeFazer('visualizacao', 'supervisor'), false);
  assert.equal(podeFazer('visualizacao', 'visualizacao'), true);
  assert.equal(podeFazer('administrador', 'outro'), false);
});

test('Usuarios: senha em scrypt (nunca em texto), e-mail normalizado, senha curta e e-mail repetido recusados', async () => {
  const arquivo = path.join(pasta(), 'state-usuarios.json');
  const u = new Usuarios({ arquivo, logger: loggerNulo }).carregar();
  assert.equal(u.vazia, true);
  const { usuario, senha } = await u.criar({ email: '  Ana@Empresa.com ', nome: 'Ana', papel: 'administrador', senha: 'senha-da-ana-1' });
  assert.equal(senha, null, 'veio a senha: nada de provisória');
  assert.equal(usuario.email, 'ana@empresa.com');
  assert.equal('hash' in usuario, false, 'o hash não sai');
  const texto = fs.readFileSync(arquivo, 'utf8');
  assert.ok(!texto.includes('senha-da-ana-1'));
  assert.match(texto, /"hash": "scrypt\$16384\$8\$1\$/);

  assert.ok(await u.autenticar('ANA@empresa.com', 'senha-da-ana-1'));
  assert.equal(await u.autenticar('ana@empresa.com', 'errada-errada'), null);
  assert.equal(await u.autenticar('ninguem@empresa.com', 'senha-da-ana-1'), null);
  await assert.rejects(u.criar({ email: 'ana@empresa.com', nome: 'Outra', papel: 'supervisor', senha: 'senha-qualquer' }), /Já existe/);
  await assert.rejects(u.criar({ email: 'bia@empresa.com', nome: 'Bia', papel: 'supervisor', senha: 'curta' }), /10 caracteres/);
  await assert.rejects(u.criar({ email: 'sem-arroba', nome: 'X', papel: 'supervisor', senha: 'senha-qualquer' }), /E-mail inválido/);
  await assert.rejects(u.criar({ email: 'x@y.com', nome: 'X', papel: 'chefe', senha: 'senha-qualquer' }), /Papel deve ser/);

  const provisoria = await u.criar({ email: 'bia@empresa.com', nome: 'Bia', papel: 'visualizacao' });
  assert.match(provisoria.senha, /^[A-Za-z2-9]{14}$/, 'sem senha: gera uma provisória');
  assert.equal(provisoria.usuario.senhaProvisoria, true);

  // Outro processo (o npm run usuarios) grava no arquivo: o painel relê sozinho.
  const outro = new Usuarios({ arquivo, logger: loggerNulo }).carregar();
  assert.equal(outro.listar().length, 2);
  await outro.criar({ email: 'caio@empresa.com', nome: 'Caio', papel: 'supervisor', senha: 'senha-do-caio' });
  assert.deepEqual(u.listar().map((x) => x.nome), ['Ana', 'Bia', 'Caio']);
});

test('Usuarios: não deixa ficar sem administrador ativo; papel e desativar sobem a versão', async () => {
  const u = new Usuarios({ arquivo: null, logger: loggerNulo });
  const ana = (await u.criar({ email: 'ana@e.com', nome: 'Ana', papel: 'administrador', senha: 'senha-da-ana-1' })).usuario;
  assert.throws(() => u.atualizar(ana.id, { ativo: false }), /único administrador/);
  assert.throws(() => u.atualizar(ana.id, { papel: 'supervisor' }), /único administrador/);
  const bia = (await u.criar({ email: 'bia@e.com', nome: 'Bia', papel: 'supervisor', senha: 'senha-da-bia-1' })).usuario;
  assert.equal(u.atualizar(bia.id, { papel: 'administrador' }).versao, 2);
  assert.equal(u.atualizar(ana.id, { ativo: false }).versao, 2);
  assert.equal(await u.autenticar('ana@e.com', 'senha-da-ana-1'), null, 'desativado não entra');
  assert.equal(u.atualizar(bia.id, { nome: 'Bia Souza' }).versao, 2, 'só o nome: as sessões continuam');
  await assert.rejects(u.trocarMinhaSenha(bia.id, 'errada', 'nova-senha-bia'), /Senha atual incorreta/);
  await assert.rejects(u.trocarMinhaSenha(bia.id, 'senha-da-bia-1', 'curta'), /10 caracteres/);
  assert.equal((await u.trocarMinhaSenha(bia.id, 'senha-da-bia-1', 'nova-senha-bia')).versao, 3);
});

test('Sessoes por usuário: cookie com o papel; trocar senha, papel ou desativar derruba; bloqueio também por e-mail', async () => {
  const usuarios = new Usuarios({ arquivo: null, logger: loggerNulo });
  const ana = (await usuarios.criar({ email: 'ana@e.com', nome: 'Ana', papel: 'administrador', senha: 'senha-da-ana-1' })).usuario;
  const bia = (await usuarios.criar({ email: 'bia@e.com', nome: 'Bia', papel: 'supervisor', senha: 'senha-da-bia-1' })).usuario;
  const s = new Sessoes({ senha: 'senha-de-emergencia', segredo: 'seg', horas: 12, usuarios });
  assert.equal(s.emergencia, false, 'com usuários, a PAINEL_SENHA não vale');
  assert.equal((await s.entrar({ senha: 'senha-de-emergencia' }, '1.1.1.1')).ok, false);

  const cookieDe = (r) => ({ headers: { cookie: r.cookie.split(';')[0] } });
  const reqBia = cookieDe(await s.entrar({ email: 'bia@e.com', senha: 'senha-da-bia-1' }, '1.1.1.1'));
  assert.deepEqual([s.validar(reqBia).usuario.email, s.validar(reqBia).usuario.papel], ['bia@e.com', 'supervisor']);
  usuarios.atualizar(bia.id, { papel: 'visualizacao' });
  assert.equal(s.validar(reqBia), null, 'mudou o papel: entra de novo');

  const reqAna = cookieDe(await s.entrar({ email: 'ana@e.com', senha: 'senha-da-ana-1' }, '1.1.1.1'));
  assert.ok(s.validar(reqAna));
  await usuarios.definirSenha(ana.id, 'outra-senha-ana');
  assert.equal(s.validar(reqAna), null, 'trocou a senha: sai');

  // 5 erros no mesmo e-mail, de endereços diferentes, bloqueiam o e-mail (não os endereços).
  for (let i = 0; i < 5; i += 1) await s.entrar({ email: 'ana@e.com', senha: 'errada' }, `9.9.9.${i}`);
  assert.deepEqual(await s.entrar({ email: 'ana@e.com', senha: 'outra-senha-ana' }, '8.8.8.8'), { ok: false, bloqueado: true });
  assert.equal((await s.entrar({ email: 'bia@e.com', senha: 'senha-da-bia-1' }, '9.9.9.0')).ok, true, 'outro e-mail do mesmo endereço entra');
});

/** Painel com Ana (administrador), Bia (supervisor) e Caio (visualização). */
async function subirComUsuarios() {
  const usuarios = new Usuarios({ arquivo: null, logger: loggerNulo });
  for (const [email, nome, papel] of [['ana@e.com', 'Ana', 'administrador'], ['bia@e.com', 'Bia', 'supervisor'], ['caio@e.com', 'Caio', 'visualizacao']]) {
    await usuarios.criar({ email, nome, papel, senha: `senha-de-${nome.toLowerCase()}-1` });
  }
  const chamadas = [];
  const logs = [];
  const servidor = criarServidorDoPainel({
    sessoes: new Sessoes({ senha: 'senha-de-emergencia', segredo: 's', horas: 1, usuarios }),
    servicos: new Servicos({
      cfg: { servicos: { rodizio: 'http://rodizio', roteador: 'http://roteador' }, timeoutMs: 1000 }, token: 'tok',
      fetch: async (url, opcoes) => { chamadas.push({ url, corpo: opcoes.body }); return { status: 200, text: async () => '{"ok":true}' }; },
    }),
    dados: new DadosDoDia({ pasta: pasta(), fuso: 'America/Sao_Paulo' }),
    automacao: { estado: () => ({}), desligar: (por) => { chamadas.push({ url: 'desligar', por }); return { iniciado: true }; }, religar: () => ({ iniciado: true }), definirSimulacao: () => ({ iniciado: true }) },
    cfg: { fuso: 'America/Sao_Paulo' },
    notificador: { descricao: () => ({ tipo: 'webhook', destino: 'definido' }), notificar: async (a) => { chamadas.push({ url: 'notificar', ...a }); return { ok: true, destino: 'webhook' }; } },
    configuracao: () => ({ lidaEm: '2026-10-27T11:00:00.000Z', opcoes: [{ nome: 'ARGUS_TOKEN', valor: 'definido', padrao: 'vazio', doEnv: true }], avisos: [] }),
    logger: { ...loggerNulo, info: (m) => logs.push(m), aviso: (m) => logs.push(m) },
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (metodo, caminho, { corpo, cookie } = {}) => {
    const r = await fetch(base + caminho, { method: metodo, headers: { 'X-Painel': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, corpo: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const entrar = async (nome) => (await pedir('POST', '/api/entrar', { corpo: { email: `${nome}@e.com`, senha: `senha-de-${nome}-1` } })).cookie;
  return { servidor, usuarios, chamadas, logs, pedir, entrar };
}

test('painel com usuários: entra por e-mail, a sessão traz o papel, o "por" leva nome e e-mail', async (t) => {
  const { servidor, chamadas, logs, pedir, entrar } = await subirComUsuarios();
  t.after(() => servidor.close());
  assert.deepEqual((await pedir('GET', '/api/entrada')).corpo, { emergencia: false, configurada: true });
  assert.equal((await pedir('POST', '/api/entrar', { corpo: { senha: 'senha-de-emergencia' } })).status, 400, 'sem e-mail não entra');
  const errado = await pedir('POST', '/api/entrar', { corpo: { email: 'bia@e.com', senha: 'errada' } });
  assert.deepEqual([errado.status, errado.corpo.erro], [401, 'E-mail ou senha incorretos']);
  assert.ok(logs.includes('Painel: senha errada para bia@e.com (127.0.0.1).'));

  const bia = await entrar('bia');
  assert.ok(logs.includes('Painel: entrada de Bia <bia@e.com> (127.0.0.1) — Supervisor.'));
  assert.deepEqual((await pedir('GET', '/api/sessao', { cookie: bia })).corpo, { ok: true, usuario: { nome: 'Bia', email: 'bia@e.com', papel: 'supervisor', senhaProvisoria: false }, emergencia: false });
  await pedir('PUT', '/api/robos/modo', { cookie: bia, corpo: { modo: 'desligados', por: 'falso' } });
  assert.equal(JSON.parse(chamadas.find((c) => c.url === 'http://rodizio/robos/modo').corpo).por, 'Bia <bia@e.com> (127.0.0.1)');
  assert.ok(logs.includes('Painel: supervisão pediu para mudar o modo dos robôs (Bia <bia@e.com> (127.0.0.1)) — ok.'));
});

test('painel com usuários: visualização só lê; supervisor não desliga a automação nem cuida de usuários', async (t) => {
  const { servidor, chamadas, pedir, entrar } = await subirComUsuarios();
  t.after(() => servidor.close());
  const caio = await entrar('caio');
  assert.equal((await pedir('GET', '/api/visao', { cookie: caio })).status, 200);
  assert.equal((await pedir('GET', '/api/metricas/hoje', { cookie: caio })).status, 200);
  const negado = await pedir('POST', '/api/rodizio/panico', { cookie: caio });
  assert.deepEqual([negado.status, negado.corpo.erro], [403, 'Seu acesso (Visualização) não permite isso: precisa ser Supervisor.']);
  assert.equal((await pedir('POST', '/api/operadores/pausar', { cookie: caio, corpo: { ramal: '1' } })).status, 403);
  assert.ok(!chamadas.some((c) => /panico|pausar/.test(c.url)), 'nada de escrita chegou ao rodízio');

  const bia = await entrar('bia');
  assert.equal((await pedir('POST', '/api/rodizio/panico', { cookie: bia })).status, 200);
  assert.equal((await pedir('POST', '/api/automacao/desligar', { cookie: bia })).status, 403);
  assert.equal((await pedir('POST', '/api/simulacao', { cookie: bia, corpo: { ligada: true } })).status, 403);
  assert.equal((await pedir('GET', '/api/usuarios', { cookie: bia })).status, 403);

  const ana = await entrar('ana');
  assert.equal((await pedir('POST', '/api/automacao/desligar', { cookie: ana })).status, 202);
  assert.equal(chamadas.find((c) => c.url === 'desligar').por, 'Ana <ana@e.com> (127.0.0.1)');
});

test('painel com usuários: administrador cria, muda papel, desativa e redefine senha; cada um troca a sua', async (t) => {
  const { servidor, pedir, entrar } = await subirComUsuarios();
  t.after(() => servidor.close());
  const ana = await entrar('ana');
  const lista = (await pedir('GET', '/api/usuarios', { cookie: ana })).corpo.usuarios;
  assert.deepEqual(lista.map((u) => u.email), ['ana@e.com', 'bia@e.com', 'caio@e.com']);
  assert.ok(lista.every((u) => !('hash' in u)), 'o hash nunca sai');

  const criado = await pedir('POST', '/api/usuarios', { cookie: ana, corpo: { email: 'dani@e.com', nome: 'Dani', papel: 'supervisor' } });
  assert.equal(criado.status, 201);
  const provisoria = criado.corpo.senhaProvisoria;
  const dani = (await pedir('POST', '/api/entrar', { corpo: { email: 'dani@e.com', senha: provisoria } })).cookie;
  assert.equal((await pedir('GET', '/api/sessao', { cookie: dani })).corpo.usuario.senhaProvisoria, true, 'a página pede para trocar');

  const trocou = await pedir('POST', '/api/minha-senha', { cookie: dani, corpo: { atual: provisoria, nova: 'senha-nova-dani' } });
  assert.equal(trocou.status, 200);
  assert.equal((await pedir('GET', '/api/sessao', { cookie: dani })).status, 401, 'o cookie antigo saiu');
  assert.equal((await pedir('GET', '/api/sessao', { cookie: trocou.cookie })).corpo.usuario.senhaProvisoria, false, 'veio um cookie novo');

  const idBia = lista.find((u) => u.email === 'bia@e.com').id;
  const bia = await entrar('bia');
  assert.equal((await pedir('PUT', '/api/usuarios', { cookie: ana, corpo: { id: idBia, ativo: false } })).corpo.usuario.ativo, false);
  assert.equal((await pedir('GET', '/api/visao', { cookie: bia })).status, 401, 'desativada: sai na hora');
  const nova = (await pedir('POST', '/api/usuarios/senha', { cookie: ana, corpo: { id: idBia } })).corpo.senhaProvisoria;
  assert.match(nova, /^[A-Za-z2-9]{14}$/);

  const idAna = lista.find((u) => u.email === 'ana@e.com').id;
  assert.equal((await pedir('PUT', '/api/usuarios', { cookie: ana, corpo: { id: idAna, papel: 'supervisor' } })).status, 409, 'não muda o próprio papel');
  assert.equal((await pedir('POST', '/api/usuarios', { cookie: ana, corpo: { email: 'x', nome: 'X', papel: 'supervisor' } })).status, 400);
});

test('npm run usuarios: cria (senha sem eco), lista, muda papel e desativa', async () => {
  const usuarios = new Usuarios({ arquivo: path.join(pasta(), 'u.json'), logger: loggerNulo });
  const entrada = new PassThrough();
  const saida = new PassThrough();
  const linhas = [];
  const leitor = criarLeitor(entrada, saida);
  entrada.write('Ana Lima\n\nsenha-da-ana-1\nsenha-da-ana-1\n');
  await executar(['criar', '--email', 'ana@e.com'], { usuarios, leitor, escrever: (l) => linhas.push(l) });
  assert.deepEqual(linhas, ['Usuário ana@e.com criado (Administrador).'], 'o primeiro é administrador por padrão');
  await executar(['criar', '--email', 'bia@e.com', '--nome', 'Bia', '--papel', 'supervisor'], { usuarios, leitor: { perguntar: async () => 'senha-da-bia-1' }, escrever: (l) => linhas.push(l) });
  await executar(['papel', 'bia@e.com', 'visualizacao'], { usuarios, leitor, escrever: (l) => linhas.push(l) });
  await executar(['desativar', 'bia@e.com'], { usuarios, leitor, escrever: (l) => linhas.push(l) });
  linhas.length = 0;
  await executar(['listar'], { usuarios, leitor, escrever: (l) => linhas.push(l) });
  assert.match(linhas[0], /ana@e\.com\s+Ana Lima\s+Administrador/);
  assert.match(linhas[1], /✗ bia@e\.com\s+Bia\s+Visualização \(desativado\)/);
  await assert.rejects(executar(['desativar', 'ana@e.com'], { usuarios, leitor }), /único administrador/);
  await assert.rejects(executar(['voar'], { usuarios, leitor }), /use: criar/);
  leitor.fechar();
});

test('[NOVO] GET /api/configuracao: só o administrador vê a configuração em uso', async (t) => {
  const { servidor, pedir, entrar } = await subirComUsuarios();
  t.after(() => servidor.close());
  assert.equal((await pedir('GET', '/api/configuracao')).status, 401);
  assert.equal((await pedir('GET', '/api/configuracao', { cookie: await entrar('caio') })).status, 403, 'visualização não vê');
  assert.equal((await pedir('GET', '/api/configuracao', { cookie: await entrar('bia') })).status, 403, 'supervisor não vê');
  const r = await pedir('GET', '/api/configuracao', { cookie: await entrar('ana') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.opcoes.map((o) => [o.nome, o.valor]), [['ARGUS_TOKEN', 'definido']]);
  assert.equal(r.corpo.lidaEm, '2026-10-27T11:00:00.000Z');
});

test('[NOVO] POST /api/notificacoes/testar: só o administrador; manda um aviso de teste e diz se chegou', async (t) => {
  const { servidor, pedir, entrar, chamadas } = await subirComUsuarios();
  t.after(() => servidor.close());
  assert.equal((await pedir('POST', '/api/notificacoes/testar', { cookie: await entrar('bia') })).status, 403);
  const ana = await entrar('ana');
  const r = await pedir('POST', '/api/notificacoes/testar', { cookie: ana });
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, { ok: true, destino: 'webhook' });
  const aviso = chamadas.find((c) => c.url === 'notificar');
  assert.match(aviso.titulo, /teste/i);
  assert.match(aviso.texto, /Ana/);
  assert.deepEqual((await pedir('GET', '/api/visao', { cookie: ana })).corpo.notificacoes, { tipo: 'webhook', destino: 'definido' });
});

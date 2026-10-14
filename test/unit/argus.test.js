'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ArgusClient, ArgusError, ArgusAutenticacaoError } = require('../../src/integrations/argus/argus.client');
const { DiretorioIndisponivelError } = require('../../src/integrations/argus/diretorio-operadores.service');
const { CadastroRamaisRepository } = require('../../src/repositories/cadastro-ramais.repository');
const { loggerNulo } = require('../../src/utils/logger');
const { montarArgusMock } = require('./helpers');

function servidorArgus(handler) {
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const [status, resposta] = handler(req.url.split('/').pop(), corpo ? JSON.parse(corpo) : {}, req);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(resposta));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({
    srv,
    client: new ArgusClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 't', timeoutMs: 2000, tentativas: 2 }, loggerNulo),
  })));
}

test('ArgusClient: 403 vira ArgusAutenticacaoError e não é re-tentado', async (t) => {
  let chamadas = 0;
  const { srv, client } = await servidorArgus(() => { chamadas++; return [403, {}]; });
  t.after(() => srv.close());
  await assert.rejects(client.listarGrupos(), ArgusAutenticacaoError);
  assert.equal(chamadas, 1);
});

test('ArgusClient: transferência com codStatus 1 mas falha individual lança erro', async (t) => {
  const { srv, client } = await servidorArgus((cmd, corpo, req) => {
    assert.equal(req.headers['token-signature'], 't');
    return [200, {
      codStatus: 1, qtdeTransferidos: 0, qtdeFalhas: 1,
      operadores: [{ ramal: corpo.ramaisOperadores[0], codStatus: -1, descStatus: 'Operador não vinculado à campanha' }],
    }];
  });
  t.after(() => srv.close());
  await assert.rejects(client.transferirOperador('1001', 5), (e) => e instanceof ArgusError && /não vinculado/.test(e.message));
});

test('ArgusClient: codStatus < 1 vira ArgusError com a descrição', async (t) => {
  const { srv, client } = await servidorArgus(() => [200, { codStatus: -1, descStatus: 'Campanha inválida' }]);
  t.after(() => srv.close());
  await assert.rejects(client.listarUsuarios(), /Campanha inválida/);
});

test('Diretório: ramal pelo nome (sem acento/caixa) e só de operadores ativos', async () => {
  const { diretorio } = montarArgusMock();
  await diretorio.atualizar();
  assert.equal(diretorio.ramalPorNome('patricia santos'), '1007');
  assert.equal(diretorio.ramalPorNome('BRUNO DESLIGADO'), null); // inativo
  assert.equal(diretorio.ramalPorNome('NINGUEM'), null);
});

test('Diretório: exceção do arquivo tem prioridade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excecoes-'));
  const arquivo = path.join(dir, 'r.json');
  fs.writeFileSync(arquivo, JSON.stringify({ 'ANA CLARA': '1001', 'RICARDO MENDES': '7777' }));
  const { diretorio } = montarArgusMock({ excecoesRamal: new CadastroRamaisRepository({ arquivo, logger: loggerNulo }) });
  await diretorio.atualizar();
  assert.equal(diretorio.ramalPorNome('Ana Clara'), '1001');
  assert.equal(diretorio.ramalPorNome('RICARDO MENDES'), '7777');
});

test('Diretório: nome repetido entre operadores ativos é ambíguo', async () => {
  const { diretorio, client } = montarArgusMock();
  const clone = structuredClone(client.dados.usuarios.find((u) => u.ramal === '1001'));
  client.dados.usuarios.push({ ...clone, idUsuario: 999, login: 'ANA.OUTRA', ramal: '1999' });
  await diretorio.atualizar();
  assert.equal(diretorio.ramalPorNome('ANA CLARA SOUZA'), null);
});

test('Diretório: grupo do supervisor é inferido pela maioria dos operadores', async () => {
  const { diretorio } = montarArgusMock();
  await diretorio.atualizar();
  const gabriel = diretorio.supervisorPorNome('Gabriel Nascimento da Silva').supervisor;
  const maysa = diretorio.supervisorPorNome('MAYSA DE FÁTIMA SIQUEIRA DOS SANTOS CARNEIRO').supervisor;
  assert.deepEqual(diretorio.grupoDoSupervisor(gabriel), { idGrupo: 1, origem: 'inferido' });
  assert.deepEqual(diretorio.grupoDoSupervisor(maysa), { idGrupo: 3, origem: 'inferido' });
  assert.equal(diretorio.grupoAtivoDoOperador('1003'), 3);
});

test('Diretório: supervisor sem operadores no Ativo → grupo do Ativo com o primeiro nome dele', async () => {
  const { diretorio, client } = montarArgusMock();
  // Toda a equipe da Maysa na URA: não dá para inferir pela maioria.
  for (const u of client.dados.usuarios) {
    if (u.campanhas[0].idUsuarioSupervisor === 880) u.campanhas[0].idGrupoUsuario = 2;
  }
  await diretorio.atualizar();
  const maysa = diretorio.supervisorPorNome('MAYSA DE FÁTIMA SIQUEIRA DOS SANTOS CARNEIRO').supervisor;
  assert.deepEqual(diretorio.grupoDoSupervisor(maysa), { idGrupo: 3, origem: 'nome' });
  assert.equal(diretorio.grupoAtivoDoOperador('1005'), 3);
});

test('Diretório: exceção supervisor → grupo vence a inferência', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'));
  const arquivo = path.join(dir, 's.json');
  fs.writeFileSync(arquivo, JSON.stringify({ 'GABRIEL NASCIMENTO DA SILVA': 3 }));
  const { diretorio } = montarArgusMock({ arquivoSupervisoresGrupos: arquivo });
  await diretorio.atualizar();
  const gabriel = diretorio.supervisorPorNome('GABRIEL NASCIMENTO DA SILVA').supervisor;
  assert.deepEqual(diretorio.grupoDoSupervisor(gabriel), { idGrupo: 3, origem: 'excecao' });
});

test('Diretório: supervisor por nome parcial único; administrativo apenas', async () => {
  const { diretorio } = montarArgusMock();
  await diretorio.atualizar();
  assert.equal(diretorio.supervisorPorNome('GABRIEL NASCIMENTO').supervisor?.idUsuario, 491);
  assert.equal(diretorio.supervisorPorNome('RICARDO MENDES').supervisor, null); // é operador
});

test('Diretório: ramais da equipe de um supervisor (EQUIPES_FIXAS_URA)', async () => {
  const { diretorio, client } = montarArgusMock();
  await diretorio.atualizar();
  const daMaysa = client.dados.usuarios
    .filter((u) => u.ativo && u.ramal && u.campanhas.some((c) => c.idUsuarioSupervisor === 880)).map((u) => u.ramal).sort();
  const equipe = diretorio.ramaisDaEquipe('MAYSA DE FÁTIMA SIQUEIRA DOS SANTOS CARNEIRO');
  assert.ok(daMaysa.length > 0);
  assert.deepEqual(equipe.ramais.sort(), daMaysa);
  assert.deepEqual(diretorio.ramaisDaEquipe('NINGUEM COM ESSE NOME').ramais, []);
});

test('Diretório: vendedores gerenciados = operadores ativos na URA ou no Ativo', async () => {
  const { diretorio } = montarArgusMock();
  await diretorio.atualizar();
  const ramais = diretorio.vendedoresGerenciados().map((v) => v.ramal).sort();
  assert.deepEqual(ramais, ['1001', '1002', '1003', '1004', '1005', '1006', '1008']); // sem 1007 (treino) e 1009 (inativo)
});

test('Diretório: mantém o último snapshot se a Argus cair; sem snapshot, lança', async () => {
  const { diretorio, client } = montarArgusMock({ cfg: { cacheDiretorioMs: 0 } });
  await diretorio.atualizar();
  client.listarUsuarios = async () => { throw new Error('Argus fora'); };
  await diretorio.atualizar();
  assert.equal(diretorio.ramalPorNome('RICARDO MENDES'), '1004');

  const novo = montarArgusMock();
  novo.client.listarUsuarios = async () => { throw new Error('Argus fora'); };
  await assert.rejects(novo.diretorio.atualizar(), DiretorioIndisponivelError);
});

test('ArgusClient: uploadMailing (form-data), excluirMailing e listarSkills', async () => {
  const http = require('http');
  const { ArgusClient } = require('../../src/integrations/argus/argus.client');
  const { loggerNulo } = require('../../src/utils/logger');
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      recebidas.push({ url: req.url, tipo: req.headers['content-type'], token: req.headers['token-signature'], corpo });
      const resposta = req.url.endsWith('/listarskills')
        ? { codStatus: 1, retornoGetSkillsItens: [{ idSkill: 46, hashEndpointSkill: 'h46' }] }
        : { codStatus: 1, idArquivo: 77 };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(resposta));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/apiargus`;
    const client = new ArgusClient({ baseUrl: `${base}/cmd`, baseMailing: base, token: 'tk', timeoutMs: 2000, tentativas: 1 }, loggerNulo);
    const conteudo = Buffer.from('CPF;NOME\r\n_A;JOÃO\r\n', 'latin1');
    assert.deepEqual(await client.uploadMailing('hash1', { nomeArquivo: 'BASE-X.csv', conteudo }), { codStatus: 1, idArquivo: 77 });
    await client.excluirMailing('hash1', 77);
    assert.deepEqual(await client.listarSkills(), [{ idSkill: 46, hashEndpointSkill: 'h46' }]);

    const [upload, exclusao] = recebidas;
    assert.equal(upload.url, '/apiargus/hash1/uploadmailing');
    assert.equal(upload.token, 'tk');
    assert.match(upload.tipo, /^multipart\/form-data; boundary=/);
    assert.match(upload.corpo, /filename="BASE-X\.csv"/);
    assert.ok(upload.corpo.includes('_A;JOÃO'));
    assert.equal(exclusao.url, '/apiargus/hash1/excluirmailing');
    assert.deepEqual(JSON.parse(exclusao.corpo), { idArquivo: 77, excluirTodosMailings: 'N' });
  } finally {
    servidor.close();
  }
});

test('Diretório: conferirSupervisores mostra o grupo de cada equipe e por qual regra', async () => {
  const { diretorio, client } = montarArgusMock();
  // Toda a equipe da Maysa na URA: o grupo sai pelo nome ("MAYSA - COMERCIAL"), não pela equipe.
  for (const u of client.dados.usuarios) {
    if (u.campanhas[0].idUsuarioSupervisor === 880) u.campanhas[0].idGrupoUsuario = 2;
  }
  const semSupervisor = client.dados.usuarios.find((u) => u.ramal === '1002');
  semSupervisor.campanhas[0].idUsuarioSupervisor = null;
  await diretorio.atualizar();

  const { supervisores, semSupervisor: sem, gruposAtivos } = diretorio.conferirSupervisores();
  const porNome = Object.fromEntries(supervisores.map((s) => [s.nome, s]));
  assert.deepEqual(
    { idGrupo: porNome['GABRIEL NASCIMENTO DA SILVA'].idGrupo, origem: porNome['GABRIEL NASCIMENTO DA SILVA'].origem },
    { idGrupo: 1, origem: 'inferido' },
  );
  assert.equal(porNome['MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO'].origem, 'nome');
  assert.deepEqual(sem.map((o) => o.ramal), ['1002'], 'sem supervisor: corrigir na Argus');
  assert.deepEqual(gruposAtivos.map((g) => g.idGrupo), [1, 3]);
  assert.ok(!supervisores.some((s) => s.operadores === 0));
});

test('conferir:supervisores: a sugestão fixa todos os supervisores; quem falta vem com null e é ignorado ao ler', async () => {
  const { montarSugestao } = require('../../scripts/conferir-supervisores');
  const sugestao = montarSugestao([{ nome: 'GABRIEL NASCIMENTO DA SILVA', idGrupo: 1 }, { nome: 'FULANO SEM GRUPO', idGrupo: null }]);
  assert.deepEqual(sugestao, { 'GABRIEL NASCIMENTO DA SILVA': 1, 'FULANO SEM GRUPO': null });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sug-'));
  const arquivo = path.join(dir, 's.json');
  fs.writeFileSync(arquivo, JSON.stringify({ ...sugestao, 'GABRIEL NASCIMENTO DA SILVA': null }));
  const { diretorio } = montarArgusMock({ arquivoSupervisoresGrupos: arquivo });
  await diretorio.atualizar();
  const gabriel = diretorio.supervisorPorNome('GABRIEL NASCIMENTO DA SILVA').supervisor;
  assert.deepEqual(diretorio.grupoDoSupervisor(gabriel), { idGrupo: 1, origem: 'inferido' }, 'null não vira grupo 0');
});

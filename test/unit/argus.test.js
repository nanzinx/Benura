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

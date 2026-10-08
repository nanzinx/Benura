'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mapearRanking, RespostaCarrosselInvalidaError } = require('../../src/integrations/carrossel/carrossel.mapper');
const { normalizarNome } = require('../../src/utils/texto');
const { CarrosselService, CarrosselIndisponivelError } = require('../../src/integrations/carrossel/carrossel.service');
const { CadastroRamaisRepository } = require('../../src/repositories/cadastro-ramais.repository');
const { loggerNulo } = require('../../src/utils/logger');

// Formato real de GET /ranking/vendedores do Carrosel-BenApi.
const vendedor = (nome, vendaConcluida, equipe = 'Equipe X') => ({
  nome,
  performance: [
    { Equipe: 'GERAL', Integrado: 10, vendaGeral: vendaConcluida + 1, vendaConcluida, vendaPendente: 1, meta: 450000 },
    { Equipe: equipe, Integrado: 10, vendaGeral: vendaConcluida + 1, vendaConcluida, vendaPendente: 1 },
  ],
  'ranking-geral': 1,
  'ranking-integrado': 1,
});
const ranking = (extra = {}) => ({
  hoje: [vendedor('FULANO DE TAL', 1000)],
  ontem: [vendedor('JOÃO  da Silva', 60000, 'Equipe A'), vendedor('Sem Cadastro', 5)],
  semanal: [], mensal: [],
  ultimaExtracao: '08/10/2026 10:00:00',
  diaOntem: '07/10/2026',
  ...extra,
});

test('normalizarNome ignora acento, caixa e espaços', () => {
  assert.equal(normalizarNome('  João   da Silva '), 'JOAO DA SILVA');
});

test('mapearRanking usa a linha GERAL e a métrica escolhida', () => {
  const r = mapearRanking(ranking(), 'ontem', 'vendaConcluida');
  assert.equal(r.diaOntem, '07/10/2026');
  assert.deepEqual(r.vendedores[0], { nome: 'JOÃO  da Silva', chave: 'JOAO DA SILVA', equipe: 'Equipe A', totalVendas: 60000 });
  assert.equal(mapearRanking(ranking(), 'ontem', 'vendaGeral').vendedores[0].totalVendas, 60001);
});

test('mapearRanking rejeita respostas de erro ou malformadas', () => {
  assert.throws(() => mapearRanking(ranking({ ultimaExtracao: 'Erro' }), 'hoje', 'vendaConcluida'), RespostaCarrosselInvalidaError);
  assert.throws(() => mapearRanking([], 'hoje', 'vendaConcluida'), RespostaCarrosselInvalidaError);
  assert.throws(() => mapearRanking({ ontem: [] }, 'hoje', 'vendaConcluida'), RespostaCarrosselInvalidaError);
});

function cadastroTemp(conteudo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadastro-'));
  const arquivo = path.join(dir, 'ramais.json');
  fs.writeFileSync(arquivo, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
  return { arquivo, repo: new CadastroRamaisRepository({ arquivo, logger: loggerNulo }).atualizar() };
}

test('cadastro aceita objeto ou lista e casa nomes normalizados', () => {
  assert.equal(cadastroTemp({ 'Joao da Silva': 1001 }).repo.ramalDe('JOÃO DA SILVA'), '1001');
  assert.equal(cadastroTemp([{ nome: 'Ana', ramal: '7' }]).repo.ramalDe('ana'), '7');
  assert.equal(cadastroTemp({}).repo.ramalDe('ninguem'), null);
});

test('cadastro mantém a versão anterior se o arquivo for corrompido', () => {
  const { arquivo, repo } = cadastroTemp({ ANA: '1' });
  fs.writeFileSync(arquivo, '{quebrado');
  const futuro = new Date(Date.now() + 5000);
  fs.utimesSync(arquivo, futuro, futuro);
  assert.equal(repo.atualizar().ramalDe('ANA'), '1');
});

test('CarrosselService usa o último resultado válido quando a API cai', async () => {
  let falhar = false;
  const client = {
    async buscarRankingVendedores() {
      if (falhar) throw new Error('ECONNREFUSED');
      return ranking();
    },
  };
  const svc = new CarrosselService({ client, metrica: 'vendaConcluida', logger: loggerNulo });

  assert.equal((await svc.listarVendas('hoje')).origem, 'api');
  falhar = true;
  const r2 = await svc.listarVendas('hoje');
  assert.equal(r2.origem, 'fallback');
  assert.equal(r2.vendedores[0].totalVendas, 1000);

  await assert.rejects(svc.listarVendas('hoje', { permitirFallback: false }), CarrosselIndisponivelError);
  await assert.rejects(svc.listarVendas('ontem'), CarrosselIndisponivelError);
});

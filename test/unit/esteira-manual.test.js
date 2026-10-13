'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  lerEsteira, totaisPorDia, rankingDaEsteira, unirDias, resumoDaEsteira, EsteiraInvalidaError,
} = require('../../src/domain/esteira-manual');
const { mapearRanking } = require('../../src/integrations/carrossel/carrossel.mapper');
const { EsteiraManualRepository } = require('../../src/integrations/carrossel/esteira-manual.repository');
const { CarrosselComRedundancia } = require('../../src/integrations/carrossel/carrossel-com-redundancia');
const { CarrosselService } = require('../../src/integrations/carrossel/carrossel.service');
const { RoteamentoService } = require('../../src/services/roteamento.service');
const { Resultado } = require('../../src/integrations/argus/discadora.service');
const { estadoVazio } = require('../../src/repositories/estado.repository');
const { criarServidor } = require('../../src/http/server');
const { criarControllers } = require('../../src/http/controllers');
const { loggerNulo } = require('../../src/utils/logger');

const HOJE = '2026-10-13';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'esteira-')), 'esteira.json');

/** Esteira sintética no formato do export (";" e aspas), com colunas que o roteador ignora. */
function esteiraCsv(linhas) {
  const cabecalho = 'Proposta;ADE;"Data/Hora";Etapa;Status;CPF;Nome;Agente;Equipe;"Valor Contrato";Digitador';
  const corpo = linhas.map(([proposta, data, agente, valor]) => (
    `${proposta};X;"${data}  10:21:33";Andamento;"AG. ENVIO CIP";00000000000;"CLIENTE TESTE";"${agente}";"EQUIPE; TESTE";${valor};x@1`
  ));
  return [cabecalho, ...corpo].join('\r\n');
}

// ───────────── Leitura ─────────────

test('lerEsteira: CSV com ";" e aspas, data com dois espaços e valor em formato BR', () => {
  const { vendas, ignoradas } = lerEsteira(`﻿${esteiraCsv([['1', '13/10/2026', 'V1', '27.689,87']])}`);
  assert.equal(ignoradas, 0);
  assert.deepEqual(vendas, [{ agente: 'V1', valor: 27689.87, data: HOJE, proposta: '1' }]);
});

test('lerEsteira: tabela copiada da tela (TAB) e linhas sem agente/valor ignoradas', () => {
  const texto = ['Proposta\tData/Hora\tAgente\tValor Contrato', '1\t13/10/2026 09:00\tV1\t1.000,00', '2\t13/10/2026 09:00\t\t500,00', '3\t13/10/2026\tV2\t0'].join('\n');
  const { vendas, ignoradas } = lerEsteira(texto);
  assert.deepEqual(vendas.map((v) => [v.agente, v.valor]), [['V1', 1000]]);
  assert.equal(ignoradas, 2);
});

test('lerEsteira: coluna obrigatória ausente → erro listando o que veio', () => {
  assert.throws(() => lerEsteira('Proposta;Agente;Data/Hora\n1;V1;13/10/2026'), (e) => e instanceof EsteiraInvalidaError
    && /VALOR CONTRATO/.test(e.message) && /Vieram: Proposta, Agente, Data\/Hora/.test(e.message));
  assert.throws(() => lerEsteira('só cabeçalho'), EsteiraInvalidaError);
});

test('totaisPorDia: soma por dia e agente (sem acento/caixa) e conta cada proposta uma vez', () => {
  const { vendas } = lerEsteira(esteiraCsv([
    ['1', '10/10/2026', 'João Silva', '30.000,00'],
    ['2', '10/10/2026', 'JOAO  SILVA', '25.000,00'],
    ['2', '10/10/2026', 'JOAO SILVA', '25.000,00'], // mesma proposta colada duas vezes
    ['3', '13/10/2026', 'V2', '100,00'],
  ]));
  const dias = totaisPorDia(vendas);
  assert.deepEqual(Object.keys(dias).sort(), ['2026-10-10', HOJE]);
  assert.deepEqual(dias['2026-10-10']['JOAO SILVA'], { nome: 'João Silva', total: 55000 });
});

// ───────────── Ranking no formato do Carrossel ─────────────

test('rankingDaEsteira: "ontem" é o último dia trabalhado e o mapper real lê a métrica', () => {
  const dias = totaisPorDia(lerEsteira(esteiraCsv([
    ['1', '09/10/2026', 'V1', '90.000,00'], // quinta
    ['2', '10/10/2026', 'V1', '60.000,00'], // sexta (último dia trabalhado antes de terça 13)
    ['3', '10/10/2026', 'V2', '10.000,00'],
    ['4', '13/10/2026', 'V2', '500,00'],
  ])).vendas);
  const payload = rankingDaEsteira(dias, HOJE, 'vendaGeral', 'às 08:10');

  assert.equal(payload.diaOntem, '10/10/2026');
  assert.match(payload.ultimaExtracao, /Esteira colada às 08:10/);
  const ontem = mapearRanking(payload, 'ontem', 'vendaGeral').vendedores;
  assert.deepEqual(ontem.map((v) => [v.nome, v.totalVendas]).sort(), [['V1', 60000], ['V2', 10000]]);
  assert.deepEqual(mapearRanking(payload, 'hoje', 'vendaGeral').vendedores.map((v) => v.totalVendas), [500]);
});

test('unirDias: a colagem nova substitui só os dias que contém e guarda os mais recentes', () => {
  const unidos = unirDias({ '2026-10-01': { a: 1 }, '2026-10-10': { a: 1 } }, { '2026-10-10': { b: 2 }, [HOJE]: { c: 3 } }, 2);
  assert.deepEqual(unidos, { '2026-10-10': { b: 2 }, [HOJE]: { c: 3 } });
});

test('resumoDaEsteira: quem passou da meta no dia anterior e quem vendeu hoje', () => {
  const dias = { '2026-10-10': { A: { nome: 'A', total: 50_000 }, B: { nome: 'B', total: 50_000.01 } }, [HOJE]: { C: { nome: 'C', total: 10 } } };
  assert.deepEqual(resumoDaEsteira(dias, HOJE, 50_000), {
    diaAnterior: '10/10/2026', acimaDaMeta: [{ nome: 'B', total: 50_000.01 }], vendeuHoje: [{ nome: 'C', total: 10 }],
  });
});

// ───────────── Repositório e redundância ─────────────

test('EsteiraManualRepository: une colagens e sobrevive a reinício', async () => {
  const arquivo = tmp();
  const repo = new EsteiraManualRepository({ arquivo, logger: loggerNulo });
  await repo.colar(esteiraCsv([['1', '10/10/2026', 'V1', '60.000,00']]), HOJE);
  const r = await repo.colar(esteiraCsv([['2', '13/10/2026', 'V2', '1,00']]), HOJE);
  assert.deepEqual(r, { dias: [HOJE], vendas: 1, ignoradas: 0 });

  const recarregado = new EsteiraManualRepository({ arquivo, logger: loggerNulo });
  assert.deepEqual(Object.keys(recarregado.dias()).sort(), ['2026-10-10', HOJE]);
  assert.ok(recarregado.coladaHoje(HOJE));
  assert.ok(!recarregado.coladaHoje('2026-10-14'));
});

async function redundancia({ falha, resposta, colar = true, colarEm = HOJE } = {}) {
  const esteira = new EsteiraManualRepository({ arquivo: tmp(), logger: loggerNulo });
  if (colar) await esteira.colar(esteiraCsv([['1', '10/10/2026', 'V1', '60.000,00']]), colarEm);
  const client = { async buscarRankingVendedores() { if (falha) throw falha; return resposta; } };
  return new CarrosselComRedundancia({ client, esteira, relogio: { hoje: () => HOJE }, metrica: 'vendaConcluida', logger: loggerNulo });
}

test('redundância: Carrossel no ar → usa o Carrossel, mesmo com esteira colada', async () => {
  const resposta = { hoje: [], ontem: [], ultimaExtracao: '13/10/2026 08:00:00' };
  assert.equal(await (await redundancia({ resposta })).buscarRankingVendedores(), resposta);
});

test('redundância: Carrossel fora do ar ou com "Erro" → usa a esteira colada hoje', async () => {
  const caiu = await (await redundancia({ falha: new Error('ECONNREFUSED') })).buscarRankingVendedores();
  assert.equal(caiu.diaOntem, '10/10/2026');
  assert.match(caiu.ultimaExtracao, /Esteira colada/);

  const comErro = await (await redundancia({ resposta: { ultimaExtracao: 'Erro', hoje: [], ontem: [] } })).buscarRankingVendedores();
  assert.equal(comErro.diaOntem, '10/10/2026');
});

test('redundância: sem esteira colada hoje → o erro original continua', async () => {
  const falha = new Error('ECONNREFUSED');
  await assert.rejects((await redundancia({ falha, colar: false })).buscarRankingVendedores(), /ECONNREFUSED/);
  await assert.rejects((await redundancia({ falha, colarEm: '2026-10-10' })).buscarRankingVendedores(), /ECONNREFUSED/);
  const erro = { ultimaExtracao: 'Erro', hoje: [], ontem: [] };
  assert.equal(await (await redundancia({ resposta: erro, colar: false })).buscarRankingVendedores(), erro);
});

// ───────────── Ponta a ponta: Carrossel fora do ar + esteira colada ─────────────

test('com o Carrossel fora do ar, a esteira colada faz a carga pela meta e o gatilho de venda de hoje', async () => {
  const relogio = { hoje: () => HOJE };
  const esteira = new EsteiraManualRepository({ arquivo: tmp(), logger: loggerNulo });
  const caido = { async buscarRankingVendedores() { throw new Error('ECONNREFUSED'); } };
  const client = new CarrosselComRedundancia({ client: caido, esteira, relogio, metrica: 'vendaConcluida', logger: loggerNulo });

  const movimentos = [];
  const diretorio = {
    atualizar: async () => diretorio,
    ramalPorNome: (nome) => (/^V\d+$/.test(nome) ? nome.slice(1) : null),
    vendedoresGerenciados: () => ['1', '2'].map((ramal) => ({ nome: `V${ramal}`, chave: `V${ramal}`, ramal })),
    listarExcecoesRamal: () => [],
  };
  const discadora = { async moverPara(ramal, fila) { movimentos.push([ramal, fila]); return { resultado: Resultado.TRANSFERIDO }; } };
  const repositorio = { carregar: () => estadoVazio(), salvar: async () => {}, aguardarEscritas: async () => {} };
  const svc = new RoteamentoService({
    carrossel: new CarrosselService({ client, metrica: 'vendaConcluida', logger: loggerNulo }),
    discadora, repositorio, diretorio, relogio, regras: { metaDiaria: 50_000 }, logger: loggerNulo,
  }).inicializar();

  await assert.rejects(svc.executarCargaInicial(), /adiada/);

  await esteira.colar(esteiraCsv([['1', '10/10/2026', 'V1', '60.000,00'], ['2', '10/10/2026', 'V2', '40.000,00']]), HOJE);
  await svc.executarCargaInicial();
  assert.deepEqual(movimentos, [['1', 'URA'], ['2', 'ATIVO']]);

  await esteira.colar(esteiraCsv([['3', '13/10/2026', 'V2', '1.500,00']]), HOJE);
  assert.equal((await svc.monitorarVendas()).promovidos, 1);
  assert.deepEqual(movimentos.at(-1), ['2', 'URA']);
});

// ───────────── HTTP ─────────────

test('GET /manual devolve a página; POST /manual exige token, aceita esteira grande e resume', async (t) => {
  const esteira = new EsteiraManualRepository({ arquivo: tmp(), logger: loggerNulo });
  const controllers = criarControllers({ roteamento: {}, esteira, relogio: { hoje: () => HOJE }, metaDiaria: 50_000, logger: loggerNulo });
  const srv = criarServidor({ controllers, cfg: { tokenAdmin: 'segredo', limiteCorpoBytes: 100 }, logger: loggerNulo });
  const base = await new Promise((r) => srv.listen(0, () => r(`http://127.0.0.1:${srv.address().port}`)));
  t.after(() => srv.close());

  const pagina = await fetch(`${base}/manual`);
  assert.match(pagina.headers.get('content-type'), /text\/html/);
  assert.match(await pagina.text(), /Esteira colada/);

  const enviar = (texto, headers = { Authorization: 'Bearer segredo' }) => fetch(`${base}/manual`, {
    method: 'POST', headers, body: JSON.stringify({ texto }),
  });
  assert.equal((await enviar('x', {})).status, 401);
  assert.equal((await enviar('Agente;Valor Contrato\nV1;1,00')).status, 422);

  const linhas = Array.from({ length: 5000 }, (_, i) => [String(i), i % 2 ? '13/10/2026' : '10/10/2026', `V${i % 3}`, '20,00']);
  const resposta = await enviar(esteiraCsv(linhas));
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.vendas, 5000);
  assert.equal(corpo.diaAnterior, '10/10/2026');
  assert.deepEqual(corpo.diasColados, ['10/10/2026', '13/10/2026']);
  assert.equal(corpo.vendeuHoje.length, 3);
});

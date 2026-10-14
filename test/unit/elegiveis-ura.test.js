'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { elegiveisDoEstado } = require('../../src/domain/rodizio');
const { ElegiveisUra } = require('../../src/rodizio/elegiveis-ura');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const HOJE = '2026-10-14';
const AGORA = new Date('2026-10-14T15:00:00Z'); // 12:00 em São Paulo
const estado = (data, vendedores) => ({ versao: 2, data, vendedores });

test('elegiveisDoEstado: só a fila URA do dia; outro dia ou sem estado = sem lista', () => {
  const vendedores = { 1001: { fila: 'URA' }, 1002: { fila: 'ATIVO' }, 1003: { fila: 'URA', promovidoNoDia: true } };
  assert.deepEqual([...elegiveisDoEstado(estado(HOJE, vendedores), HOJE)], ['1001', '1003']);
  assert.equal(elegiveisDoEstado(estado('2026-10-13', vendedores), HOJE), null, 'arquivo de ontem');
  assert.equal(elegiveisDoEstado(null, HOJE), null);
  assert.equal(elegiveisDoEstado({ data: HOJE }, HOJE), null, 'formato inesperado');
  assert.equal(elegiveisDoEstado(estado(HOJE, { 1002: { fila: 'ATIVO' } }), HOJE).size, 0, 'lista do dia vazia: ninguém sobe');
});

test('ElegiveisUra: lê o state-vendas.json; sem a lista do dia só os fixos sobem; registra quem entra (venda hoje)', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'elegiveis-'));
  const arquivo = path.join(pasta, 'state-vendas.json');
  const infos = [];
  const avisos = [];
  const logger = { ...loggerNulo, info: (m) => infos.push(m), aviso: (m) => avisos.push(m) };
  const elegiveis = new ElegiveisUra({ arquivo, fusoHorario: 'America/Sao_Paulo', logger, fixos: async () => new Set(['3000']) });
  try {
    await elegiveis.atualizar(AGORA);
    assert.equal(elegiveis.permite('1002'), false, 'sem arquivo: quem não é fixo fica no Ativo');
    assert.equal(elegiveis.permite('3000'), true, 'o fixo sobe');
    assert.deepEqual(elegiveis.resumo(), { disponivel: false, total: 1 });
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /Só os fixos sobem para a URA \(1\)/);
    await elegiveis.atualizar(AGORA);
    assert.equal(avisos.length, 1, 'avisa uma vez só');

    fs.writeFileSync(arquivo, JSON.stringify(estado(HOJE, { 1001: { fila: 'URA', grupoAtivoAnterior: 20 }, 1002: { fila: 'ATIVO' } })));
    await elegiveis.atualizar(AGORA);
    assert.equal(elegiveis.grupoDeOrigem('1001'), 20);
    assert.equal(elegiveis.grupoDeOrigem('1002'), null);
    assert.equal(elegiveis.permite('1001'), true);
    assert.equal(elegiveis.permite('1002'), false);
    assert.deepEqual(elegiveis.resumo(), { disponivel: true, total: 1 });
    assert.match(infos.at(-1), /Elegíveis para a URA: 1 /);

    // O roteador promove o 1002 (vendeu hoje): o arquivo muda e ele passa a poder subir.
    fs.writeFileSync(arquivo, JSON.stringify(estado(HOJE, { 1001: { fila: 'URA' }, 1002: { fila: 'URA' } })));
    fs.utimesSync(arquivo, new Date(), new Date(Date.now() + 5000));
    await elegiveis.atualizar(AGORA);
    assert.equal(elegiveis.permite('1002'), true);
    assert.match(infos.at(-1), /Elegíveis para a URA: 2 .*novos: 1002/);

    // Virou o dia e o roteador ainda não fez a carga: só os fixos.
    await elegiveis.atualizar(new Date('2026-10-15T12:00:00Z'));
    assert.equal(elegiveis.permite('1001'), false);
    assert.equal(elegiveis.permite('3000'), true);
    assert.equal(avisos.length, 2);
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('rodízio: no Ativo, só elegível é lido (e pode subir); sem o filtro de elegíveis, todos', async () => {
  const lidos = [];
  const criar = (elegiveis) => {
    const svc = new RodizioService({
      client: { statusOperador: async (ramal) => { lidos.push(ramal); return null; } },
      transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo, elegiveis,
      cfg: { grupoUraId: 2, concorrencia: 5, descricoesStatus: { livres: ['livre'], atendimento: ['em atendimento'] } },
    });
    svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['1001', '1002'] }];
    return svc;
  };
  const so1001 = { atualizar: async () => {}, permite: (r) => r === '1001' };

  await criar(so1001).cicloAtivo();
  assert.deepEqual(lidos, ['1001'], 'o 1002 não é elegível: nem lê o status');

  lidos.length = 0;
  await criar(null).cicloAtivo();
  assert.deepEqual(lidos.sort(), ['1001', '1002']);
});

test('resolverFixos: ramais, nomes e equipes; quem não bate vira aviso', () => {
  const { resolverFixos } = require('../../src/integrations/argus/fixos');
  const diretorio = {
    ramalPorNome: (nome) => ({ 'MARIA SOUZA': '1004' }[nome] ?? null),
    ramaisDaEquipe: (nome) => (nome === 'ROBSON JUNIOR'
      ? { supervisor: { nome }, candidatos: [{ nome }], ramais: ['2001', '2002'] }
      : { supervisor: null, candidatos: [], ramais: [] }),
  };
  const r = resolverFixos(diretorio, { fixosUra: ['1003', 'MARIA SOUZA', 'FULANO'], equipesFixasUra: ['ROBSON JUNIOR', 'NINGUEM'] });
  assert.deepEqual([...r.ramais].sort(), ['1003', '1004', '2001', '2002']);
  assert.deepEqual(r.faltando.map((f) => [f.onde, f.item]), [['OPERADORES_FIXOS_URA', 'FULANO'], ['EQUIPES_FIXAS_URA', 'NINGUEM']]);

  const fora = resolverFixos({ ramalPorNome: () => { throw new Error('sem diretório'); } }, { fixosUra: ['1003', 'MARIA'] });
  assert.deepEqual([...fora.ramais], ['1003'], 'ramal numérico não depende do diretório');
  assert.match(fora.faltando[0].motivo, /diretório da Argus indisponível/);
});

test('rodízio: sem o grupo do supervisor, volta ao grupo de onde o roteador tirou (se for do Ativo)', async () => {
  const origem = { 3001: 20, 3002: 2 };
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo, cfg: { gruposAtivosIds: [20, 21] },
    diretorio: { atualizar: async () => {}, grupoAtivoDoOperador: (r) => (r === '3003' ? 21 : null) },
    elegiveis: { grupoDeOrigem: (r) => origem[r] ?? null },
  });
  assert.equal(await svc.grupoDeVolta('3003'), 21, 'o do supervisor vem primeiro');
  assert.equal(await svc.grupoDeVolta('3001'), 20);
  assert.equal(await svc.grupoDeVolta('3002'), null, 'origem fora do Ativo (era a URA) não serve');
  assert.equal(await svc.grupoDeVolta('3004'), null);
});

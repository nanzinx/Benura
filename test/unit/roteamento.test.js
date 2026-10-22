'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoteamentoService, CargaInicialError } = require('../../src/services/roteamento.service');
const { Resultado } = require('../../src/integrations/argus/discadora.service');
const { distribuirCargaInicial } = require('../../src/domain/regras-roteamento');
const { estadoVazio } = require('../../src/repositories/estado.repository');
const { loggerNulo } = require('../../src/utils/logger');

const relogio = { hoje: () => '2026-10-08' };

function montar({ ontem = [], hoje = [], falharRamais = [], cadastrados = [], fixosUra = [], equipesFixasUra = [], equipes = {}, retencao = { ativa: false } } = {}) {
  const movimentos = [];
  const salvos = [];
  const vendas = { ontem, hoje };
  const carrossel = {
    async listarVendas(periodo) {
      if (vendas[periodo] === null) throw new Error('Carrossel fora');
      return { vendedores: vendas[periodo], naoCadastrados: [], diaOntem: '07/10/2026', origem: 'api' };
    },
  };
  // Diretório da Argus: nome "V<ramal>" → ramal; `cadastrados` = operadores na URA/Ativo.
  const diretorio = {
    atualizar: async () => diretorio,
    ramalPorNome: (nome) => (/^V\d+$/.test(nome) ? nome.slice(1) : null),
    vendedoresGerenciados: () => cadastrados.map((ramal) => ({ nome: `V${ramal}`, chave: `V${ramal}`, ramal })),
    listarExcecoesRamal: () => [],
    operadorPorRamal: (ramal) => ({ nome: `V${ramal}`, ramal }),
    ramaisDaEquipe: (nome) => (equipes[nome]
      ? { supervisor: { nome }, candidatos: [{ nome }], ramais: equipes[nome] }
      : { supervisor: null, candidatos: [], ramais: [] }),
  };
  const discadora = {
    async moverPara(ramal, fila) {
      movimentos.push([ramal, fila]);
      return falharRamais.includes(ramal)
        ? { resultado: Resultado.FALHA, erro: 'x' }
        : { resultado: Resultado.TRANSFERIDO, grupoAnterior: 1 };
    },
  };
  const repositorio = {
    carregar: () => estadoVazio(),
    salvar: async (e) => { salvos.push(JSON.parse(JSON.stringify(e))); },
    aguardarEscritas: async () => {},
  };
  const svc = new RoteamentoService({
    carrossel, discadora, repositorio, diretorio, relogio, regras: { metaDiaria: 50_000, fixosUra, equipesFixasUra }, logger: loggerNulo,
    retencao: () => retencao,
  }).inicializar();
  return { svc, movimentos, salvos, vendas, retencao };
}

const v = (ramal, totalVendas) => ({ ramal, nome: `V${ramal}`, equipe: 'E', totalVendas });

test('regra: só quem vendeu MAIS que a meta vai para a URA', () => {
  const { ura, ativo } = distribuirCargaInicial([v('1', 50_000.01), v('2', 50_000), v('3', 0)], 50_000);
  assert.deepEqual(ura.map((x) => x.ramal), ['1']);
  assert.deepEqual(ativo.map((x) => x.ramal), ['2', '3']);
});

test('carga inicial distribui e marca o dia', async () => {
  const { svc, movimentos } = montar({ ontem: [v('1', 72_500), v('2', 50_000)] });
  const r = await svc.executarCargaInicial();
  assert.deepEqual(r, { ura: 1, ativo: 1, falhas: 0 });
  assert.deepEqual(movimentos, [['1', 'URA'], ['2', 'ATIVO']]);
  assert.ok(svc.cargaInicialFeitaHoje());
});

test('operador da Argus sem venda ontem (fora da lista do Carrossel) vai para o Ativo', async () => {
  const { svc, movimentos } = montar({ ontem: [v('1', 72_500)], cadastrados: ['1', '7'] });
  const r = await svc.executarCargaInicial();
  assert.deepEqual(r, { ura: 1, ativo: 1, falhas: 0 });
  assert.deepEqual(movimentos, [['1', 'URA'], ['7', 'ATIVO']]);
  assert.equal(svc.estado.vendedores['7'].vendaOntem, 0);
});

test('regra: fixo vai para a URA com ou sem venda', () => {
  const { ura, ativo } = distribuirCargaInicial([{ ...v('1', 0), fixo: true }, v('2', 10)], 50_000);
  assert.deepEqual(ura.map((x) => x.ramal), ['1']);
  assert.deepEqual(ativo.map((x) => x.ramal), ['2']);
});

test('carga inicial: fixos (por ramal ou nome) vão para a URA mesmo sem venda; nome desconhecido é ignorado', async () => {
  const { svc, movimentos } = montar({
    ontem: [v('1', 72_500), v('2', 10)], cadastrados: ['1', '2', '7'], fixosUra: ['7', 'V2', 'Fulano Sem Ramal'],
  });
  const r = await svc.executarCargaInicial();
  assert.deepEqual(r, { ura: 3, ativo: 0, falhas: 0 });
  assert.deepEqual(movimentos.sort(), [['1', 'URA'], ['2', 'URA'], ['7', 'URA']]);
  assert.equal(svc.estado.vendedores['7'].fixo, true);
  assert.equal(svc.estado.vendedores['1'].fixo, false);
});

test('carga inicial: equipe fixa (EQUIPES_FIXAS_URA) vai inteira para a URA, com ou sem venda', async () => {
  const { svc, movimentos } = montar({
    ontem: [v('1', 72_500), v('2', 10)], cadastrados: ['1', '2', '3', '4'],
    equipesFixasUra: ['ROBSON JUNIOR', 'SUPERVISOR INEXISTENTE'], equipes: { 'ROBSON JUNIOR': ['3', '4'] },
  });
  const r = await svc.executarCargaInicial();
  assert.deepEqual(r, { ura: 3, ativo: 1, falhas: 0 });
  assert.deepEqual(movimentos.filter(([, fila]) => fila === 'URA').map(([ramal]) => ramal).sort(), ['1', '3', '4']);
  assert.equal(svc.estado.vendedores['3'].fixo, true, 'na lista de elegíveis do dia: volta à URA ao atender no Ativo');
});

test('carga inicial: fixo fora da URA/Ativo e do Carrossel entra pelo ramal', async () => {
  const { svc, movimentos } = montar({ ontem: [v('1', 10)], fixosUra: ['9'] });
  await svc.executarCargaInicial();
  assert.deepEqual(movimentos, [['9', 'URA'], ['1', 'ATIVO']]);
  assert.equal(svc.estado.vendedores['9'].nome, 'V9');
});

test('carga adiada: os fixos vão para a URA assim mesmo, uma vez por dia', async () => {
  const { svc, movimentos, vendas } = montar({ ontem: null, fixosUra: ['7', 'V8'] });
  await assert.rejects(svc.executarCargaInicial(), CargaInicialError);
  await assert.rejects(svc.executarCargaInicial(), CargaInicialError);
  assert.deepEqual(movimentos, [['7', 'URA'], ['8', 'URA']]);
  assert.ok(!svc.cargaInicialFeitaHoje());

  vendas.ontem = [v('1', 10)];
  await svc.executarCargaInicial();
  assert.deepEqual(movimentos.slice(2), [['7', 'URA'], ['8', 'URA'], ['1', 'ATIVO']]);
});

test('carga inicial é adiada (sem marcar o dia) se o Carrossel falhar ou vier vazio', async () => {
  const a = montar({ ontem: null });
  await assert.rejects(a.svc.executarCargaInicial(), CargaInicialError);
  assert.ok(!a.svc.cargaInicialFeitaHoje());

  const b = montar({ ontem: [] });
  await assert.rejects(b.svc.executarCargaInicial(), CargaInicialError);
  assert.ok(!b.svc.cargaInicialFeitaHoje());
});

test('monitoramento promove quem está no Ativo e vendeu hoje, uma única vez', async () => {
  const ctx = montar({ ontem: [v('1', 72_500), v('2', 100)], hoje: [v('1', 900), v('2', 0)] });
  await ctx.svc.executarCargaInicial();
  ctx.movimentos.length = 0;

  assert.equal((await ctx.svc.monitorarVendas()).promovidos, 0);

  ctx.vendas.hoje = [v('1', 900), v('2', 1)];
  assert.equal((await ctx.svc.monitorarVendas()).promovidos, 1);
  assert.deepEqual(ctx.movimentos, [['2', 'URA']]);
  assert.equal(ctx.svc.estado.vendedores['2'].promovidoNoDia, true);

  // Já está na URA: nova venda não gera nova transferência.
  ctx.vendas.hoje = [v('2', 5000)];
  assert.equal((await ctx.svc.monitorarVendas()).promovidos, 0);
  assert.equal(ctx.movimentos.length, 1);
});

test('monitoramento não faz nada antes da carga inicial', async () => {
  const { svc, movimentos } = montar({ hoje: [v('1', 10)] });
  const r = await svc.monitorarVendas();
  assert.equal(r.ignorado, 'carga inicial pendente');
  assert.equal(movimentos.length, 0);
});

test('transferência que falhou é re-tentada no próximo ciclo', async () => {
  const ctx = montar({ ontem: [v('1', 72_500)], hoje: [], falharRamais: ['1'] });
  const r = await ctx.svc.executarCargaInicial();
  assert.equal(r.falhas, 1);
  assert.equal(ctx.svc.resumo().pendentes[0], '1');

  await ctx.svc.monitorarVendas();
  assert.deepEqual(ctx.movimentos, [['1', 'URA'], ['1', 'URA']]);
});

test('webhook valida entrada e promove vendedor do Ativo', async () => {
  const ctx = montar({ ontem: [v('4', 10)] });
  await ctx.svc.executarCargaInicial();

  assert.equal((await ctx.svc.registrarVenda({ ramal: '4', valor: 0 })).aceito, false);
  const r = await ctx.svc.registrarVenda({ ramal: 4, valor: '1.500,00' });
  assert.deepEqual(r, { aceito: true, promovido: true });
  assert.equal(ctx.svc.estado.vendedores['4'].vendaQueDisparou, 1500);
});

test('vendedor do Carrossel sem ramal na Argus é ignorado', async () => {
  const ctx = montar({ ontem: [v('1', 10), { nome: 'DESCONHECIDO', chave: 'DESCONHECIDO', equipe: 'E', totalVendas: 99_999 }] });
  const r = await ctx.svc.executarCargaInicial();
  assert.deepEqual(r, { ura: 0, ativo: 1, falhas: 0 });
});

test('vendedor novo (fora da carga) que vende é promovido', async () => {
  const ctx = montar({ ontem: [v('1', 10)], hoje: [v('99', 300)] });
  await ctx.svc.executarCargaInicial();
  ctx.movimentos.length = 0;
  await ctx.svc.monitorarVendas();
  assert.deepEqual(ctx.movimentos, [['99', 'URA']]);
});

test('carga inicial: quem vai para a URA guarda o grupo de onde saiu (volta do rodízio sem supervisor)', async () => {
  const { svc } = montar({ ontem: [v('1', 72_500), v('2', 10)] });
  await svc.executarCargaInicial();
  assert.equal(svc.estado.vendedores['1'].grupoAtivoAnterior, 1);
  assert.equal(svc.estado.vendedores['2'].grupoAtivoAnterior, undefined, 'foi para o Ativo: não precisa');
});

test('[NOVO] rodízio pausado (todos no Ativo): venda e carga registram a URA, mas ninguém sobe; os fixos sobem; ao retomar, sobe', async () => {
  const retencao = { ativa: true };
  const ctx = montar({ ontem: [v('1', 72_500), v('2', 100), v('9', 0)], hoje: [], retencao, fixosUra: ['9'] });
  await ctx.svc.executarCargaInicial();
  assert.deepEqual(ctx.movimentos.filter(([, fila]) => fila === 'URA'), [['9', 'URA']], 'só o fixo sobe na carga');
  assert.equal(ctx.svc.estado.vendedores['1'].fila, 'URA', 'a decisão fica registrada');
  assert.equal(ctx.svc.estado.vendedores['1'].ultimoResultado, 'RETIDO_NO_ATIVO');

  ctx.movimentos.length = 0;
  ctx.vendas.hoje = [v('2', 900)];
  await ctx.svc.monitorarVendas();
  await ctx.svc.monitorarVendas();
  assert.deepEqual(ctx.movimentos, [], 'venda nova não sobe ninguém');
  assert.equal(ctx.svc.estado.vendedores['2'].fila, 'URA');
  assert.equal(ctx.svc.estado.vendedores['2'].tentativasSync ?? 0, 0, 'não gasta tentativa');

  retencao.ativa = false; // retomaram
  await ctx.svc.monitorarVendas();
  assert.deepEqual(ctx.movimentos.map(([r]) => r).sort(), ['1', '2'], 'os pendentes sobem no próximo ciclo');
});

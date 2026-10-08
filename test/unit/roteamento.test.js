'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoteamentoService, CargaInicialError } = require('../../src/services/roteamento.service');
const { Resultado } = require('../../src/integrations/argus/discadora.service');
const { distribuirCargaInicial } = require('../../src/domain/regras-roteamento');
const { estadoVazio } = require('../../src/repositories/estado.repository');
const { loggerNulo } = require('../../src/utils/logger');

const relogio = { hoje: () => '2026-10-08', ontem: () => '2026-10-07' };

function montar({ ontem = [], hoje = [], falharRamais = [] } = {}) {
  const movimentos = [];
  const salvos = [];
  const vendas = { '2026-10-07': ontem, '2026-10-08': hoje };
  const carrossel = {
    async listarVendas(data) {
      if (vendas[data] === null) throw new Error('Carrossel fora');
      return { vendedores: vendas[data], origem: 'api' };
    },
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
    carrossel, discadora, repositorio, relogio, regras: { metaDiaria: 50_000 }, logger: loggerNulo,
  }).inicializar();
  return { svc, movimentos, salvos, vendas };
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

  ctx.vendas['2026-10-08'] = [v('1', 900), v('2', 1)];
  assert.equal((await ctx.svc.monitorarVendas()).promovidos, 1);
  assert.deepEqual(ctx.movimentos, [['2', 'URA']]);
  assert.equal(ctx.svc.estado.vendedores['2'].promovidoNoDia, true);

  // Já está na URA: nova venda não gera nova transferência.
  ctx.vendas['2026-10-08'] = [v('2', 5000)];
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

test('vendedor novo (fora da carga) que vende é promovido', async () => {
  const ctx = montar({ ontem: [v('1', 10)], hoje: [v('99', 300)] });
  await ctx.svc.executarCargaInicial();
  ctx.movimentos.length = 0;
  await ctx.svc.monitorarVendas();
  assert.deepEqual(ctx.movimentos, [['99', 'URA']]);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapearResposta, extrairLista } = require('../../src/integrations/carrossel/carrossel.mapper');
const { CarrosselService, CarrosselIndisponivelError } = require('../../src/integrations/carrossel/carrossel.service');
const { loggerNulo } = require('../../src/utils/logger');

test('extrairLista aceita vários envelopes', () => {
  assert.deepEqual(extrairLista([1]), [1]);
  assert.deepEqual(extrairLista({ data: [1] }), [1]);
  assert.deepEqual(extrairLista({ data: { vendedores: [1] } }), [1]);
  assert.deepEqual(extrairLista({ ranking: [1] }), [1]);
  assert.throws(() => extrairLista({ foo: 1 }), TypeError);
});

test('mapearResposta normaliza campos, soma por ramal e descarta sem ramal', () => {
  const { vendedores, descartados } = mapearResposta({
    data: [
      { id: 1, nome: ' Ana ', ramal: 1001, total_vendas: '10.000,00' },
      { vendedor: { nome: 'Ana', ramal: '1001' }, valor: 500 },
      { seller_id: 2, full_name: 'Bruno', extension: '1002', total_sales_amount: 7 },
      { nome: 'Sem ramal', total: 1 },
    ],
  });
  assert.equal(descartados, 1);
  assert.equal(vendedores.length, 2);
  const ana = vendedores.find((v) => v.ramal === '1001');
  assert.equal(ana.nome, 'Ana');
  assert.equal(ana.totalVendas, 10500);
  assert.deepEqual(vendedores.find((v) => v.ramal === '1002'),
    { id: 2, nome: 'Bruno', ramal: '1002', equipe: 'Sem equipe', totalVendas: 7 });
});

test('CarrosselService usa o último resultado válido quando a API cai', async () => {
  let falhar = false;
  const client = {
    async buscarVendasPorData() {
      if (falhar) throw new Error('ECONNREFUSED');
      return [{ ramal: '1', nome: 'A', total: 5 }];
    },
  };
  const svc = new CarrosselService({ client, logger: loggerNulo });

  const r1 = await svc.listarVendas('2026-10-08');
  assert.equal(r1.origem, 'api');

  falhar = true;
  const r2 = await svc.listarVendas('2026-10-08');
  assert.equal(r2.origem, 'fallback');
  assert.equal(r2.vendedores[0].totalVendas, 5);

  await assert.rejects(svc.listarVendas('2026-10-08', { permitirFallback: false }), CarrosselIndisponivelError);
  await assert.rejects(svc.listarVendas('2026-10-07'), CarrosselIndisponivelError);
});

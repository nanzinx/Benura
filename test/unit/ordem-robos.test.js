'use strict';
/** [NOVO] Robôs na ordem da supervisão: liga OPER VIRTUAL 1, 2… e os DTMF no fim; reduz do último ao primeiro. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ordenarRobos } = require('../../src/domain/rodizio');
const { ControleRobos } = require('../../src/rodizio/controle-robos');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const NOMES = {
  910: 'OPER VIRTUAL 10', 902: 'OPER VIRTUAL 2', 901: 'OPER VIRTUAL 1', 950: 'OPER VIRTUAL DTMF 1',
  900: 'OPER VIRTUAL 0', 951: 'OPER VIRTUAL DTMF 2', 903: 'OPER VIRTUAL 3',
};

test('ordem: pelo número do nome (0, 1, 2… 10), DTMF no fim; sem nome vale o ramal', () => {
  assert.deepEqual(ordenarRobos(Object.keys(NOMES), (r) => NOMES[r]), ['900', '901', '902', '903', '910', '950', '951']);
  assert.deepEqual(ordenarRobos(['905', '901', '903']), ['901', '903', '905']);
});

function montar(emLigacao = []) {
  const chamadas = [];
  const client = {
    statusOperador: async (r) => ({ nome: NOMES[r], descricaoStatus: emLigacao.includes(String(r)) ? 'em atendimento' : 'livre' }),
    logarOperadorVirtual: async (r) => { chamadas.push(`liga ${r}`); return { codStatus: 1 }; },
    deslogarOperador: async (r) => { chamadas.push(`desliga ${r}`); return { codStatus: 1 }; },
  };
  const robos = new ControleRobos({
    client, logger: loggerNulo,
    cfg: { dryRun: false, concorrencia: 3, degrauSubida: 10, descricoesStatus: { livres: ['livre'], atendimento: ['em atendimento'] } },
  });
  return { robos, chamadas };
}

test('aumentar: liga os próximos da ordem crescente, um após o outro', async () => {
  const { robos, chamadas } = montar();
  await robos.sincronizar(Object.keys(NOMES)); // lê os nomes; todos "livres" = ligados
  robos.ligados = new Set(['900']);
  await robos.aumentar(Object.keys(NOMES), 4, 'teste');
  assert.deepEqual(chamadas, ['liga 901', 'liga 902', 'liga 903']);
});

test('reduzir: tira do último para o primeiro e pula quem está em ligação', async () => {
  const { robos, chamadas } = montar(['951']);
  await robos.sincronizar(Object.keys(NOMES));
  await robos.reduzir(Object.keys(NOMES), 4, 'teste');
  assert.deepEqual(chamadas.sort(), ['desliga 903', 'desliga 910', 'desliga 950'], '951 (DTMF 2) em ligação fica; saem DTMF 1, 10 e 3');
});

test('robôs por livre no automático: o status da URA pesa (calma mais, agressiva menos, normal igual)', () => {
  const svc = Object.create(RodizioService.prototype);
  svc.cfg = { robosPorLivre: 7, robosFatorCalma: 1.3, robosFatorAgressiva: 0.7 };
  svc.ajuste = null;
  for (const [status, esperado] of [['calma', 9], ['agressiva', 5], ['normal', 7], [null, 7]]) {
    svc.statusAtualDaUra = () => status;
    assert.equal(svc.porLivreComStatus(), esperado, String(status));
  }
  svc.cfg.robosPorLivre = 1;
  svc.statusAtualDaUra = () => 'agressiva';
  assert.equal(svc.porLivreComStatus(), 1, 'nunca menos de 1');
});

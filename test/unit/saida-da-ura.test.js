'use strict';
/** [NOVO] Painel do receptivo: quanto falta para cada livre da URA voltar ao Ativo, ou por que não volta. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { saidaDaUra, Classe } = require('../../src/domain/rodizio');
const { RodizioService } = require('../../src/rodizio/rodizio.service');

const AGORA = 1_000_000;
const livre = (x = {}) => ({ classe: Classe.LIVRE, livreDesde: AGORA - 75_000, agora: AGORA, limiteMs: 120_000, ...x });

test('saidaDaUra: livre comum conta o tempo até o limite (com a escada de antiguidade)', () => {
  assert.deepEqual(saidaDaUra(livre()), { emMs: 45_000, limiteMs: 120_000, motivo: null });
  assert.deepEqual(saidaDaUra(livre({ livreDesde: AGORA - 200_000 })), { emMs: 0, limiteMs: 120_000, motivo: null }, 'passou do limite: sai no próximo ciclo');
});

test('saidaDaUra: o motivo de ficar, na mesma ordem da regra do ocioso', () => {
  assert.equal(saidaDaUra(livre({ emTransferencia: true })).motivo, 'em transferência');
  assert.deepEqual(saidaDaUra(livre({ supervisor: true, fixo: true })), { emMs: 0, limiteMs: 120_000, motivo: 'conta de supervisor' }, 'supervisor sai já, mesmo fixo');
  assert.equal(saidaDaUra(livre({ supervisor: true, travadoUra: true })).motivo, 'travado à mão', 'posto à mão: fica');
  assert.deepEqual(saidaDaUra(livre({ fixo: true })), { emMs: null, limiteMs: 120_000, motivo: 'fixo' });
  assert.deepEqual(saidaDaUra(livre({ travadoUra: true })), { emMs: null, limiteMs: 120_000, motivo: 'travado à mão' });
  assert.deepEqual(saidaDaUra(livre({ livreDesde: AGORA - 200_000, semGrupo: true })), { emMs: 0, limiteMs: 120_000, motivo: 'sem grupo do Ativo' });
});

test('saidaDaUra: só para quem está livre', () => {
  assert.equal(saidaDaUra(livre({ classe: Classe.ATENDIMENTO })), null);
  assert.equal(saidaDaUra(livre({ classe: Classe.OUTRO })), null);
});

test('uraAgora: cada livre leva a saída; fixo e travado com o motivo', () => {
  const svc = Object.create(RodizioService.prototype);
  const agora = Date.now();
  Object.assign(svc, {
    cfg: {}, ramaisRobos: [], ramaisUra: new Set(['201', '202', '203']), permanentes: new Set(['202']), emTransferencia: new Set(), semGrupoAvisados: new Set(),
    statusUra: new Map([
      ['201', { classe: Classe.LIVRE, livreDesde: agora - 30_000 }],
      ['202', { classe: Classe.LIVRE, livreDesde: agora - 30_000 }],
      ['203', { classe: Classe.ATENDIMENTO }],
    ]),
  });
  svc.travadoEm = () => null;
  svc.limiteOciosoMs = () => 120_000;
  const porRamal = Object.fromEntries(svc.uraAgora().map((o) => [o.ramal, o.saida]));
  assert.equal(porRamal['201'].motivo, null);
  assert.ok(porRamal['201'].emMs > 85_000 && porRamal['201'].emMs <= 90_000);
  assert.equal(porRamal['202'].motivo, 'fixo');
  assert.equal(porRamal['203'], null);
});

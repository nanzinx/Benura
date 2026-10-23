'use strict';
/** [NOVO] Modo dos robôs pelo painel: automático, só pânico ou desligados. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ModoRobos } = require('../../src/rodizio/modo-robos');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

test('ModoRobos: começa no ROBOS_MODO, grava a escolha, recarrega e recusa modo inválido', () => {
  let gravado = null;
  const m = new ModoRobos({ arquivo: null, padrao: 'panico', logger: loggerNulo });
  m.repositorio = { carregar: () => gravado, salvar: (x) => { gravado = x; } };
  assert.equal(m.carregar().modo, 'panico');
  assert.deepEqual(m.definir('desligados', 'ana'), { mudou: true });
  assert.deepEqual(m.definir('desligados', 'ana'), { mudou: false });
  assert.deepEqual([gravado.modo, gravado.por], ['desligados', 'ana']);
  const outro = new ModoRobos({ arquivo: null, padrao: 'automatico', logger: loggerNulo });
  outro.repositorio = { carregar: () => gravado };
  assert.equal(outro.carregar().modo, 'desligados', 'reinício mantém a escolha');
  assert.throws(() => m.definir('turbo'), /modo deve ser/);
});

/** Rodízio com 1 humano livre na URA e robôs 900 (livre) e 901 (em ligação) ligados. */
function montar(modo = 'automatico') {
  const comandos = [];
  const robos = {
    ligados: new Set(['900', '901']),
    situacao: () => ({ ligados: robos.ligados.size, total: 3, ultimaReducao: 0, ultimoAumento: 0 }),
    resumo: () => ({}),
    encerrarSemDerrubar: async (motivo) => { comandos.push(`encerrar: ${motivo}`); robos.ligados.delete('900'); },
    reduzir: async () => comandos.push('reduzir'),
    aumentar: async () => comandos.push('aumentar'),
    desligar: async () => comandos.push('desligar'),
  };
  const svc = new RodizioService({
    client: {}, transferencias: {}, robos, repositorio: { salvar: () => {} }, logger: loggerNulo,
    modoRobos: new ModoRobos({ arquivo: null, padrao: modo, logger: loggerNulo }),
    cfg: { robosModo: modo, pollUraMs: 5000, tempoNaUraMs: 180_000, robosPorLivre: 3, reativarRobos: true, minRobosDesligadosMs: 0 },
  });
  svc.ramaisUra = new Set(['200']);
  svc.ramaisRobos = ['900', '901', '902'];
  svc.statusUra.set('200', { classe: Classe.LIVRE, ts: Date.now(), livreDesde: Date.now() - 1000 });
  return { svc, comandos };
}

test('desligados: os parados saem, quem está em ligação fica até terminar, ninguém é ligado; voltar ao automático liga', async () => {
  const { svc, comandos } = montar('automatico');
  assert.deepEqual(svc.definirModoRobos('desligados', 'ana'), { mudou: true, modo: 'desligados' });
  await svc.avaliarRobos();
  await svc.avaliarRobos();
  assert.ok(comandos.every((c) => c === 'encerrar: robôs desligados pelo painel'), comandos.join(' | '));
  assert.ok(!comandos.includes('aumentar'));
  assert.equal(svc.resumo().robos.modo, 'desligados');
  assert.equal(svc.resumo().robos.modoPor, 'ana');

  comandos.length = 0;
  svc.robos.ligados = new Set();
  svc.definirModoRobos('automatico', 'ana');
  await svc.avaliarRobos();
  assert.deepEqual(comandos, ['aumentar'], 'automático: 1 livre × 3 robôs');
  assert.equal(svc.emModoPanico(), false);
  svc.definirModoRobos('panico');
  assert.equal(svc.emModoPanico(), true);
});

test('rota PUT /robos/modo: 200 com quem pediu, 400 com modo inválido', async () => {
  const { svc } = montar('panico');
  const rota = criarRotasDoRodizio({ rodizio: svc, ciclos: {}, logger: loggerNulo }).find((r) => r.caminho === '/robos/modo');
  assert.equal(rota.metodo, 'PUT');
  assert.equal(rota.protegida, true);
  assert.equal((await rota.handler({ corpo: { modo: 'desligados', por: 'ana' } })).status, 200);
  assert.equal((await rota.handler({ corpo: { modo: 'x' } })).status, 400);
});

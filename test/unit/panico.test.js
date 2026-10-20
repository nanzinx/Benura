'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Interruptor } = require('../../src/rodizio/interruptor');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

/** Robôs falsos: registram o que o BenURA mandou fazer. */
function robosFalsos(ligados = ['900', '901']) {
  const chamadas = [];
  return {
    chamadas,
    ligados: new Set(ligados),
    situacao(total) { return { ligados: this.ligados.size, total, ultimaReducao: 0, ultimoAumento: 0 }; },
    resumo() { return { ligados: this.ligados.size, alvo: null }; },
    async sincronizar() { chamadas.push('sincronizar'); },
    async desligar(ramais, motivo) { chamadas.push(`desligar ${ramais.join(',')} (${motivo})`); this.ligados.clear(); },
    async encerrarSemDerrubar(motivo) { chamadas.push(`encerrarSemDerrubar (${motivo})`); },
    async aumentar() { chamadas.push('aumentar'); },
    async reduzir() { chamadas.push('reduzir'); },
  };
}

function montar({ livres, panicoLigado = true, robos = robosFalsos(), ajuste = null }) {
  const avisos = [];
  const logger = { ...loggerNulo, aviso: (m) => avisos.push(m), info: (m) => avisos.push(m) };
  const panico = new Interruptor({ nome: 'Pânico', arquivo: null, padrao: panicoLigado, logger });
  const svc = new RodizioService({
    client: {}, transferencias: {}, robos, repositorio: {}, logger, ajuste, panico,
    cfg: { robosModo: 'panico', pollUraMs: 5000 },
  });
  const agora = Date.now();
  const ramais = ['201', '202', '203'];
  svc.ramaisUra = new Set(ramais);
  svc.ramaisRobos = ['900', '901', '902'];
  ramais.forEach((r, i) => svc.statusUra.set(r, { classe: i < livres ? Classe.LIVRE : Classe.ATENDIMENTO, ts: agora }));
  return { svc, robos, avisos };
}

test('pânico: com 1 livre, para de discar sem derrubar ligação; lê os robôs ligados pela supervisão antes', async () => {
  const { svc, robos, avisos } = montar({ livres: 1 });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, ['sincronizar', 'encerrarSemDerrubar (PÂNICO: 1 livre(s) na URA)']);
  assert.ok(avisos.some((m) => /^PÂNICO: 1 livre/.test(m)));
  assert.ok(svc.resumo().panico.ativoAgora, 'o /health mostra o pânico ativo');

  await svc.avaliarRobos();
  assert.equal(robos.chamadas.filter((c) => c === 'sincronizar').length, 1, 'só relê os robôs ao entrar no pânico');
});

test('pânico: sem nenhum livre, desliga todos os ligados (inclusive em ligação)', async () => {
  const { svc, robos } = montar({ livres: 0 });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, ['sincronizar', 'desligar 900,901 (PÂNICO: 0 livre(s) na URA)']);
});

test('pânico: com 2 livres não mexe; ao sair do pânico avisa; o BenURA nunca liga robôs', async () => {
  const { svc, robos, avisos } = montar({ livres: 1 });
  await svc.avaliarRobos();
  svc.statusUra.set('202', { classe: Classe.LIVRE, ts: Date.now() });
  robos.chamadas.length = 0;
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, [], 'com 2 livres o BenURA não liga nem desliga');
  assert.ok(avisos.some((m) => /PÂNICO encerrado \(2 livre/.test(m)));
  assert.equal(svc.resumo().panico.ativoAgora, null);
});

test('pânico: interruptor desligado = o BenURA não mexe nos robôs, nem com 0 livre', async () => {
  const { svc, robos } = montar({ livres: 0, panicoLigado: false });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, []);
  const r = svc.definirPanico(true);
  assert.equal(r.mudou, true);
  assert.equal(r.ligado, true);
});

test('pânico: callback só é registrado (sem ajuste dos robôs) e a URA passiva não roda', async () => {
  const ajustes = [];
  const ajuste = { registrarCallback: () => { ajustes.push('callback'); return true; }, subirPorPassividade: () => { ajustes.push('passiva'); return true; } };
  const { svc } = montar({ livres: 3, ajuste });
  svc.registrarCallback({ motivo: 'abandonou a fila', chave: null }, 'teste');
  svc.cicloUra = svc.cicloUra.bind(svc);
  svc.atualizarStatusUra = async () => {};
  svc.deveDevolver = () => false;
  await svc.cicloUra();
  assert.deepEqual(ajustes, []);
});

test('interruptor: mantém a escolha da supervisão; sem escolha, vale o padrão', () => {
  let gravado = null;
  const i = new Interruptor({ nome: 'X', arquivo: null, padrao: true, logger: loggerNulo });
  i.repositorio = { carregar: () => gravado, salvar: (e) => { gravado = e; } };
  assert.equal(i.carregar().ligado(), true);
  assert.equal(i.definir(false), true);
  assert.equal(i.definir(false), false, 'já estava desligado');
  const outro = new Interruptor({ nome: 'X', arquivo: null, padrao: true, logger: loggerNulo });
  outro.repositorio = { carregar: () => gravado, salvar: () => {} };
  assert.equal(outro.carregar().ligado(), false, 'reinício mantém desligado');
});

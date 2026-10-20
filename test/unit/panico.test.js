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

const TEMPO_MIN = 180_000;

/** URA com 3 humanos: os `livres` primeiros estão livres há `livreHaMs`. */
function montar({ livres, panicoLigado = true, robos = robosFalsos(), ajuste = null, livreHaMs = 0, fixos = [], passiva = false }) {
  const avisos = [];
  const logger = { ...loggerNulo, aviso: (m) => avisos.push(m), info: (m) => avisos.push(m) };
  const panico = new Interruptor({ nome: 'Pânico', arquivo: null, padrao: panicoLigado, logger });
  const uraPassiva = new Interruptor({ nome: 'URA passiva hoje', arquivo: null, padrao: passiva, logger });
  const svc = new RodizioService({
    client: {}, transferencias: {}, robos, repositorio: {}, logger, ajuste, panico, uraPassiva,
    cfg: { robosModo: 'panico', pollUraMs: 5000, tempoNaUraMs: TEMPO_MIN, panicoAntesDeSairMs: 60_000 },
  });
  const agora = Date.now();
  const ramais = ['201', '202', '203'];
  svc.ramaisUra = new Set(ramais);
  svc.ramaisRobos = ['900', '901', '902'];
  svc.permanentes = new Set(fixos);
  ramais.forEach((r, i) => svc.statusUra.set(r, i < livres
    ? { classe: Classe.LIVRE, ts: agora, livreDesde: agora - livreHaMs }
    : { classe: Classe.ATENDIMENTO, ts: agora }));
  return { svc, robos, avisos };
}

test('pânico: 1 livre comum longe de sair, os robôs seguem; a 60 s de sair, param sem derrubar ligação', async () => {
  const { svc, robos, avisos } = montar({ livres: 1, livreHaMs: 60_000 });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, [], 'faltam 2 min para ele sair');
  assert.equal(svc.resumo().panico.ativoAgora, null);

  svc.statusUra.get('201').livreDesde = Date.now() - (TEMPO_MIN - 50_000); // sai em 50 s
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, ['sincronizar', 'encerrarSemDerrubar (PÂNICO: 1 livre na URA (201) e ele sai por ociosidade em até 60 s)']);
  assert.ok(avisos.some((m) => /^PÂNICO: 1 livre na URA \(201\).*desligando os robôs \(os em ligação terminam antes\)/.test(m)));
  const { panico } = svc.resumo();
  assert.ok(panico.ativoAgora, 'o /health mostra o pânico ativo');
  assert.match(panico.motivo, /sai por ociosidade/);

  await svc.avaliarRobos();
  assert.equal(robos.chamadas.filter((c) => c === 'sincronizar').length, 1, 'só relê os robôs ao entrar no pânico');
});

test('pânico: 1 livre fixo (nunca sai) desliga os parados na hora; com a URA passiva hoje, os robôs seguem', async () => {
  const comum = montar({ livres: 1, fixos: ['201'] });
  await comum.svc.avaliarRobos();
  assert.deepEqual(comum.robos.chamadas, ['sincronizar', 'encerrarSemDerrubar (PÂNICO: 1 livre na URA (201, fixo) e a URA não está passiva hoje)']);

  const { svc, robos } = montar({ livres: 1, fixos: ['201'], passiva: true, livreHaMs: 10 * 60_000 });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, [], 'fixo livre e URA passiva: os robôs seguem até ele atender');
  assert.equal(svc.resumo().panico.uraPassiva.ligado, true);

  svc.statusUra.set('201', { classe: Classe.ATENDIMENTO, ts: Date.now() }); // atendeu: sobra 0 livre
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, ['sincronizar', 'desligar 900,901 (PÂNICO: 0 livre na URA)']);
});

test('pânico: sem nenhum livre, desliga todos os ligados (inclusive em ligação), mesmo com a URA passiva', async () => {
  const { svc, robos } = montar({ livres: 0, passiva: true });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas, ['sincronizar', 'desligar 900,901 (PÂNICO: 0 livre na URA)']);
});

test('pânico: de "1 livre saindo" para "0 livre" avisa de novo e derruba os que estavam em ligação', async () => {
  const { svc, robos, avisos } = montar({ livres: 1, livreHaMs: TEMPO_MIN - 30_000 });
  await svc.avaliarRobos();
  svc.statusUra.set('201', { classe: Classe.ATENDIMENTO, ts: Date.now() });
  await svc.avaliarRobos();
  assert.deepEqual(robos.chamadas.slice(-1), ['desligar 900,901 (PÂNICO: 0 livre na URA)']);
  assert.ok(avisos.some((m) => /^PÂNICO: 0 livre na URA — desligando os robôs\.$/.test(m)));
  assert.equal(robos.chamadas.filter((c) => c === 'sincronizar').length, 1);
});

test('pânico: com 2 livres não mexe; ao sair do pânico avisa; o BenURA nunca liga robôs', async () => {
  const { svc, robos, avisos } = montar({ livres: 1, livreHaMs: TEMPO_MIN });
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

test('interruptor por dia (URA passiva hoje): ligado ontem volta ao padrão hoje', () => {
  let gravado = null;
  const fuso = 'America/Sao_Paulo';
  const ontem = new Date('2026-10-19T15:00:00Z');
  const hoje = new Date('2026-10-20T15:00:00Z');
  const i = new Interruptor({ nome: 'URA passiva hoje', arquivo: null, padrao: false, fusoHorario: fuso, logger: loggerNulo });
  i.repositorio = { carregar: () => gravado, salvar: (e) => { gravado = e; } };
  i.carregar();
  assert.equal(i.definir(true, ontem), true);
  assert.equal(i.ligado(ontem), true);
  assert.deepEqual(i.resumo(hoje), { ligado: false, desde: null }, 'virou o dia');
  assert.equal(i.definir(true, hoje), true, 'liga de novo hoje');
  assert.equal(i.ligado(hoje), true);
});

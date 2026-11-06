'use strict';
/**
 * [NOVO] Rodízio de pessoas (benura-rodizio) e robôs (benura-robos) em dois serviços: o retrato da
 * URA, o papel de cada um, os eventos entre eles e a rede de segurança dos 30 s.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Interruptor } = require('../../src/rodizio/interruptor');
const { StatusUra } = require('../../src/rodizio/status-ura');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

const TEMPO_MIN = 180_000;
const CFG = {
  robosModo: 'panico', pollUraMs: 1000, tempoNaUraMs: TEMPO_MIN, panicoAntesDeSairMs: 60_000, panicoFixoReduzirMs: 60_000,
  panicoFixoOciosoMs: 3 * 60_000, robosSemRespostaMs: 30_000,
};

function robosFalsos(ligados = ['900', '901']) {
  const chamadas = [];
  return {
    chamadas,
    ligados: new Set(ligados),
    alvo: null,
    situacao(total) { return { ligados: this.ligados.size, total, ultimaReducao: 0, ultimoAumento: 0 }; },
    resumo() { return { ligados: this.ligados.size, alvo: this.alvo, mudancasPorFora: 0 }; },
    async sincronizar(ramais) { chamadas.push(`sincronizar ${ramais.join(',')}`); },
    async desligar(ramais, motivo) { chamadas.push(`desligar ${ramais.join(',')} (${motivo})`); this.ligados.clear(); },
    async encerrarSemDerrubar(motivo) { chamadas.push(`encerrarSemDerrubar (${motivo})`); },
    async aumentar() { chamadas.push('aumentar'); },
    async reduzir() { chamadas.push('reduzir'); },
    async reduzirPoupando(alvo) { chamadas.push(`reduzirPoupando ${alvo}`); },
  };
}

const logs = () => {
  const linhas = [];
  return { linhas, logger: { ...loggerNulo, info: (m) => linhas.push(m), aviso: (m) => linhas.push(m), erro: (m) => linhas.push(m) } };
};

/** Rodízio de pessoas com 4 humanos: 201 livre comum há 100 s, 202 fixo livre, 203 em atendimento, 204 supervisor livre. */
function pessoas({ ligacaoRobos = null, robosDeEmergencia = null, estatisticas = null, termometro = null } = {}) {
  const { linhas, logger } = logs();
  const statusDaUra = new StatusUra({ arquivo: null, logger });
  statusDaUra.definir({ status: 'normal', modo: 'manual' });
  const svc = new RodizioService({
    papel: 'pessoas', ligacaoRobos, robosDeEmergencia, estatisticas, termometro, statusDaUra,
    client: {}, transferencias: {}, repositorio: { salvar() {} }, logger, cfg: CFG,
    contasSupervisores: { eh: (r) => r === '204', lista: () => ['204'] },
  });
  const agora = Date.now();
  svc.ramaisUra = new Set(['201', '202', '203', '204']);
  svc.ramaisRobos = ['900', '901', '902'];
  svc.permanentes = new Set(['202']);
  svc.statusUra.set('201', { classe: Classe.LIVRE, ts: agora, livreDesde: agora - 100_000, detalhe: { grupo: 2, origem: null, nome: 'Ana', telefone: 'x' } });
  svc.statusUra.set('202', { classe: Classe.LIVRE, ts: agora, livreDesde: agora - 500_000 });
  svc.statusUra.set('203', { classe: Classe.ATENDIMENTO, ts: agora });
  svc.statusUra.set('204', { classe: Classe.LIVRE, ts: agora, livreDesde: agora - 5_000 });
  return { svc, linhas, agora };
}

function robos({ robos: r = robosFalsos(), panicoLigado = true } = {}) {
  const { linhas, logger } = logs();
  const panico = new Interruptor({ nome: 'Pânico', arquivo: null, padrao: panicoLigado, logger });
  const svc = new RodizioService({
    papel: 'robos', client: { listarGrupos: async () => [] }, transferencias: null, robos: r, repositorio: { salvar() {}, carregar: () => ({}) }, logger, panico, cfg: CFG,
  });
  return { svc, robos: r, linhas };
}

test('retrato: ramais, fixos, status sem dado sensível e o "sai em" de cada livre pela regra do ocioso', () => {
  const { svc, agora } = pessoas();
  const r = svc.retratoDaUra(agora);
  assert.deepEqual(r.ramaisUra, ['201', '202', '203', '204']);
  assert.deepEqual(r.ramaisRobos, ['900', '901', '902']);
  assert.deepEqual(r.permanentes, ['202']);
  assert.equal(r.saiEm['201'], agora - 100_000 + TEMPO_MIN, 'livre comum: livre desde + TEMPO_MIN');
  assert.equal(r.saiEm['202'], undefined, 'fixo não sai');
  assert.equal(r.saiEm['203'], undefined, 'em atendimento não sai');
  assert.equal(r.saiEm['204'], agora, 'conta de supervisor livre sai já');
  const ana = Object.fromEntries(r.status)['201'];
  assert.equal(ana.classe, Classe.LIVRE);
  assert.equal(ana.detalhe.nome, 'Ana');
  assert.equal(ana.detalhe.telefone, undefined, 'só o que os robôs usam');
  assert.equal(r.statusUra, 'normal');
  assert.equal(r.passiva, false);
  assert.equal(r.limiteBaseMs, TEMPO_MIN);
});

test('papel robôs: aplica o retrato e a regra do ocioso vem do "sai em" (não recalcula)', async () => {
  const p = pessoas();
  const { svc } = robos();
  svc.receberRetrato({ retrato: p.svc.retratoDaUra(p.agora) }, p.agora);
  assert.deepEqual([...svc.ramaisUra], ['201', '202', '203', '204']);
  assert.ok(svc.permanentes.has('202'));
  assert.equal(svc.deveDevolver('201', p.agora + 79_000), false);
  assert.equal(svc.deveDevolver('201', p.agora + 80_000), true);
  assert.equal(svc.deveDevolver('202', p.agora + 10 * 60_000), false);
  assert.equal(svc.statusAtualDaUra(), 'normal');
  assert.equal(svc.retratoFresco(p.agora + 1000), true);
  assert.equal(svc.retratoFresco(p.agora + 16_000), false, 'vale max(3 × POLL_URA_MS, 15 s)');
});

test('papel robôs: com o retrato, o pânico vê o último livre comum saindo e para os robôs', async () => {
  const p = pessoas();
  // só a 201 livre (sai em 80 s) e a 203 em atendimento
  p.svc.ramaisUra = new Set(['201', '203']);
  const { svc, robos: r } = robos();
  svc.receberRetrato({ retrato: p.svc.retratoDaUra(p.agora) }, Date.now());
  await svc.aplicarPanico();
  assert.equal(r.chamadas.length, 0, 'sai em 80 s: ainda não (o pânico é a 60 s)');
  svc.saidas.set('201', Date.now() + 30_000);
  await svc.aplicarPanico();
  assert.match(r.chamadas.join(), /encerrarSemDerrubar \(PÂNICO: 1 livre na URA \(201\)/);
});

test('papel robôs: sem retrato fresco, lê a URA sozinho, só leitura (ninguém sai; não move nem grava estado)', async () => {
  const lidos = [];
  const { svc } = robos();
  svc.client = {
    listarGrupos: async () => [{ idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['201'] }, { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900'] }],
  };
  svc.cfg = { ...svc.cfg, grupoUraId: 2, gruposRobosIds: [3], gruposAtivosIds: [1] };
  svc.lerStatus = async (ramal) => { lidos.push(ramal); return { classe: Classe.LIVRE, status: { idGrupo: 2, tempoStatus: 400_000 } }; };
  svc.transferencias = { transferir: async () => { throw new Error('não pode mover'); } };
  svc.saidas.set('201', 1); // de um retrato antigo
  await svc.atualizarGrupos();
  assert.deepEqual([...svc.ramaisUra], ['201']);
  await svc.cicloUra();
  assert.deepEqual(lidos.filter((r) => r === '201').length, 1);
  assert.equal(svc.deveDevolver('201', Date.now() + 3_600_000), false, 'com o de pessoas parado, ninguém sai');
});

test('papel pessoas: os robôs viram um espelho da resposta; eventos vão e voltam uma vez só', async () => {
  const enviados = [];
  const registrados = [];
  const estatisticas = {
    registrarPanico: (tipo) => registrados.push(`panico ${tipo}`),
    registrarEncerramento: (ts, enc) => { registrados.push(`encerramento ${enc.chave}`); return true; },
    registrarDerivacao: () => registrados.push('derivacao local'),
    amostrar() {}, resumo: () => null, carregar() {},
  };
  const termometro = { registrarCallback: () => registrados.push('termometro callback'), registrarDerivacao() {}, amostrar: () => null, resumo: () => null, estado: 'normal' };
  let resposta = {
    robos: { ligadosRamais: ['900', '901', '902'], alvo: 3, mudancasPorFora: 0 },
    panico: { tipo: 'saindo', motivo: 'PÂNICO: x', desde: 1 },
    livres: 2,
    ultimoSaindo: null,
    instancia: 'r1',
    eventos: [{ seq: 1, tipo: 'panico', panico: 'saindo', ts: 1 }, { seq: 2, tipo: 'encerramento', ts: 2, encerramento: { chave: 'L1', derivou: false } }],
    ack: null,
  };
  const ligacaoRobos = { enviar: async (corpo) => { enviados.push(JSON.parse(JSON.stringify(corpo))); return resposta; } };
  const { svc, agora } = pessoas({ ligacaoRobos, estatisticas, termometro });
  svc.registrarDerivacao(agora, 20_000, '201');
  await svc.avaliarRobos();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].retrato.ramaisUra.length, 4);
  assert.deepEqual(enviados[0].eventos.map((e) => [e.seq, e.tipo, e.ramal]), [[1, 'derivacao', '201']]);
  assert.equal(svc.robos.situacao(3).ligados, 3);
  assert.equal(svc.panicoTipo, 'saindo');
  assert.equal(svc.ultimosLivres, 2);
  assert.deepEqual(registrados, ['derivacao local', 'panico saindo', 'encerramento L1']);

  // a mesma resposta de novo (repetida): não registra outra vez; e a derivação, confirmada, não volta
  resposta = { ...resposta, ack: { instancia: enviados[0].instancia, seq: 1 } };
  await svc.avaliarRobos();
  assert.deepEqual(registrados, ['derivacao local', 'panico saindo', 'encerramento L1']);
  await svc.avaliarRobos();
  assert.deepEqual(enviados[2].eventos, [], 'confirmada pelo de robôs: sai da fila');
  assert.deepEqual(enviados[2].ack, { instancia: 'r1', seq: 2 });
});

test('papel pessoas: callback do webhook vai ao termômetro aqui e ao ajuste lá; papel robôs não devolve ao termômetro', async () => {
  const registrados = [];
  const termometro = { registrarCallback: () => registrados.push('termometro'), registrarDerivacao() {}, amostrar: () => null, resumo: () => null, estado: 'normal' };
  const { svc } = pessoas({ termometro, ligacaoRobos: { enviar: async () => ({}) } });
  svc.registrarCallback({ motivo: 'abandono', chave: 'L9' });
  assert.deepEqual(registrados, ['termometro']);
  const [ev] = svc.filaParaOutroLado.pendentes().eventos;
  assert.equal(ev.tipo, 'callback');

  const ajustes = [];
  const r = robos();
  r.svc.cfg = { ...r.svc.cfg, robosModo: 'automatico', robosCalculo: 'fixo' }; // no modo pânico o ajuste não age
  r.svc.ajuste = { registrarCallback: (c) => { ajustes.push(c.chave); return false; }, resumo: () => null, atual: () => 7 };
  r.svc.receberRetrato({ retrato: svc.retratoDaUra(Date.now()), ...svc.filaParaOutroLado.pendentes() }, Date.now());
  assert.deepEqual(ajustes, ['L9']);
  assert.deepEqual(r.svc.filaParaOutroLado.pendentes().eventos, [], 'não volta para o termômetro do de pessoas');
});

test('rede de segurança: 30 s sem resposta do serviço dos robôs, o de pessoas para os robôs parados (uma vez por queda)', async () => {
  const emergencia = robosFalsos();
  let falhar = true;
  const ligacaoRobos = { enviar: async () => { if (falhar) throw new Error('fora do ar'); return {}; } };
  const { svc, linhas } = pessoas({ ligacaoRobos, robosDeEmergencia: emergencia });
  const inicio = Date.now();
  svc.robosRespondeuEm = inicio;
  await svc.trocarComRobos(inicio + 29_000);
  assert.deepEqual(emergencia.chamadas, []);
  await svc.trocarComRobos(inicio + 30_000);
  assert.deepEqual(emergencia.chamadas, ['sincronizar 900,901,902', 'encerrarSemDerrubar (serviço dos robôs sem responder)']);
  assert.ok(linhas.some((l) => /sem responder há 30 s/.test(l)));
  await svc.trocarComRobos(inicio + 60_000);
  assert.equal(emergencia.chamadas.length, 2, 'uma vez por queda');
  falhar = false;
  await svc.trocarComRobos(inicio + 61_000);
  falhar = true;
  await svc.trocarComRobos(inicio + 95_000);
  assert.equal(emergencia.chamadas.length, 4, 'voltou e caiu de novo: age de novo');
});

test('papel pessoas: os robôs de verdade nunca recebem comando (só o espelho)', async () => {
  const { svc } = pessoas({ ligacaoRobos: { enviar: async () => ({ robos: { ligadosRamais: ['900'], alvo: 1 } }) } });
  await svc.avaliarRobos();
  await svc.encerrarRobosParaDesligar();
  assert.equal(svc.desligandoAutomacao, true);
  assert.equal(svc.retratoDaUra(Date.now()).desligandoAutomacao, true, 'o de robôs para de decidir também');
});

test('rotas: o de robôs só tem as dos robôs (e /interno/ura); o de pessoas repassa as dos robôs ao benura-robos', async () => {
  const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
  const ciclos = { ultimoCicloUra: () => 1, ultimoCicloAtivo: () => null };
  const r = robos();
  const doRobos = criarRotasDoRodizio({ rodizio: r.svc, ciclos, logger: loggerNulo, papel: 'robos' });
  const caminhos = doRobos.map((x) => `${x.metodo} ${x.caminho}`);
  for (const c of ['POST /interno/ura', 'POST /panico', 'PUT /robos/modo', 'POST /robos/por-livre', 'GET /alertas', 'POST /automacao/encerrar-robos', 'GET /health']) {
    assert.ok(caminhos.includes(c), c);
  }
  for (const c of ['POST /webhook', 'POST /operadores/mover', 'PUT /ura/status', 'POST /ura/cheia']) assert.ok(!caminhos.includes(c), `${c} é do de pessoas`);
  assert.equal(doRobos.find((x) => x.caminho === '/interno/ura').protegida, true);
  const saude = await doRobos.find((x) => x.caminho === '/health').handler({});
  assert.equal(saude.corpo.papel, 'robos');
  assert.equal(saude.corpo.retratoDaUra.fresco, false);
  const p = pessoas();
  const resposta = await doRobos.find((x) => x.caminho === '/interno/ura').handler({ corpo: { retrato: p.svc.retratoDaUra(Date.now()) } });
  assert.equal(resposta.status, 200);
  assert.ok('robos' in resposta.corpo);

  const repassados = [];
  const repassarAosRobos = async ({ req }) => { repassados.push(`${req.method} ${req.url}`); return { status: 200, corpo: { ok: true } }; };
  const dePessoas = criarRotasDoRodizio({ rodizio: pessoas().svc, ciclos, logger: loggerNulo, papel: 'pessoas', repassarAosRobos });
  await dePessoas.find((x) => x.metodo === 'POST' && x.caminho === '/panico').handler({ req: { method: 'POST', url: '/panico' } });
  await dePessoas.find((x) => x.caminho === '/robos/modo').handler({ req: { method: 'PUT', url: '/robos/modo' }, corpo: { modo: 'panico' } });
  assert.deepEqual(repassados, ['POST /panico', 'PUT /robos/modo']);
  assert.ok(!dePessoas.some((x) => x.caminho === '/interno/ura'));
  assert.ok(dePessoas.some((x) => x.caminho === '/webhook'));
});

test('papel robôs: erro ao montar o resumo não derruba a resposta ao de pessoas (senão ele pararia os robôs à toa)', () => {
  const r = robos();
  r.svc.resumoDosRobos = () => { throw new Error('quebrou'); };
  const resposta = r.svc.receberRetrato({ retrato: pessoas().svc.retratoDaUra(Date.now()) });
  assert.equal(resposta.resumo, null);
  assert.ok(Array.isArray(resposta.robos.ligadosRamais));
});

test('[NOVO] papel pessoas: escreve a linha do tempo da URA (o gráfico do painel) quando mudam os livres ou os robôs', async () => {
  const { lerMudancaDeLivres } = require('../../src/domain/painel');
  let resposta = { robos: { ligadosRamais: ['900', '901'], alvo: 2, mudancasPorFora: 0 }, instancia: 'r1', eventos: [], ack: null };
  let falhar = false;
  const ligacaoRobos = { enviar: async () => { if (falhar) throw new Error('fora do ar'); return resposta; } };
  const { svc, linhas } = pessoas({ ligacaoRobos });
  const pontos = () => linhas.map((l) => lerMudancaDeLivres(`08:00:00 ${l}`)).filter(Boolean);

  await svc.avaliarRobos();
  assert.equal(pontos().length, 1, 'a primeira linha do dia');
  const livres = pontos()[0].livres;
  assert.equal(pontos()[0].robos, 2, 'robôs ligados pelo que o serviço dos robôs respondeu');

  await svc.avaliarRobos();
  assert.equal(pontos().length, 1, 'nada mudou: nenhuma linha nova');

  resposta = { ...resposta, robos: { ...resposta.robos, ligadosRamais: ['900', '901', '902'] } };
  await svc.avaliarRobos();
  assert.deepEqual([pontos().length, pontos()[1].livres, pontos()[1].robos], [2, livres, 3], 'só os robôs mudaram: linha nova');

  svc.statusUra.set('201', { classe: Classe.ATENDIMENTO, ts: Date.now() });
  await svc.avaliarRobos();
  assert.deepEqual([pontos().length, pontos()[2].livres, pontos()[2].robos], [3, livres - 1, 3], 'os livres mudaram');

  falhar = true;
  await svc.avaliarRobos();
  assert.deepEqual([pontos().length, pontos()[3].robos], [4, null], 'serviço dos robôs sem responder: "?" (sem dado, não 0)');
});

test('[NOVO] papel robôs: não escreve a linha do tempo (a do de pessoas, no rodizio.txt, é a que o painel lê)', () => {
  const { svc, linhas } = robos();
  svc.ramaisUra = new Set(['201']);
  svc.statusUra.set('201', { classe: Classe.LIVRE, ts: Date.now(), livreDesde: Date.now() - 1000 });
  svc.registrarMudancaDeLivres(1, 2);
  assert.ok(!linhas.some((l) => /URA: livres/.test(l)));
});

test('[NOVO] papel pessoas: a primeira linha do tempo sai "livres ?→N", mesmo com o ultimosLivres da resposta dos robôs', async () => {
  const resposta = { robos: { ligadosRamais: ['900'], alvo: 1, mudancasPorFora: 0 }, livres: 1, instancia: 'r1', eventos: [], ack: null };
  const ligacaoRobos = { enviar: async () => resposta };
  const { svc, linhas } = pessoas({ ligacaoRobos });
  svc.ultimosLivres = 1; // a resposta do serviço dos robôs já chegou antes da primeira linha
  await svc.avaliarRobos();
  const primeira = linhas.find((l) => /URA: livres/.test(l));
  assert.match(primeira, /^URA: livres \?→\d+ \|/);
});

test('[NOVO] separado: a correção do raio-x vai do de robôs ao mapa de risco do de pessoas', () => {
  const { estatisticasRemotas } = require('../../src/rodizio/separacao');
  const { metodosDaSeparacao } = require('../../src/rodizio/rodizio.separacao');
  const eventos = [];
  estatisticasRemotas({ por: (e) => eventos.push(e) }).corrigirCallbackNoMapa('ligacao:9', false);
  assert.deepEqual(eventos.map(({ tipo, chave, invisivel }) => ({ tipo, chave, invisivel })), [{ tipo: 'callback-mapa', chave: 'ligacao:9', invisivel: false }]);
  const aplicadas = [];
  const pessoas = { ...metodosDaSeparacao, estatisticas: { corrigirCallbackNoMapa: (c, i) => aplicadas.push([c, i]) } };
  pessoas.aplicarEventoDosRobos(eventos[0]);
  assert.deepEqual(aplicadas, [['ligacao:9', false]]);
});

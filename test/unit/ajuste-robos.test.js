'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AjusteRobos } = require('../../src/rodizio/ajuste-robos');
const { interpretarCallback } = require('../../src/domain/rodizio');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;
const CFG = { base: 7, piso: 4, maximo: 15, degrau: 2, recuperarAposMs: 15 * MIN, intervaloMinMs: 60_000, passivaMs: 2 * MIN };
const criar = (avisos = [], cfg = {}) => new AjusteRobos({
  cfg: { ...CFG, ...cfg },
  logger: { ...loggerNulo, aviso: (m) => avisos.push(m) },
});
const cb = (chave) => ({ motivo: 'abandonou a fila', chave });

test('interpretarCallback: só abandono e time-out na fila do encerramento de URA; sem dados do cliente na saída', () => {
  const evento = (conclusao) => ({ idTipoWebhook: 5, idConclusaoDerivacao: conclusao, telefone: '11999990000', dataInicioUra: '2026-10-15T09:03:00' });
  assert.equal(interpretarCallback(evento(2)).motivo, 'abandonou a fila');
  assert.equal(interpretarCallback({ ...evento(4), idConclusaoDerivacao: undefined, FidConclusaoDerivacao: 4 }).motivo, 'time-out na fila');
  assert.equal(interpretarCallback(evento(1)), null, 'derivou');
  assert.equal(interpretarCallback(evento(3)), null, 'sem agente fica de fora (não é fila)');
  assert.equal(interpretarCallback({ ...evento(2), idTipoWebhook: 1 }), null);
  assert.equal(interpretarCallback({ idTipoWebhook: 5, idConclusaoDerivacao: 2 }).chave, null, 'número anônimo ainda conta');
});

test('ajuste: cada callback desce um degrau (2); mesmo evento reenviado não conta; intervalo mínimo; piso', () => {
  const avisos = [];
  const a = criar(avisos);
  assert.equal(a.atual(0), 7);
  assert.equal(a.registrarCallback(cb('a'), { agora: 1000, situacao: '1 livre(s) na URA e 7 robô(s) ligado(s)' }), true);
  assert.equal(a.atual(1000), 5);
  assert.match(avisos.at(-1), /Callback \(abandonou a fila\) com 1 livre\(s\) na URA e 7 robô\(s\) ligado\(s\): robôs por livre 7→5/);

  assert.equal(a.registrarCallback(cb('a'), { agora: 2 * MIN }), false, 'reenvio da Argus');
  assert.equal(a.callbacks, 1);
  assert.equal(a.registrarCallback(cb('b'), { agora: 30_000 }), false, 'menos de 60 s da última queda');
  assert.equal(a.atual(30_000), 5);

  a.registrarCallback(cb('c'), { agora: 2 * MIN });
  assert.equal(a.atual(2 * MIN), 4, 'não passa do piso');
  assert.equal(a.registrarCallback(cb('d'), { agora: 4 * MIN }), false);
  assert.equal(a.callbacks, 4);
});

test('ajuste: URA passiva sobe um degrau a cada passivaMs, até o máximo', () => {
  const avisos = [];
  const a = criar(avisos);
  assert.equal(a.subirPorPassividade(0, '2 min sem derivação com 1 livre(s)'), true);
  assert.equal(a.atual(0), 9);
  assert.match(avisos.at(-1), /URA passiva \(2 min sem derivação com 1 livre\(s\)\): robôs por livre 7→9/);
  assert.equal(a.subirPorPassividade(1 * MIN, 'x'), false, 'no máximo um degrau a cada passivaMs');
  for (let t = 2; t <= 10; t += 2) a.subirPorPassividade(t * MIN, 'x');
  assert.equal(a.atual(10 * MIN), 15, 'não passa do máximo');
  assert.equal(a.subirPorPassividade(20 * MIN, 'x'), false);

  // Um callback depois de subir desce o mesmo degrau.
  a.registrarCallback(cb('a'), { agora: 21 * MIN });
  assert.equal(a.atual(21 * MIN), 13);
});

test('ajuste: abaixo do .env, sem callback sobe 1 a cada 15 min; acima do .env, só a passividade sobe', () => {
  const a = criar();
  a.registrarCallback(cb('a'), { agora: 0 });
  assert.equal(a.atual(0), 5);
  assert.equal(a.atual(14 * MIN), 5);
  assert.equal(a.atual(15 * MIN), 6);
  assert.equal(a.atual(30 * MIN), 7);
  assert.equal(a.atual(500 * MIN), 7, 'sem passividade, não passa do .env sozinho');
});

test('ajuste: manual (página /ura) aplica na hora, limitado entre o piso e o máximo', () => {
  const a = criar();
  assert.equal(a.definir(12, 0), 12);
  assert.equal(a.atual(0), 12);
  assert.equal(a.definir(40, 1000), 15);
  assert.equal(a.definir(1, 2000), 4);
  assert.equal(a.subirPorPassividade(2000 + MIN, 'x'), false, 'a passividade conta de novo a partir do ajuste');
  assert.ok(a.resumo(2000).ajustadoAMao);
});

test('ajuste: com os robôs no modo manual ou o automático desligado, o callback é registrado mas não ajusta', () => {
  const avisos = [];
  const a = criar(avisos);
  assert.equal(a.registrarCallback(cb('a'), { agora: 0, manual: true }), false);
  assert.equal(a.atual(0), 7);
  assert.match(avisos.at(-1), /modo manual: não ajusta/);

  const desligado = criar([], { automatico: false });
  assert.equal(desligado.registrarCallback(cb('a'), { agora: 0 }), false);
  assert.equal(desligado.subirPorPassividade(0, 'x'), false);
  assert.equal(desligado.definir(10, 0), 10, 'o manual vale mesmo com o automático desligado');
});

test('ajuste: reiniciar no mesmo dia retoma o valor; em outro dia começa do .env', () => {
  let gravado = null;
  const repositorio = { carregar: () => gravado, salvar: async (e) => { gravado = e; } };
  const primeiro = new AjusteRobos({ cfg: CFG, logger: loggerNulo, repositorio, hoje: () => '2026-10-15' }).carregar();
  primeiro.subirPorPassividade(0, 'x');
  primeiro.subirPorPassividade(2 * MIN, 'x');
  assert.equal(gravado.porLivre, 11);

  const reiniciado = new AjusteRobos({ cfg: CFG, logger: loggerNulo, repositorio, hoje: () => '2026-10-15' }).carregar();
  assert.equal(reiniciado.atual(3 * MIN), 11, 'retoma o valor');
  assert.equal(reiniciado.subirPorPassividade(3 * MIN, 'x'), false, 'retoma também a última subida');

  const outroDia = new AjusteRobos({ cfg: CFG, logger: loggerNulo, repositorio, hoje: () => '2026-10-16' }).carregar();
  assert.equal(outroDia.atual(0), 7);
});

test('rodízio: URA passiva só com 2+ livres, robôs no alvo e ninguém atendendo; não no modo manual', () => {
  const subidas = [];
  const robos = { ligados: 7, alvo: 7 };
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, logger: loggerNulo, cfg: { passivaMs: 2 * MIN },
    robos: { resumo: () => robos, situacao: () => robos },
    ajuste: { subirPorPassividade: (agora, situacao) => { subidas.push(situacao); return false; } },
  });
  svc.ultimosLivres = 2;
  svc.ultimoAtendimentoUraEm = 0;
  svc.verificarPassividade(1 * MIN);
  assert.equal(subidas.length, 0, 'menos de 2 min sem derivação');
  svc.verificarPassividade(2 * MIN);
  assert.match(subidas[0], /2 min sem derivação com 2 livre\(s\) e 7 robô\(s\)/);

  robos.ligados = 3; // ainda subindo em degraus
  svc.verificarPassividade(3 * MIN);
  robos.ligados = 7;
  svc.ultimosLivres = 0;
  svc.verificarPassividade(3 * MIN);
  svc.ultimosLivres = 1; // com 1 livre manda o ROBOS_MAX_COM_1_LIVRE
  svc.verificarPassividade(3 * MIN);
  svc.ultimosLivres = 2;
  svc.manualAte = 10 * MIN;
  svc.verificarPassividade(3 * MIN);
  assert.equal(subidas.length, 1);
});

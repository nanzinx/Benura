'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AjustePorCallback } = require('../../src/rodizio/ajuste-por-callback');
const { interpretarCallback } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;
const criar = (avisos = []) => new AjustePorCallback({
  cfg: { base: 7, piso: 4, recuperarAposMs: 15 * MIN, intervaloMinMs: 60_000 },
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

test('ajuste: cada callback baixa um degrau; mesmo evento reenviado não conta; intervalo mínimo; piso', () => {
  const avisos = [];
  const a = criar(avisos);
  assert.equal(a.atual(0), 7);
  assert.equal(a.registrarCallback(cb('a'), { agora: 1000, situacao: '1 livre(s) na URA e 7 robô(s) ligado(s)' }), true);
  assert.equal(a.atual(1000), 6);
  assert.match(avisos.at(-1), /Callback \(abandonou a fila\) com 1 livre\(s\) na URA e 7 robô\(s\) ligado\(s\): robôs por livre 7→6/);

  assert.equal(a.registrarCallback(cb('a'), { agora: 2 * MIN }), false, 'reenvio da Argus');
  assert.equal(a.callbacks, 1);
  assert.equal(a.registrarCallback(cb('b'), { agora: 30_000 }), false, 'menos de 60 s da última queda');
  assert.equal(a.atual(30_000), 6);

  a.registrarCallback(cb('c'), { agora: 2 * MIN });
  a.registrarCallback(cb('d'), { agora: 4 * MIN });
  assert.equal(a.atual(4 * MIN), 4);
  assert.equal(a.registrarCallback(cb('e'), { agora: 6 * MIN }), false);
  assert.equal(a.atual(6 * MIN), 4, 'não passa do piso');
  assert.equal(a.callbacks, 5);
});

test('ajuste: sem callback sobe um degrau a cada 15 min até o valor do .env; callback adia a subida', () => {
  const a = criar();
  a.registrarCallback(cb('a'), { agora: 0 });
  a.registrarCallback(cb('b'), { agora: 2 * MIN });
  assert.equal(a.atual(2 * MIN), 5);
  assert.equal(a.atual(16 * MIN), 5, '15 min contados do último callback');
  assert.equal(a.atual(17 * MIN), 6);
  a.registrarCallback(cb('c'), { agora: 20 * MIN });
  assert.equal(a.atual(34 * MIN), 5, 'o callback das 20 min baixou e adiou');
  assert.equal(a.atual(35 * MIN), 6);
  assert.equal(a.atual(50 * MIN), 7);
  assert.equal(a.atual(500 * MIN), 7, 'nunca passa do .env');
});

test('ajuste: com os robôs no modo manual, o callback é registrado mas não ajusta', () => {
  const avisos = [];
  const a = criar(avisos);
  assert.equal(a.registrarCallback(cb('a'), { agora: 0, manual: true }), false);
  assert.equal(a.atual(0), 7);
  assert.match(avisos.at(-1), /modo manual: não ajusta/);
});

test('ajuste: reiniciar no mesmo dia retoma o degrau; em outro dia começa do .env', () => {
  let gravado = null;
  const repositorio = { carregar: () => gravado, salvar: async (e) => { gravado = e; } };
  const cfg = { base: 7, piso: 4, recuperarAposMs: 15 * MIN, intervaloMinMs: 60_000 };
  const primeiro = new AjustePorCallback({ cfg, logger: loggerNulo, repositorio, hoje: () => '2026-10-15' }).carregar();
  primeiro.registrarCallback(cb('a'), { agora: 1000 });
  primeiro.registrarCallback(cb('b'), { agora: 2 * MIN });
  assert.equal(gravado.porLivre, 5);

  const reiniciado = new AjustePorCallback({ cfg, logger: loggerNulo, repositorio, hoje: () => '2026-10-15' }).carregar();
  assert.equal(reiniciado.atual(3 * MIN), 5, 'retoma o degrau');
  assert.equal(reiniciado.callbacks, 2);
  assert.equal(reiniciado.atual(18 * MIN), 6, 'a recuperação conta do último callback gravado');

  const outroDia = new AjustePorCallback({ cfg, logger: loggerNulo, repositorio, hoje: () => '2026-10-16' }).carregar();
  assert.equal(outroDia.atual(0), 7);
});

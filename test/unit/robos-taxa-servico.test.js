'use strict';
/** [NOVO] Rodízio no automático: robôs por livre pela taxa real de derivação, por status da URA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const AGORA = Date.UTC(2026, 9, 30, 15, 0); // 12:00 em São Paulo
const MIN = 60_000;

function montar({ status = 'normal', calculo = 'taxa', ajuste = null } = {}) {
  const svc = Object.create(RodizioService.prototype);
  svc.cfg = {
    robosCalculo: calculo, robosPorLivre: 7, robosFatorCalma: 1.3, robosFatorAgressiva: 0.7, robosMaxComUmLivre: 6,
    fusoHorario: 'America/Sao_Paulo',
  };
  svc.log = loggerNulo;
  svc.ajuste = ajuste;
  svc.derivacoesRecentes = [];
  svc.amostrasRobos = [];
  svc.statusAtualDaUra = () => status;
  return svc;
}

/** `ligados` robôs nos últimos `minutos`, uma amostra a cada 30 s; `derivacoes` espalhadas na janela. */
function encher(svc, { ligados = 10, minutos = 30, derivacoes = 30 } = {}) {
  for (let t = AGORA - minutos * MIN; t <= AGORA; t += 30_000) svc.amostrarRobos(t, ligados);
  for (let i = 0; i < derivacoes; i++) svc.registrarDerivacao(AGORA - Math.floor(((i + 0.5) * minutos * MIN) / derivacoes));
}

test('taxa valendo: por livre e teto com 1 livre saem do status da URA', () => {
  for (const [status, porLivre, teto] of [['normal', 7, 10], ['calma', 14, 15], ['agressiva', 5, 6]]) {
    const svc = montar({ status });
    encher(svc); // 30 derivações em 300 robô-min = 0,1 por robô por min
    assert.equal(svc.porLivreComStatus(AGORA), porLivre, status);
    assert.equal(svc.maxComUmLivreAgora(AGORA), teto, status);
    const c = svc.calculoDosRobos(AGORA);
    assert.equal(c.fonte, 'taxa');
    assert.equal(c.derivacoes30, 30);
    assert.equal(c.roboMinutos30, 300);
    assert.equal(c.taxa, 0.1);
    assert.equal(c.status, status);
  }
});

test('só os últimos 30 min contam: derivação e amostra mais velhas saem', () => {
  const svc = montar();
  svc.amostrarRobos(AGORA - 50 * MIN, 10);
  svc.registrarDerivacao(AGORA - 45 * MIN);
  encher(svc);
  const c = svc.calculoDosRobos(AGORA);
  assert.equal(c.derivacoes30, 30);
  assert.equal(c.roboMinutos30, 300);
  assert.ok(svc.derivacoesRecentes.every((t) => t >= AGORA - 31 * MIN));
});

test('medindo (poucos dados): conta de antes, com o teto do status no lugar do 6 fixo', () => {
  const svc = montar({ status: 'calma' });
  encher(svc, { derivacoes: 3 });
  assert.equal(svc.calculoDosRobos(AGORA).fonte, 'medindo');
  assert.equal(svc.porLivreComStatus(AGORA), 9, '7 × 1,3');
  assert.equal(svc.maxComUmLivreAgora(AGORA), 15);
});

test('ROBOS_CALCULO=fixo: tudo como antes', () => {
  const svc = montar({ status: 'calma', calculo: 'fixo' });
  encher(svc);
  assert.equal(svc.calculoDosRobos(AGORA), null);
  assert.equal(svc.porLivreComStatus(AGORA), 9);
  assert.equal(svc.maxComUmLivreAgora(AGORA), 6);
});

test('"por livre" escolhido à mão hoje vale por cima da conta; o de ontem não', () => {
  const ajuste = { ajustadoAMaoEm: AGORA - 10 * MIN, atual: () => 12 };
  const svc = montar({ ajuste });
  encher(svc);
  assert.equal(svc.porLivreComStatus(AGORA), 12);
  assert.equal(svc.calculoDosRobos(AGORA).fonte, 'manual');
  ajuste.ajustadoAMaoEm = AGORA - 24 * 60 * MIN;
  assert.equal(svc.porLivreComStatus(AGORA), 7);
});

test('callback com a conta valendo não mexe no ajuste; medindo, mexe', () => {
  const chamadas = [];
  const ajuste = { ajustadoAMaoEm: 0, atual: () => 7, registrarCallback: () => { chamadas.push('callback'); return false; } };
  const svc = montar({ ajuste });
  svc.emModoPanico = () => false;
  svc.manualAte = 0;
  svc.termometro = null;
  encher(svc);
  svc.registrarCallback({ motivo: 'abandono', chave: 'a' }, 'teste', AGORA);
  assert.deepEqual(chamadas, []);

  const medindo = montar({ ajuste });
  medindo.emModoPanico = () => false;
  medindo.manualAte = 0;
  medindo.termometro = null;
  medindo.registrarCallback({ motivo: 'abandono', chave: 'b' }, 'teste', AGORA);
  assert.deepEqual(chamadas, ['callback']);
});

function config(env) {
  const antes = { ...process.env };
  Object.assign(process.env, { BENURA_SEM_DOTENV: '1', ARGUS_TOKEN: 'x', GRUPO_URA_ID: '1', GRUPOS_ATIVOS_IDS: '2', GRUPOS_ROBOS_URA_IDS: '6', ...env });
  delete require.cache[require.resolve('../../src/config')];
  try {
    const c = require('../../src/config');
    const cfg = c.carregarConfig();
    return { cfg, ...c.validarConfig(cfg, { escopo: 'rodizio' }) };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
}

test('config: ROBOS_CALCULO=taxa por padrão, metas por status pelo .env, validadas', () => {
  const { cfg, fatais } = config({});
  assert.equal(cfg.rodizio.robosCalculo, 'taxa');
  assert.deepEqual(cfg.rodizio.robosTaxa.porStatus.calma, { esperaS: 45, min: 6, max: 15 });
  assert.deepEqual(cfg.rodizio.robosTaxa.porStatus.agressiva, { esperaS: 120, min: 2, max: 6 });
  assert.deepEqual(fatais, []);

  const trocado = config({ ROBOS_CALCULO: 'FIXO', ROBOS_ESPERA_ALVO_CALMA_S: '30', ROBOS_POR_LIVRE_MAX_CALMA: '20' });
  assert.equal(trocado.cfg.rodizio.robosCalculo, 'fixo');
  assert.deepEqual(trocado.cfg.rodizio.robosTaxa.porStatus.calma, { esperaS: 30, min: 6, max: 20 });

  const ruim = config({ ROBOS_POR_LIVRE_MIN_NORMAL: '12', ROBOS_ESPERA_ALVO_AGRESSIVA_S: '5' });
  assert.match(ruim.fatais.join(' | '), /ROBOS_POR_LIVRE_MIN_NORMAL.*ROBOS_POR_LIVRE_MAX_NORMAL/);
  assert.match(ruim.fatais.join(' | '), /ROBOS_ESPERA_ALVO_AGRESSIVA_S/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UraCheia } = require('../../src/rodizio/ura-cheia');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

const HOJE = new Date('2026-10-15T12:00:00Z'); // 09:00 em São Paulo
const AMANHA = new Date('2026-10-16T12:00:00Z');

test('UraCheia: liga, sobrevive a reinício no mesmo dia e desliga sozinha na virada do dia', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'ura-cheia-'));
  const arquivo = path.join(pasta, 'state-ura-cheia.json');
  const avisos = [];
  const criar = () => new UraCheia({ arquivo, fusoHorario: 'America/Sao_Paulo', logger: { ...loggerNulo, aviso: (m) => avisos.push(m) } });
  try {
    const ura = criar().carregar(HOJE);
    assert.equal(ura.ativa(HOJE), false);
    assert.equal(ura.ligar(HOJE), true);
    assert.equal(ura.ligar(HOJE), false, 'já ligada');
    await ura.repositorio.aguardar();

    const depoisDoReinicio = criar().carregar(HOJE);
    assert.deepEqual(depoisDoReinicio.resumo(HOJE), { ligada: true, desde: HOJE.toISOString() });
    assert.match(avisos.at(-1), /continua ligada/);

    assert.equal(depoisDoReinicio.ativa(AMANHA), false);
    assert.match(avisos.at(-1), /virou o dia/);
    assert.equal(depoisDoReinicio.desligar(), false, 'já desligada');
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

test('rodízio: na URA cheia quem a carga mandar ao Ativo sobe de novo; quem voltou por ocioso, só ao atender', async () => {
  const transferidos = [];
  const svc = new RodizioService({
    client: {}, repositorio: { salvar() {} }, robos: {}, logger: loggerNulo, cfg: { grupoUraId: 2, concorrencia: 5 },
    transferencias: { transferir: async (ramal, grupo) => { transferidos.push(`${ramal}→${grupo}`); return true; } },
    uraCheia: { ativa: () => true, ligar: () => true, resumo: () => ({}) },
  });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['100', '101'] }];
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos.sort(), ['100→2', '101→2']);

  // 101 ficou ocioso e voltou ao Ativo pela regra de sempre; 100 foi mandado ao Ativo pela carga (por fora do rodízio).
  await svc.devolverAoAtivo('101');
  delete svc.movidos['100'];
  svc.ramaisUra.delete('100');
  transferidos.length = 0;
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos, ['100→2'], 'o 101 só sobe ao atender no Ativo');

  // Religar a URA cheia leva todos de novo.
  delete svc.movidos['100'];
  svc.ramaisUra.delete('100');
  svc.ligarUraCheia();
  transferidos.length = 0;
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos.sort(), ['100→2', '101→2']);
});

test('rodízio: URA cheia em DRY_RUN simula a ida de cada um uma vez só', async () => {
  const transferidos = [];
  const svc = new RodizioService({
    client: {}, repositorio: { salvar() {} }, robos: {}, logger: loggerNulo, cfg: { grupoUraId: 2, concorrencia: 5, dryRun: true },
    transferencias: { transferir: async (ramal) => { transferidos.push(ramal); return true; } },
    uraCheia: { ativa: () => true },
  });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['100'] }];
  await svc.levarTodosParaUra();
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos, ['100']);
});

test('rodízio: a regra do ocioso vale na URA cheia (quem passou do TEMPO_MIN sai)', () => {
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo, cfg: { tempoNaUraMs: 180_000 },
    uraCheia: { ativa: () => true },
  });
  svc.statusUra.set('201', { classe: Classe.LIVRE, ts: 0, livreDesde: 0 });
  assert.equal(svc.deveDevolver('201', 180_000), true);
});

test('[NOVO] URA cheia: 2 min de ociosidade; ramal menor ganha a escada (10 s por posição, até 60 s)', () => {
  let cheia = true;
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo,
    cfg: { tempoNaUraMs: 180_000, tempoNaUraCheiaMs: 120_000, prioridadeRamalPassoMs: 10_000, prioridadeRamalMaxMs: 60_000 },
    uraCheia: { ativa: () => cheia },
  });
  const ramais = ['2266111', '2266267', '2266423', '2266773'];
  svc.ramaisUra = new Set(ramais);
  for (const r of ramais) svc.statusUra.set(r, { classe: Classe.LIVRE, ts: 0, livreDesde: 0 });
  assert.deepEqual(ramais.map((r) => svc.limiteOciosoMs(r)), [150_000, 140_000, 130_000, 120_000], '2:30, 2:20, 2:10, 2:00');
  assert.deepEqual(ramais.filter((r) => svc.deveDevolver(r, 135_000)), ['2266423', '2266773'], 'com 2:15, só os dois de ramal maior saem');
  cheia = false;
  assert.deepEqual(ramais.filter((r) => svc.deveDevolver(r, 135_000)), [], 'fora da URA cheia vale o TEMPO_MIN (3 min)');
  assert.equal(svc.limiteOciosoMs('2266111'), 210_000);
  svc.permanentes = new Set(['2266111']);
  assert.equal(svc.limiteOciosoMs('2266267'), 200_000, 'fixo não entra na escada');
});

test('[NOVO] prioridade por ramal: sobe do menor para o maior; o último livre a sair é o de saída mais tarde', async () => {
  const { porAntiguidade, ultimoLivreQueSai } = require('../../src/domain/rodizio');
  assert.deepEqual(porAntiguidade(['2266773', '2266111', '900', 'x', '2266267']), ['900', '2266111', '2266267', '2266773', 'x']);
  const status = new Map([['10', { classe: Classe.LIVRE, livreDesde: 0 }], ['20', { classe: Classe.LIVRE, livreDesde: 0 }]]);
  const saidaEm = (r) => (r === '10' ? 130_000 : 120_000);
  assert.equal(ultimoLivreQueSai({ saindo: ['10', '20'], ramaisUra: ['10', '20'], status, saidaEm }), '10');
  assert.equal(ultimoLivreQueSai({ saindo: ['10', '20'], ramaisUra: ['10', '20'], status, saidaEm: () => 1 }), '10', 'empate: o mais antigo fica');

  const ordem = [];
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: { salvar: () => {} }, robos: {}, logger: loggerNulo, cfg: { tempoNaUraMs: 180_000, concorrencia: 1 },
    uraCheia: { ativa: () => true },
  });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['305', '101', '210'] }];
  svc.moverParaUra = async (ramal) => { ordem.push(ramal); return true; };
  await svc.levarTodosParaUra();
  assert.deepEqual(ordem, ['101', '210', '305']);
});

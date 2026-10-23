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

test('[NOVO] rodízio: na URA cheia ninguém sobe só por estar no Ativo; quem atender sobe, mesmo sem ser elegível', async () => {
  const transferidos = [];
  const status = { 100: 'livre', 101: 'livre' };
  const svc = new RodizioService({
    client: {}, repositorio: { salvar() {} }, robos: {}, logger: loggerNulo, cfg: { grupoUraId: 2, concorrencia: 5 },
    transferencias: { transferir: async (ramal, grupo) => { transferidos.push(`${ramal}→${grupo}`); return true; } },
    uraCheia: { ativa: () => true, ligar: () => true, resumo: () => ({}) },
    elegiveis: { atualizar: async () => {}, permite: () => false }, // ninguém bateu meta nem vendeu
  });
  svc.lerStatus = async (ramal) => ({ classe: status[ramal] === 'livre' ? Classe.LIVRE : Classe.ATENDIMENTO, status: { idGrupo: 1 } });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['100', '101'] }];
  await svc.cicloAtivo();
  assert.deepEqual(transferidos, [], 'livres no Ativo (ociosos, tirados à mão) ficam lá');

  status[100] = 'atendimento';
  await svc.cicloAtivo();
  status[100] = 'livre';
  await svc.cicloAtivo();
  assert.deepEqual(transferidos, ['100→2'], 'o 100 atendeu no Ativo: sobe, mesmo sem ser elegível');

  // Voltou por ocioso: fica no Ativo até atender de novo (sem vai e volta).
  svc.statusUra.set('100', { classe: Classe.LIVRE });
  await svc.devolverAoAtivo('100');
  transferidos.length = 0;
  await svc.cicloAtivo();
  await svc.cicloAtivo();
  assert.deepEqual(transferidos, [], 'quem voltou por ocioso não sobe sem atender');
});

test('rodízio: URA cheia em DRY_RUN simula a ida de quem atendeu uma vez só', async () => {
  const transferidos = [];
  let classe = Classe.ATENDIMENTO;
  const svc = new RodizioService({
    client: {}, repositorio: { salvar() {} }, robos: {}, logger: loggerNulo, cfg: { grupoUraId: 2, concorrencia: 5, dryRun: true },
    transferencias: { transferir: async (ramal) => { transferidos.push(ramal); return true; } },
    uraCheia: { ativa: () => true },
  });
  svc.lerStatus = async () => ({ classe, status: { idGrupo: 1 } });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['100'] }];
  await svc.cicloAtivo();
  classe = Classe.LIVRE;
  await svc.cicloAtivo();
  await svc.cicloAtivo();
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
  assert.deepEqual(ramais.filter((r) => svc.deveDevolver(r, 135_000)), [], 'fora da URA cheia vale o TEMPO_MIN (aqui, 3 min)');
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
  svc.verificarOperadorDoAtivo = async ({ ramal }) => { ordem.push(ramal); };
  await svc.cicloAtivo();
  assert.deepEqual(ordem, ['101', '210', '305']);
});

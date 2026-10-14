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

test('rodízio: na URA cheia cada um é levado uma vez; depois segue a regra do ocioso', async () => {
  const transferidos = [];
  const svc = new RodizioService({
    client: {}, repositorio: { salvar() {} }, robos: {}, logger: loggerNulo, cfg: { grupoUraId: 2, concorrencia: 5 },
    transferencias: { transferir: async (ramal, grupo) => { transferidos.push(`${ramal}→${grupo}`); return true; } },
    uraCheia: { ativa: () => true, ligar: () => true, resumo: () => ({}) },
  });
  svc.gruposAtivos = [{ idGrupoUsuario: 1, ramaisOperadores: ['100', '101'] }];
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos.sort(), ['100→2', '101→2']);

  // 100 ficou ocioso e voltou ao Ativo pela regra de sempre: não é levado de novo.
  delete svc.movidos['100'];
  svc.ramaisUra.delete('100');
  await svc.levarTodosParaUra();
  assert.equal(transferidos.length, 2);

  // Religar a URA cheia leva todos de novo.
  svc.ligarUraCheia();
  await svc.levarTodosParaUra();
  assert.deepEqual(transferidos.slice(2), ['100→2']);
});

test('rodízio: a regra do ocioso vale na URA cheia (quem passou do TEMPO_MIN sai)', () => {
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo, cfg: { tempoNaUraMs: 180_000 },
    uraCheia: { ativa: () => true },
  });
  svc.statusUra.set('201', { classe: Classe.LIVRE, ts: 0, livreDesde: 0 });
  assert.equal(svc.deveDevolver('201', 180_000), true);
});

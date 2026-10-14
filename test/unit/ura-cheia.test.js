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

test('rodízio: na URA cheia ninguém volta por ocioso; ao desligar, o ocioso recomeça a contar', () => {
  let ligada = true;
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, robos: {}, logger: loggerNulo, cfg: {},
    uraCheia: { ativa: () => ligada },
  });
  svc.statusUra.set('201', { classe: Classe.LIVRE, livreDesde: 1000 });
  assert.equal(svc.emUraCheia(5000), true);
  ligada = false;
  assert.equal(svc.emUraCheia(9000), false);
  assert.equal(svc.statusUra.get('201').livreDesde, 9000, 'senão sairia todo mundo de uma vez');
});

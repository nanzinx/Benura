'use strict';
/** [NOVO] Indicadores da última hora (rodízio) e os alertas de OPL alto e TOR subindo (painel). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { JanelaDeIndicadores } = require('../../src/domain/indicadores');
const { VigiaIndicadores } = require('../../src/painel/vigia-indicadores');
const { loggerNulo } = require('../../src/utils/logger');

const MIN = 60_000;
const T0 = Date.parse('2026-11-03T13:00:00Z'); // 10:00 em Brasília

/** `min` minutos de amostras a cada 10 s, começando em `de`. */
function encher(j, de, min, { livres, robosLigados }) {
  for (let t = de; t <= de + min * MIN; t += 10_000) j.amostrar(t, { livres, robosLigados });
}

test('janela: OPL dos últimos 15 min = tempo livre somado ÷ derivações; TOR da última hora', () => {
  const j = new JanelaDeIndicadores();
  encher(j, T0, 30, { livres: 2, robosLigados: 5 }); // 2 livres por 30 min, com robôs
  for (let i = 0; i < 6; i++) j.registrarDerivacao(T0 + 16 * MIN + i * 2 * MIN); // 6 nos últimos 15 min
  j.registrarDerivacao(T0 + 5 * MIN); // fora dos 15 min
  const r = j.resumo(T0 + 30 * MIN);
  assert.equal(r.derivacoes15, 6);
  assert.equal(r.opl15Seg, 300, '2 livres × 15 min = 1800 s ÷ 6');
  assert.equal(r.tor60Min, 0);
  assert.equal(r.coberturaMin, 15);
});

test('janela: sem derivação, o OPL é todo o tempo livre; TOR conta livre com robôs desligados', () => {
  const j = new JanelaDeIndicadores();
  encher(j, T0, 20, { livres: 1, robosLigados: 0 });
  const r = j.resumo(T0 + 20 * MIN);
  assert.equal(r.opl15Seg, 900, 'nenhuma derivação em 15 min com 1 livre: pelo menos 15 min por lead');
  assert.equal(r.tor60Min, 20);
  assert.equal(r.coberturaMin, 15);
});

test('janela: amostras de mais de 1 h saem; buraco grande entre amostras não soma', () => {
  const j = new JanelaDeIndicadores();
  encher(j, T0, 10, { livres: 1, robosLigados: 0 });
  encher(j, T0 + 90 * MIN, 5, { livres: 1, robosLigados: 0 });
  const r = j.resumo(T0 + 95 * MIN);
  assert.equal(r.tor60Min, 5);
  assert.ok(j.amostras.every((a) => a.ts >= T0 + 35 * MIN));
});

function vigia({ estado = 'ligada', agindo = true, cfg = { oplSeg: 300, torMin: 10 } } = {}) {
  const avisos = [];
  let agora = T0;
  const v = new VigiaIndicadores({
    automacao: { estado: () => ({ estado }), agindoDeVerdade: () => agindo },
    notificador: { notificar: async (a) => { avisos.push(a); return { ok: true }; } },
    cfg, fuso: 'America/Sao_Paulo', logger: loggerNulo, agora: () => agora,
  });
  const ver = async (indicadores, min = 0.5) => { agora += min * MIN; await v.verificar({ indicadores }); };
  return { v, avisos, ver };
}

test('vigia: OPL alto avisa uma vez e avisa quando normaliza; com pouca cobertura, espera', async () => {
  const { avisos, ver } = vigia();
  await ver({ opl15Seg: 600, derivacoes15: 1, tor60Min: 0, coberturaMin: 5 });
  assert.equal(avisos.length, 0, 'menos de 15 min de dados: não avisa');
  await ver({ opl15Seg: 600, derivacoes15: 1, tor60Min: 0, coberturaMin: 15 });
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].titulo, /OPL alto/);
  assert.match(avisos[0].texto, /10 min 00 s por lead/);
  await ver({ opl15Seg: 650, derivacoes15: 1, tor60Min: 0, coberturaMin: 15 });
  assert.equal(avisos.length, 1, 'não repete');
  await ver({ opl15Seg: 200, derivacoes15: 9, tor60Min: 0, coberturaMin: 15 });
  assert.equal(avisos.length, 2);
  assert.match(avisos[1].titulo, /OPL normalizou/);
});

test('vigia: TOR acima do limite avisa no máximo uma vez por hora', async () => {
  const { avisos, ver } = vigia();
  await ver({ opl15Seg: null, tor60Min: 12, coberturaMin: 15 });
  await ver({ opl15Seg: null, tor60Min: 14, coberturaMin: 15 }, 20);
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].titulo, /TOR subindo/);
  assert.match(avisos[0].texto, /12 min/);
  await ver({ opl15Seg: null, tor60Min: 15, coberturaMin: 15 }, 45);
  assert.equal(avisos.length, 2, 'passou 1 h: avisa de novo');
});

test('vigia: não avisa com a automação desligada, no PC que não age, nem com o limite em 0', async () => {
  for (const montado of [vigia({ estado: 'desligada' }), vigia({ agindo: false }), vigia({ cfg: { oplSeg: 0, torMin: 0 } })]) {
    await montado.ver({ opl15Seg: 900, tor60Min: 30, coberturaMin: 15 });
    assert.equal(montado.avisos.length, 0);
  }
  const { avisos, ver } = vigia();
  await ver(undefined);
  assert.equal(avisos.length, 0, 'rodízio fora do ar: o vigia de saúde já avisa');
});

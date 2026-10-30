'use strict';
/** [NOVO] Robôs por livre pela taxa real de derivação, com uma meta de espera para cada status da URA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { robosPorLivrePelaTaxa, roboMinutos, CALCULO_PADRAO } = require('../../src/domain/robos-por-taxa');

const cfg = CALCULO_PADRAO;

test('taxa: robôs por livre = (60 ÷ espera alvo) ÷ derivações por robô-minuto, arredondado para cima', () => {
  // 30 derivações em 300 robô-minutos = 0,1 por robô por minuto.
  const r = robosPorLivrePelaTaxa({ derivacoes: 30, roboMinutos: 300, status: 'normal', cfg });
  assert.equal(r.fonte, 'taxa');
  assert.equal(r.taxa, 0.1);
  assert.equal(r.esperaAlvoS, 90);
  assert.equal(r.porLivre, 7, '(60/90)/0,1 = 6,67 → 7');
});

test('taxa: cada status tem a sua meta; com a mesma taxa, agressiva < normal < calma', () => {
  const por = (status) => robosPorLivrePelaTaxa({ derivacoes: 30, roboMinutos: 300, status, cfg }).porLivre;
  assert.ok(por('agressiva') < por('normal') && por('normal') < por('calma'), `${por('agressiva')} ${por('normal')} ${por('calma')}`);
  assert.equal(por('medindo'), por('normal'), 'medindo usa a meta do normal');
});

test('taxa: presa entre o piso e o teto do status', () => {
  const lenta = robosPorLivrePelaTaxa({ derivacoes: 6, roboMinutos: 600, status: 'calma', cfg }); // 0,01/min → 134
  assert.equal(lenta.porLivre, cfg.porStatus.calma.max);
  assert.equal(lenta.limitadoPor, 'teto');
  const rapida = robosPorLivrePelaTaxa({ derivacoes: 300, roboMinutos: 100, status: 'agressiva', cfg }); // 3/min → 1
  assert.equal(rapida.porLivre, cfg.porStatus.agressiva.min);
  assert.equal(rapida.limitadoPor, 'piso');
});

test('taxa: poucos dados (começo do dia) = "medindo", sem número', () => {
  for (const [derivacoes, minutos] of [[4, 300], [30, 29], [0, 0]]) {
    const r = robosPorLivrePelaTaxa({ derivacoes, roboMinutos: minutos, status: 'calma', cfg });
    assert.equal(r.fonte, 'medindo', `${derivacoes} derivações, ${minutos} robô-min`);
    assert.equal(r.porLivre, null);
    assert.equal(r.max, cfg.porStatus.calma.max, 'o teto do status vale mesmo medindo');
  }
});

test('robô-minutos: integra os ligados no tempo; lacuna grande conta no máximo 30 s', () => {
  // Fotos a cada 30 s (no rodízio é a cada 5 s): 6 ligados por 1,5 min = 9 robô-min; a lacuna de 15 min com 0 ligados não soma.
  const fotos = [{ ts: 0, ligados: 6 }, { ts: 30_000, ligados: 6 }, { ts: 60_000, ligados: 6 }, { ts: 90_000, ligados: 0 }, { ts: 990_000, ligados: 10 }];
  assert.equal(roboMinutos(fotos), 9);
  assert.equal(roboMinutos([{ ts: 0, ligados: 4 }, { ts: 600_000, ligados: 4 }]), 2, 'lacuna de 10 min com 4 ligados: só 30 s contam');
  assert.equal(roboMinutos([]), 0);
});

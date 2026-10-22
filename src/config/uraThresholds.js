'use strict';
/**
 * [NOVO] Faixas do termômetro automático da URA, num lugar só.
 *
 * Métrica (calculada no rodízio, termometro-ura.js): quanto tempo, em segundos, os
 * humanos livres da URA esperam por uma ligação, na média dos últimos `janelaMs`.
 * Entram as esperas que terminaram em atendimento nessa janela e as que ainda
 * estão correndo (quem está livre agora). Espera curta = ligação chegando rápido.
 *
 * Cada faixa vale de `de` (inclusive) até a próxima.
 */
module.exports = Object.freeze({
  janelaMs: 5 * 60_000,
  faixas: Object.freeze([
    Object.freeze({ estado: 'agressiva', de: 0 }), // 0 ≤ t < 60
    Object.freeze({ estado: 'normal', de: 60 }), // 60 ≤ t < 120
    Object.freeze({ estado: 'calma', de: 120 }), // t ≥ 120
  ]),
  /** Callback nos últimos N ms: agressiva, seja qual for a espera (0 = não considera). */
  callbackDeixaAgressivaMs: 5 * 60_000,
});

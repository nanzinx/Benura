'use strict';
/**
 * [NOVO] Robôs por livre pela taxa real de derivação (modo automático), uma meta por status da URA.
 *
 *   taxa       = derivações nos últimos 30 min ÷ robô-minutos ligados nos últimos 30 min
 *                (quantas derivações cada robô ligado gera por minuto)
 *   por livre  = ⌈ (60 ÷ espera alvo do status) ÷ taxa ⌉, entre o piso e o teto do status
 *
 * A espera alvo é quanto tempo um livre deve esperar por uma ligação: na calma (gente ociosa)
 * a meta é curta e liga mais robôs; na agressiva (risco de callback) é longa e liga menos.
 * Com poucos dados (começo do dia), devolve "medindo": quem chama usa a conta de antes.
 */

const CALCULO_PADRAO = Object.freeze({
  minDerivacoes: 5,
  minRoboMinutos: 30,
  janelaMs: 30 * 60_000,
  porStatus: Object.freeze({
    agressiva: Object.freeze({ esperaS: 120, min: 2, max: 6, todosComLivres: 0 }),
    normal: Object.freeze({ esperaS: 90, min: 4, max: 10, todosComLivres: 0 }),
    // Calma: 20 por livre e, com 2 livres ou mais, todos os robôs (pedido da supervisão, 30/10).
    calma: Object.freeze({ esperaS: 45, min: 20, max: 20, todosComLivres: 2 }),
  }),
});

/** Entre duas fotos, no máximo isto conta (o ciclo pode ter ficado parado). */
const MAX_INTERVALO_MS = 30_000;

/** A meta do status ("medindo" e desconhecido usam a do normal). */
const metaDo = (status, cfg) => cfg.porStatus[status] ?? cfg.porStatus.normal;

/**
 * @param {{ derivacoes: number, roboMinutos: number, status: string, cfg?: typeof CALCULO_PADRAO }} p
 * @returns {{ fonte: 'taxa'|'medindo', porLivre: number|null, taxa: number|null, esperaAlvoS: number, min: number, max: number,
 *            limitadoPor: 'piso'|'teto'|null, bruto: number|null }}
 */
function robosPorLivrePelaTaxa({ derivacoes, roboMinutos: minutos, status, cfg = CALCULO_PADRAO }) {
  const { esperaS, min, max, todosComLivres = 0 } = metaDo(status, cfg);
  const base = { esperaAlvoS: esperaS, min, max, todosComLivres };
  if (derivacoes < cfg.minDerivacoes || minutos < cfg.minRoboMinutos || !(minutos > 0)) {
    return { ...base, fonte: 'medindo', porLivre: null, taxa: minutos > 0 ? derivacoes / minutos : null, limitadoPor: null, bruto: null };
  }
  const taxa = derivacoes / minutos;
  const bruto = Math.ceil((60 / esperaS) / taxa - 1e-9);
  const porLivre = Math.min(max, Math.max(min, bruto));
  const limitadoPor = bruto > max ? 'teto' : bruto < min ? 'piso' : null;
  return { ...base, fonte: 'taxa', porLivre, taxa: Math.round(taxa * 1000) / 1000, limitadoPor, bruto };
}

/** Robô-minutos ligados numa série de fotos { ts, ligados } (em ordem). */
function roboMinutos(fotos) {
  let ms = 0;
  for (let i = 1; i < fotos.length; i++) {
    const dt = Math.min(Math.max(fotos[i].ts - fotos[i - 1].ts, 0), MAX_INTERVALO_MS);
    ms += dt * (fotos[i - 1].ligados || 0);
  }
  return Math.round((ms / 60_000) * 10) / 10;
}

module.exports = { robosPorLivrePelaTaxa, roboMinutos, metaDo, CALCULO_PADRAO };

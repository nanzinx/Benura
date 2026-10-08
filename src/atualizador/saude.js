'use strict';
/**
 * Espera os serviços responderem no /health depois de um deploy.
 */

const { esperar } = require('../utils/http-client');

async function responde(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} urls
 * @param {{ timeoutMs: number, intervaloMs?: number }} opcoes
 * @returns {Promise<{ ok: boolean, falharam: string[] }>}
 */
async function aguardarSaude(urls, { timeoutMs, intervaloMs = 1000 }) {
  const limite = Date.now() + timeoutMs;
  let falharam = [...urls];
  while (falharam.length && Date.now() < limite) {
    const resultados = await Promise.all(falharam.map(responde));
    falharam = falharam.filter((_, i) => !resultados[i]);
    if (falharam.length) await esperar(intervaloMs);
  }
  return { ok: falharam.length === 0, falharam };
}

module.exports = { aguardarSaude };

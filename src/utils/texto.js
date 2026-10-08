'use strict';
/**
 * Normalização de textos para comparação entre sistemas (Vanguard, Carrossel, Argus).
 */

/**
 * Normaliza um nome: maiúsculas, sem acento, espaços simples.
 * "  Joao  da Silva " e "JOÃO DA SILVA" → "JOAO DA SILVA"
 */
function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Login em maiúsculas e sem espaços (a Argus e o Vanguard não diferenciam caixa). */
const normalizarLogin = (login) => String(login || '').trim().toUpperCase();

module.exports = { normalizarNome, normalizarLogin };

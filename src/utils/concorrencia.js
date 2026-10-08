'use strict';

/**
 * Como `Promise.all(itens.map(fn))`, mas com no máximo `limite` execuções
 * simultâneas. Mantém a ordem dos resultados.
 *
 * @template T, R
 * @param {T[]} itens
 * @param {number} limite
 * @param {(item: T, indice: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapearComLimite(itens, limite, fn) {
  const resultados = new Array(itens.length);
  let proximo = 0;

  async function trabalhador() {
    while (proximo < itens.length) {
      const indice = proximo++;
      resultados[indice] = await fn(itens[indice], indice);
    }
  }

  const trabalhadores = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: trabalhadores }, trabalhador));
  return resultados;
}

module.exports = { mapearComLimite };

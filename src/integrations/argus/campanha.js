'use strict';
/**
 * Campanha dos robôs para o relatório de ligações detalhadas (pede idCampanha).
 */

/**
 * A campanha pedida, ou a única ativa.
 * @param {{ listarCampanhas(): Promise<object[]> }} client
 * @param {number|string} [pedida] - --campanha do script ou CAMPANHA_ROBOS_ID
 * @returns {Promise<number>}
 * @throws {Error} se houver mais de uma ativa e nenhuma foi escolhida
 */
async function escolherCampanha(client, pedida) {
  if (pedida) return Number(pedida);
  const ativas = (await client.listarCampanhas()).filter((c) => c.ativo !== false);
  if (ativas.length === 1) return ativas[0].idCampanha;
  const lista = ativas.map((c) => `${c.idCampanha} (${c.campanhaDesc})`).join(', ');
  throw new Error(`Há ${ativas.length} campanhas ativas: ${lista}. Escolha uma com --campanha <id> (ou CAMPANHA_ROBOS_ID no .env).`);
}

module.exports = { escolherCampanha };

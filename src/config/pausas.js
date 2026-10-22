'use strict';
/**
 * [NOVO] Limites das pausas do receptivo (painel do Receptivo URA), em minutos.
 *
 * O tipo de cada pausa vem da Argus (statusoperador.descricaoPausa, os mesmos nomes
 * do /listarpausas). A pausa casa com o limite quando o nome dela começa com a
 * chave abaixo, sem diferenciar maiúsculas nem acentos ("ALMOÇO 1" → almoço).
 * Pausa sem limite aqui aparece sem limite (nunca "excedida").
 */
module.exports = Object.freeze({
  limitesMin: Object.freeze({
    'almoço': 60,
    descanso: 10,
    banheiro: 5,
    feedback: 15,
  }),
});

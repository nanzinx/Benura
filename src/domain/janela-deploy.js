'use strict';
/**
 * Janela de deploy: atualizar a produção reinicia o roteador e o rodízio,
 * então só acontece quando não há operação.
 *
 *  - Sábado e domingo: liberado o dia todo.
 *  - Dias úteis: só fora do expediente [HORARIO_CARGA, HORARIO_FIM].
 */

const { dentroDoIntervalo } = require('../utils/datas');

const FIM_DE_SEMANA = new Set([0, 6]);

/**
 * @param {object} momento
 * @param {number} momento.diaSemana - 0 = domingo … 6 = sábado
 * @param {string} momento.hora - HH:MM
 * @param {string} momento.inicio - Início do expediente (HH:MM)
 * @param {string} momento.fim - Fim do expediente (HH:MM)
 */
function podeFazerDeploy({ diaSemana, hora, inicio, fim }) {
  if (FIM_DE_SEMANA.has(diaSemana)) return true;
  return !dentroDoIntervalo(hora, inicio, fim);
}

module.exports = { podeFazerDeploy };

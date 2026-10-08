'use strict';
/**
 * Utilitários de data/hora sensíveis ao fuso horário.
 *
 * A versão anterior usava `toISOString()` (UTC): depois das 21h em Brasília
 * o "hoje" já virava o dia seguinte. Aqui tudo é calculado no fuso configurado.
 */

function partes(data, fusoHorario) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fusoHorario,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(data).map(({ type, value }) => [type, value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}

/** @returns {string} Data no formato YYYY-MM-DD no fuso informado. */
const dataLocal = (fusoHorario, agora = new Date()) => partes(agora, fusoHorario).data;

/** @returns {string} Hora no formato HH:MM no fuso informado. */
const horaLocal = (fusoHorario, agora = new Date()) => partes(agora, fusoHorario).hora;

/**
 * Subtrai dias de uma data YYYY-MM-DD (aritmética de calendário, sem fuso).
 * @returns {string} YYYY-MM-DD
 */
function subtrairDias(dataIso, dias) {
  const [a, m, d] = dataIso.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d - dias));
  return dt.toISOString().slice(0, 10);
}

/** Verifica se `hora` (HH:MM) está no intervalo [inicio, fim]. */
const dentroDoIntervalo = (hora, inicio, fim) => hora >= inicio && hora <= fim;

module.exports = { dataLocal, horaLocal, subtrairDias, dentroDoIntervalo };

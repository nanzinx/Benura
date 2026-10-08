'use strict';
/**
 * Conversão e formatação de valores monetários (R$).
 */

/**
 * Converte valores vindos de APIs em número. Aceita:
 *   12500, "12500.50", "12.500,50", "R$ 12.500,50", null/undefined (→ 0)
 *
 * @param {*} valor
 * @returns {number} Valor em reais; 0 quando não for possível interpretar.
 */
function paraNumero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  if (typeof valor !== 'string') return 0;

  let s = valor.replace(/[^\d,.-]/g, '');
  if (!s) return 0;

  // Formato brasileiro: vírgula como separador decimal.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

const formatador = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** @returns {string} Ex.: "R$ 12.500,00" */
const formatarReais = (valor) => formatador.format(valor || 0);

module.exports = { paraNumero, formatarReais };

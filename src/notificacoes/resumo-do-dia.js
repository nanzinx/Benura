'use strict';
/**
 * [NOVO] Texto do resumo do dia (avisos das 18:00): os mesmos números dos quadros do
 * relatório do painel (só as horas do expediente), com o dia anterior e a média de 7 dias.
 * Entra o `relatorio` do /health do rodízio (EstatisticasDia.resumo()).
 */

const DIAS_DA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** Segundos em português, como no painel (painel-web/src/formatos.ts). */
function duracao(seg) {
  if (seg == null || !Number.isFinite(seg) || seg < 0) return '–';
  if (seg < 60) return `${Math.round(seg)} s`;
  if (seg < 3600) return `${Math.floor(seg / 60)} min ${String(Math.floor(seg % 60)).padStart(2, '0')} s`;
  return `${Math.floor(seg / 3600)} h ${String(Math.floor((seg % 3600) / 60)).padStart(2, '0')} min`;
}

function minutos(min) {
  if (min == null || !Number.isFinite(min) || min < 0) return '–';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "2026-10-26" → "seg 26/10". */
function diaCurto(dia) {
  const [, m, d] = String(dia).split('-');
  return m && d ? `${DIAS_DA_SEMANA[new Date(`${dia}T12:00:00Z`).getUTCDay()]} ${d}/${m}` : String(dia);
}

/** Os totais dos quadros: soma das horas; TME e OPL pelas somas. */
function totais(r) {
  const horas = r.horas ?? [];
  const soma = (campo) => Math.round(horas.reduce((t, h) => t + (h[campo] ?? 0), 0) * 10) / 10;
  const livres = soma('livresMin');
  const derivacoes = soma('derivacoes');
  const esperaQtd = soma('esperaQtd');
  return {
    transbordos: r.transbordos ?? 0,
    leadsDerivados: r.leadsDerivados ?? 0,
    tmeSeg: esperaQtd ? Math.round(soma('esperaSomaSeg') / esperaQtd) : null,
    oplSeg: derivacoes ? Math.round((livres * 60) / derivacoes) : null,
    torMin: soma('ociosoSemRobosMin'),
    tpaMin: soma('panicoMin'),
  };
}

/**
 * @param {object} r - relatorio do /health do rodízio
 * @returns {string}
 */
function textoDoResumo(r) {
  const t = totais(r);
  const { anterior = null, semana = null } = r.comparacao ?? {};
  const comparar = (campo, formatar) => {
    const partes = [anterior && `${diaCurto(anterior.dia)}: ${formatar(anterior[campo] ?? null)}`, semana && `7 dias: ${formatar(semana[campo] ?? null)}`].filter(Boolean);
    return partes.length ? ` (${partes.join(' · ')})` : '';
  };
  const numero = (v) => (v == null ? '–' : String(v));
  const vezes = Object.values(r.panicoVezes ?? {}).reduce((s, v) => s + v, 0);
  return [
    `Resumo de ${diaCurto(r.dia)}, no expediente:`,
    `Transbordos: ${t.transbordos}${comparar('transbordos', numero)}`,
    `Leads derivados: ${t.leadsDerivados}${comparar('leadsDerivados', numero)}`,
    `TME: ${duracao(t.tmeSeg)}${comparar('tmeSeg', duracao)}`,
    `OPL: ${duracao(t.oplSeg)}${comparar('oplSeg', duracao)}`,
    `TOR: ${minutos(t.torMin)}${comparar('torMin', minutos)}`,
    `TPA: ${minutos(t.tpaMin)}${vezes ? ` (${vezes} ${vezes === 1 ? 'vez' : 'vezes'})` : ''}${comparar('tpaMin', minutos)}`,
  ].join('\n');
}

module.exports = { textoDoResumo, duracao, minutos, diaCurto };

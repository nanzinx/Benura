'use strict';
/**
 * [NOVO] Sugestões do relatório de 7 e 30 dias, tiradas do próprio histórico (função pura).
 * Só sugere, nunca muda nada. E não compara com pouco dado:
 * - por status (calma, normal, agressiva), conta só dias completos com 2 h ou mais nesse status (horas
 *   em que ele foi a maior parte e os robôs seguiam a configuração; veja EstatisticasDia.porStatusDoDia);
 * - agrupa esses dias pela configuração daquele status (cálculo, robôs por livre, espera alvo e, na calma,
 *   o "todos com N livres"); dia que trocou de configuração no meio não entra;
 * - compara a configuração atual com a anterior só com 3 dias ou mais de cada lado, pelo OPL e pelos
 *   transbordos por hora, só das horas daquele status;
 * - se o lado de OPL melhor teve mais de 30% de transbordos, avisa em vez de apontar um vencedor;
 * - com 2 semanas ou mais (das últimas 8), aponta o dia da semana com o OPL mais alto.
 */

const STATUS = ['calma', 'normal', 'agressiva'];
const MIN_NO_STATUS = 120;
const DIAS_PARA_COMPARAR = 3;
const TRANSBORDOS_PIORA = 1.3;
const SEMANAS_DO_DIA_DA_SEMANA = 8;
const DIAS_DA_SEMANA = ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'];

/** 45 → "45 s"; 190 → "3 min 10 s"; 240 → "4 min". */
function formatarSeg(seg) {
  const s = Math.round(seg);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

const umaCasa = (v) => Math.round(v * 10) / 10;
const numero = (v) => String(umaCasa(v)).replace('.', ',');

/**
 * A configuração de um status num dia: as partes (para a frase) e a chave (para agrupar). Entram o
 * cálculo (taxa ou fixo), os robôs por livre, a espera alvo (taxa) e, na calma, o "todos com N livres".
 */
function configDoStatus(config, status) {
  if (!config) return null;
  const fixo = config.calculo === 'fixo';
  const p = config.porStatus?.[status];
  let robos = null;
  if (!fixo && p && Number.isFinite(p.min) && Number.isFinite(p.max)) robos = p.min === p.max ? `${p.max} robôs por livre` : `de ${p.min} a ${p.max} robôs por livre`;
  else if (Number.isFinite(config.porLivre)) robos = `${config.porLivre} robôs por livre${fixo ? ' (cálculo fixo)' : ''}`;
  if (!robos) return null;
  const todos = status === 'calma' && config.todosComLivresCalma > 0 ? `todos os robôs com ${config.todosComLivresCalma} livres` : '';
  const espera = !fixo && Number.isFinite(p?.esperaS) ? p.esperaS : null;
  return { robos, todos, espera, chave: JSON.stringify([robos, todos, espera]) };
}

/** A configuração inteira, para a linha de progresso. */
const descrever = (c) => [c.robos, c.todos].filter(Boolean).join(', ');

/** O que distingue `c` da `outra` (só o que muda; nada muda além dos robôs: os robôs). */
function diferenca(c, outra) {
  const partes = [];
  if (c.robos !== outra.robos) partes.push(c.robos);
  if (c.todos !== outra.todos) partes.push(c.todos || 'sem o "todos com N livres"');
  if (c.espera !== outra.espera && c.espera != null) partes.push(`espera alvo ${c.espera} s`);
  return partes.length ? partes.join(', ') : c.robos;
}

/** OPL (tempo livre ÷ derivações) e transbordos por hora, só das horas daquele status. */
function medir(dias, status) {
  const somar = (campo) => dias.reduce((t, d) => t + (d.porStatus[status][campo] ?? 0), 0);
  const derivacoes = somar('derivacoes');
  const horas = somar('min') / 60;
  return {
    dias: dias.length,
    oplSeg: derivacoes ? (somar('livresMin') * 60) / derivacoes : null,
    transbordosHora: horas ? somar('transbordos') / horas : 0,
  };
}

function sugestaoDoStatus(status, completos, atual) {
  const grupos = new Map();
  for (const d of completos) {
    if (d.configMudou || !((d.porStatus?.[status]?.min ?? 0) >= MIN_NO_STATUS)) continue;
    const c = configDoStatus(d.config, status);
    if (!c) continue;
    const g = grupos.get(c.chave) ?? { ...c, dias: [], ultimo: '' };
    g.dias.push(d);
    g.ultimo = d.dia > g.ultimo ? d.dia : g.ultimo;
    grupos.set(c.chave, g);
  }
  const daAtual = grupos.get(atual.chave) ?? { ...atual, dias: [] };
  if (daAtual.dias.length < DIAS_PARA_COMPARAR) {
    if (status !== 'calma' && !daAtual.dias.length) return null;
    return {
      tipo: 'progresso',
      texto: `Juntando dados: ${daAtual.dias.length} de ${DIAS_PARA_COMPARAR} dias com a configuração atual da ${status} (${descrever(atual)}), com 2 h ou mais nesse status.`,
    };
  }
  const outra = [...grupos.entries()]
    .filter(([chave, g]) => chave !== atual.chave && g.dias.length >= DIAS_PARA_COMPARAR)
    .sort((a, b) => b[1].ultimo.localeCompare(a[1].ultimo))[0]?.[1];
  if (!outra) return null;
  const a = medir(daAtual.dias, status);
  const o = medir(outra.dias, status);
  if (a.oplSeg == null || o.oplSeg == null) return null;
  const textoDaAtual = diferenca(atual, outra);
  const textoDaOutra = diferenca(outra, atual);
  const frase = `Na ${status}, com ${textoDaAtual}, o OPL médio foi ${formatarSeg(a.oplSeg)} (${a.dias} dias), `
    + `contra ${formatarSeg(o.oplSeg)} com ${textoDaOutra} (${o.dias} dias).`;
  const [melhor, pior, melhorEhAtual] = a.oplSeg <= o.oplSeg ? [a, o, true] : [o, a, false];
  if (melhor.transbordosHora > pior.transbordosHora * TRANSBORDOS_PIORA && melhor.transbordosHora - pior.transbordosHora >= 0.1) {
    return {
      tipo: 'aviso',
      texto: `${frase} Mas os transbordos subiram de ${numero(pior.transbordosHora)} para ${numero(melhor.transbordosHora)} por hora de ${status} `
        + `com ${melhorEhAtual ? 'a atual' : 'a anterior'}: vale pesar os dois antes de mudar.`,
    };
  }
  const transbordos = `Os transbordos ficaram em ${numero(a.transbordosHora)} contra ${numero(o.transbordosHora)} por hora de ${status}.`;
  return {
    tipo: 'comparacao',
    texto: `${frase} ${transbordos} ${melhorEhAtual ? 'A configuração atual está melhor.' : `A anterior (${textoDaOutra}) deixou menos gente parada: vale considerar voltar.`}`,
  };
}

/** OPL do dia inteiro (tempo livre somado ÷ derivações somadas) de um grupo de dias. */
function oplDosDias(dias) {
  const derivacoes = dias.reduce((t, d) => t + (d.derivacoes ?? 0), 0);
  return derivacoes ? (dias.reduce((t, d) => t + (d.livresMin ?? 0), 0) * 60) / derivacoes : null;
}

/** O dia da semana de OPL mais alto, só nas últimas 8 semanas (o que ainda vale para a operação de agora). */
function sugestaoDaSemana(completos) {
  const ultimo = completos.at(-1)?.dia;
  const desde = ultimo ? Date.parse(ultimo) - (SEMANAS_DO_DIA_DA_SEMANA * 7 - 1) * 86_400_000 : 0;
  const comOpl = completos.filter((d) => d.derivacoes > 0 && Date.parse(d.dia) >= desde);
  if (comOpl.length < 10) return null;
  const span = (Date.parse(comOpl.at(-1).dia) - Date.parse(comOpl[0].dia)) / 86_400_000;
  if (span < 13) return null;
  const porDia = new Map();
  for (const d of comOpl) {
    const w = new Date(`${d.dia}T12:00:00Z`).getUTCDay();
    const lista = porDia.get(w) ?? [];
    lista.push(d);
    porDia.set(w, lista);
  }
  const geral = oplDosDias(comOpl);
  const [w, lista] = [...porDia.entries()].filter(([, l]) => l.length >= 2)
    .sort((x, y) => oplDosDias(y[1]) - oplDosDias(x[1]))[0] ?? [];
  if (w == null) return null;
  const opl = oplDosDias(lista);
  if (!(opl > geral * 1.1)) return null;
  return {
    tipo: 'semana',
    texto: `As ${DIAS_DA_SEMANA[w]} têm o OPL mais alto (${formatarSeg(opl)} em média, ${lista.length} dias nas últimas semanas, contra ${formatarSeg(geral)} no geral): vale reforçar os robôs nesse dia.`,
  };
}

/**
 * @param {Array<object>} dias - totais de cada dia (histórico e hoje, com `hoje: true`), em ordem de data
 * @returns {Array<{ tipo: 'comparacao'|'aviso'|'progresso'|'semana', texto: string }>}
 */
function sugestoes(dias) {
  const ordenados = [...(dias ?? [])].sort((a, b) => String(a.dia).localeCompare(String(b.dia)));
  const completos = ordenados.filter((d) => !d.hoje);
  const configAtual = [...ordenados].reverse().find((d) => d.config)?.config;
  const lista = [];
  if (!configAtual) {
    lista.push({
      tipo: 'progresso',
      texto: 'Juntando dados: as sugestões comparam as configurações dos robôs e começam depois de 3 dias completos com a configuração guardada.',
    });
  } else {
    for (const status of STATUS) {
      const atual = configDoStatus(configAtual, status);
      const s = atual && sugestaoDoStatus(status, completos, atual);
      if (s) lista.push(s);
    }
  }
  const semana = sugestaoDaSemana(completos);
  if (semana) lista.push(semana);
  return lista;
}

module.exports = { sugestoes, formatarSeg };

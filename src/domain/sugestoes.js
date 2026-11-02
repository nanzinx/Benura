'use strict';
/**
 * [NOVO] Sugestões do relatório de 7 e 30 dias, tiradas do próprio histórico (função pura).
 * Só sugere, nunca muda nada. E não compara com pouco dado:
 * - por status (calma, normal, agressiva), conta só dias completos em que ele durou 2 h ou mais;
 * - agrupa esses dias pela configuração daquele status (robôs por livre e, na calma, o "todos com N livres");
 * - compara a configuração atual com a anterior só com 3 dias ou mais de cada lado, pelo OPL e pelos transbordos;
 * - se o lado de OPL melhor teve mais de 30% de transbordos, avisa em vez de apontar um vencedor;
 * - com 2 semanas ou mais, aponta o dia da semana com o OPL mais alto.
 */

const STATUS = ['calma', 'normal', 'agressiva'];
const MIN_NO_STATUS = 120;
const DIAS_PARA_COMPARAR = 3;
const TRANSBORDOS_PIORA = 1.3;
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

/** A configuração de um status num dia: o texto (para a frase) e a chave (para agrupar). */
function configDoStatus(config, status) {
  const p = config?.porStatus?.[status];
  const robos = p && Number.isFinite(p.min) && Number.isFinite(p.max)
    ? (p.min === p.max ? `${p.max} robôs por livre` : `de ${p.min} a ${p.max} robôs por livre`)
    : Number.isFinite(config?.porLivre) ? `${config.porLivre} robôs por livre` : null;
  if (!robos) return null;
  const todos = status === 'calma' && config.todosComLivresCalma > 0 ? `, todos os robôs com ${config.todosComLivresCalma} livres` : '';
  const texto = robos + todos;
  return { texto, robos, todos, chave: texto };
}

/** OPL (tempo livre somado ÷ derivações somadas) e transbordos por dia de um grupo de dias. */
function medir(dias) {
  const derivacoes = dias.reduce((t, d) => t + (d.derivacoes ?? 0), 0);
  const livresMin = dias.reduce((t, d) => t + (d.livresMin ?? 0), 0);
  return {
    dias: dias.length,
    oplSeg: derivacoes ? (livresMin * 60) / derivacoes : null,
    transbordosDia: dias.reduce((t, d) => t + (d.transbordos ?? 0), 0) / dias.length,
  };
}

function sugestaoDoStatus(status, completos, atual) {
  const minDoStatus = `${status}Min`;
  const noStatus = completos.filter((d) => (d[minDoStatus] ?? 0) >= MIN_NO_STATUS && configDoStatus(d.config, status));
  const grupos = new Map();
  for (const d of noStatus) {
    const c = configDoStatus(d.config, status);
    const g = grupos.get(c.chave) ?? { ...c, dias: [], ultimo: '' };
    g.dias.push(d);
    g.ultimo = d.dia > g.ultimo ? d.dia : g.ultimo;
    grupos.set(c.chave, g);
  }
  const daAtual = grupos.get(atual.chave) ?? { texto: atual.texto, dias: [] };
  if (daAtual.dias.length < DIAS_PARA_COMPARAR) {
    if (status !== 'calma' && !daAtual.dias.length) return null;
    return {
      tipo: 'progresso',
      texto: `Juntando dados: ${daAtual.dias.length} de ${DIAS_PARA_COMPARAR} dias com a configuração atual da ${status} (${atual.texto}), com 2 h ou mais nesse status.`,
    };
  }
  const outra = [...grupos.entries()]
    .filter(([chave, g]) => chave !== atual.chave && g.dias.length >= DIAS_PARA_COMPARAR)
    .sort((a, b) => b[1].ultimo.localeCompare(a[1].ultimo))[0]?.[1];
  if (!outra) return null;
  const a = medir(daAtual.dias);
  const o = medir(outra.dias);
  if (a.oplSeg == null || o.oplSeg == null) return null;
  // o "todos com N livres" igual dos dois lados não se repete
  const textoDaOutra = outra.todos === atual.todos ? outra.robos : outra.texto;
  const frase = `Na ${status}, com ${atual.texto}, o OPL médio foi ${formatarSeg(a.oplSeg)} (${a.dias} dias), `
    + `contra ${formatarSeg(o.oplSeg)} com ${textoDaOutra} (${o.dias} dias).`;
  const [melhor, pior, melhorEhAtual] = a.oplSeg <= o.oplSeg ? [a, o, true] : [o, a, false];
  if (melhor.transbordosDia > pior.transbordosDia * TRANSBORDOS_PIORA && melhor.transbordosDia - pior.transbordosDia >= 0.5) {
    return {
      tipo: 'aviso',
      texto: `${frase} Mas os transbordos subiram de ${numero(pior.transbordosDia)} para ${numero(melhor.transbordosDia)} por dia `
        + `com ${melhorEhAtual ? 'a atual' : 'a anterior'}: vale pesar os dois antes de mudar.`,
    };
  }
  const transbordos = `Os transbordos ficaram em ${numero(a.transbordosDia)} contra ${numero(o.transbordosDia)} por dia.`;
  return {
    tipo: 'comparacao',
    texto: `${frase} ${transbordos} ${melhorEhAtual ? 'A configuração atual está melhor.' : `A anterior (${textoDaOutra}) deixou menos gente parada: vale considerar voltar.`}`,
  };
}

function sugestaoDaSemana(completos) {
  const comOpl = completos.filter((d) => d.derivacoes > 0);
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
  const geral = medir(comOpl).oplSeg;
  const [w, lista] = [...porDia.entries()].filter(([, l]) => l.length >= 2)
    .sort((x, y) => medir(y[1]).oplSeg - medir(x[1]).oplSeg)[0] ?? [];
  if (w == null) return null;
  const opl = medir(lista).oplSeg;
  if (!(opl > geral * 1.1)) return null;
  return {
    tipo: 'semana',
    texto: `As ${DIAS_DA_SEMANA[w]} têm o OPL mais alto (${formatarSeg(opl)} em média, ${lista.length} dias, contra ${formatarSeg(geral)} no geral): vale reforçar os robôs nesse dia.`,
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

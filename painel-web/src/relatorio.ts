/**
 * [NOVO] Contas do relatório do dia usadas pelos quadros e pela planilha (.xlsx):
 * os totais somam as horas mostradas (só o expediente); TME e OPL saem das somas.
 */

import type { Aba } from './planilha';
import type { DiaDoPeriodo, EstadoTermometro, RelatorioDoDia, RelatorioDoPeriodo, TotaisDoPeriodo } from './tipos';

export function totaisDoRelatorio(r: RelatorioDoDia) {
  const soma = (f: (h: RelatorioDoDia['horas'][number]) => number) => Math.round(r.horas.reduce((s, h) => s + f(h), 0) * 10) / 10;
  const livres = soma((h) => h.livresMin);
  const derivacoes = soma((h) => h.derivacoes);
  const esperaQtd = soma((h) => h.esperaQtd ?? 0);
  return {
    tpa: soma((h) => h.panicoMin),
    tor: soma((h) => h.ociosoSemRobosMin),
    calma: soma((h) => h.calmaMin),
    livres,
    derivacoes,
    esperaQtd,
    opl: derivacoes ? Math.round((livres * 60) / derivacoes) : null,
    tme: esperaQtd ? Math.round(soma((h) => h.esperaSomaSeg ?? 0) / esperaQtd) : null,
  };
}

const DIAS_DA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "2026-10-24" → "sex 24/10". */
export function diaCurto(dia: string): string {
  const [a, m, d] = dia.split('-');
  const semana = DIAS_DA_SEMANA[new Date(`${dia}T12:00:00Z`).getUTCDay()];
  return a && m && d ? `${semana} ${d}/${m}` : dia;
}

/** As abas da planilha: o dia hora a hora (com o total), a comparação e cada atendente. */
export function abasDoRelatorio(r: RelatorioDoDia): Aba[] {
  const t = totaisDoRelatorio(r);
  const [a, m, d] = r.dia.split('-');
  const abas: Aba[] = [{
    nome: `Relatório ${d}-${m}-${a}`,
    linhas: [
      ['Hora', 'Leads derivados', 'TME (s)', 'OPL (s)', 'TOR (min)', 'TPA (min)', 'Calma (min)', 'Transbordos'],
      ...r.horas.map((h) => [`${h.hora}h`, h.leadsDerivados ?? 0, h.tmeSeg ?? null, h.esperaPorDerivacaoSeg, h.ociosoSemRobosMin, h.panicoMin, h.calmaMin, h.transbordos ?? 0]),
      ['Total', r.leadsDerivados ?? 0, t.tme, t.opl, t.tor, t.tpa, t.calma, r.transbordos ?? 0],
    ],
  }];

  const { anterior = null, semana = null } = r.comparacao ?? {};
  if (anterior || semana) {
    abas.push({
      nome: 'Comparação',
      linhas: [
        ['Indicador', 'Hoje', anterior ? diaCurto(anterior.dia) : 'Dia anterior', semana ? `Média 7 dias (${semana.dias} dias)` : 'Média 7 dias'],
        ['Transbordos', r.transbordos ?? 0, anterior?.transbordos, semana?.transbordos],
        ['Leads derivados', r.leadsDerivados ?? 0, anterior?.leadsDerivados, semana?.leadsDerivados],
        ['TME (s)', t.tme, anterior?.tmeSeg, semana?.tmeSeg],
        ['OPL (s)', t.opl, anterior?.oplSeg, semana?.oplSeg],
        ['TOR (min)', t.tor, anterior?.torMin, semana?.torMin],
        ['TPA (min)', t.tpa, anterior?.tpaMin, semana?.tpaMin],
        ['Calma (min)', t.calma, anterior?.calmaMin, semana?.calmaMin],
      ],
    });
  }

  const pessoas = r.porAtendente ?? [];
  if (pessoas.length) {
    abas.push({
      nome: 'Por atendente',
      linhas: [
        ['Nome', 'Ramal', 'Atendimentos', 'Livre (min)', 'Em atendimento (min)', 'Em pausa (min)', 'Pausa (%)', 'Pausas estouradas', 'Maior espera (s)'],
        ...pessoas.map((p) => [p.nome ?? '', p.ramal, p.atendimentos, p.livreMin, p.atendimentoMin, p.pausaMin, p.pausaPct, p.pausasEstouradas, p.maiorEsperaSeg]),
      ],
    });
  }
  return abas;
}

// ───────────── [NOVO] Cores do relatório ─────────────

export type Tendencia = 'melhor' | 'pior' | 'igual';
export type Nivel = 'bom' | 'atencao' | 'ruim';
export type CampoDoQuadro = 'transbordos' | 'torMin' | 'tmeSeg' | 'oplSeg' | 'tpaMin';

/** Hoje comparado com outro dia: em todos os quadros, menor é melhor. */
export function tendencia(hoje: number | null | undefined, outro: number | null | undefined): Tendencia | null {
  if (hoje == null || outro == null) return null;
  return hoje < outro ? 'melhor' : hoje > outro ? 'pior' : 'igual';
}

/**
 * Faixas de cor de cada quadro: até `bom` é verde, até `atencao` é amarelo, acima é vermelho.
 * Mudou a régua da operação, mude aqui.
 */
export const FAIXAS_DOS_QUADROS: Record<CampoDoQuadro, { bom: number; atencao: number }> = {
  transbordos: { bom: 0, atencao: 5 }, // callbacks
  torMin: { bom: 5, atencao: 14.9 }, // minutos ociosos sem robô
  tmeSeg: { bom: 120, atencao: 240 }, // segundos livres antes de cada ligação
  oplSeg: { bom: 180, atencao: 300 }, // segundos livres por ligação
  tpaMin: { bom: 10, atencao: 29.9 }, // minutos de pânico
};

export function nivelDoIndicador(campo: CampoDoQuadro, valor: number | null | undefined): Nivel | null {
  if (valor == null) return null;
  const f = FAIXAS_DOS_QUADROS[campo];
  return valor <= f.bom ? 'bom' : valor <= f.atencao ? 'atencao' : 'ruim';
}

/** Minutos de cada status da URA em cada hora (a barra hora a hora). */
export function statusPorHora(horas: RelatorioDoDia['horas']) {
  return horas.map((h) => {
    const m = { calma: h.calmaMin ?? 0, normal: h.normalMin ?? 0, agressiva: h.agressivaMin ?? 0, medindo: h.medindoMin ?? 0 };
    return { hora: h.hora, ...m, total: Math.round((m.calma + m.normal + m.agressiva + m.medindo) * 10) / 10 };
  });
}

const TITULOS_DO_STATUS: Record<EstadoTermometro, string> = { calma: 'Calma', normal: 'Normal', agressiva: 'Agressiva', medindo: 'Medindo' };
const CAMPO_DO_STATUS = { calma: 'calmaMin', normal: 'normalMin', agressiva: 'agressivaMin', medindo: 'medindoMin' } as const;

type MinutosDosStatus = Partial<Record<(typeof CAMPO_DO_STATUS)[EstadoTermometro], number>>;

/**
 * [NOVO] A coluna da tabela segue o status da URA de agora: título, minutos de cada linha (hora ou,
 * no relatório de 7 e 30 dias, dia) e o total.
 */
export function colunaDoStatus(horas: MinutosDosStatus[], status: EstadoTermometro | null | undefined) {
  const s: EstadoTermometro = status ?? 'calma';
  const porHora = horas.map((h) => h[CAMPO_DO_STATUS[s]] ?? 0);
  return { titulo: TITULOS_DO_STATUS[s], status: s, porHora, total: Math.round(porHora.reduce((t, m) => t + m, 0) * 10) / 10 };
}

/**
 * [NOVO] A linha "mais ociosa" da tabela (hora ou dia): a de OPL mais alto (tempo livre por lead).
 * Linha com gente livre e nenhum lead conta todo o tempo livre. Só marca se passar da faixa verde do OPL.
 */
function maisOcioso<T>(linhas: T[], chave: (x: T) => string, opl: (x: T) => number | null): string | null {
  let pior: { chave: string; seg: number } | null = null;
  for (const x of linhas) {
    const seg = opl(x);
    if (seg != null && (!pior || seg > pior.seg)) pior = { chave: chave(x), seg };
  }
  return pior && pior.seg > FAIXAS_DOS_QUADROS.oplSeg.bom ? pior.chave : null;
}

export function horaMaisOciosa(horas: RelatorioDoDia['horas']): string | null {
  return maisOcioso(horas, (h) => h.hora, (h) => h.esperaPorDerivacaoSeg ?? (h.livresMin > 0 ? h.livresMin * 60 : null));
}

// ───────────── [NOVO] Relatório de 7 e 30 dias ─────────────

/** O dia mais ocioso do período (hoje ainda não acabou: não entra). */
export function diaMaisOcioso(dias: DiaDoPeriodo[]): string | null {
  return maisOcioso(dias.filter((d) => !d.hoje), (d) => d.dia, (d) => d.oplSeg ?? (d.livresMin > 0 ? d.livresMin * 60 : null));
}

/**
 * Os números dos quadros do período, na régua das faixas (que é de um dia): transbordos, TOR e TPA
 * pela média por dia; TME e OPL pelas somas do período.
 */
export function indicadoresDoPeriodo(t: TotaisDoPeriodo | null | undefined): Record<CampoDoQuadro, number | null> | null {
  if (!t) return null;
  return { transbordos: t.transbordosDia, torMin: t.torMinDia, tpaMin: t.tpaMinDia, tmeSeg: t.tmeSeg, oplSeg: t.oplSeg };
}

/** Minutos de cada status da URA em cada dia (a barra dia a dia). */
export function statusPorDia(dias: DiaDoPeriodo[]) {
  return dias.map((d) => {
    const m = { calma: d.calmaMin ?? 0, normal: d.normalMin ?? 0, agressiva: d.agressivaMin ?? 0, medindo: d.medindoMin ?? 0 };
    return { dia: d.dia, ...m, total: Math.round((m.calma + m.normal + m.agressiva + m.medindo) * 10) / 10 };
  });
}

/** A planilha do período: por dia (com o total), os totais com o período anterior e por atendente. */
export function abasDoPeriodo(p: RelatorioDoPeriodo): Aba[] {
  const t = p.totais;
  const a = p.anterior;
  const abas: Aba[] = [{
    nome: 'Por dia',
    linhas: [
      ['Dia', 'Leads derivados', 'TME (s)', 'OPL (s)', 'TOR (min)', 'TPA (min)', 'Calma (min)', 'Normal (min)', 'Agressiva (min)', 'Robôs ligados (média)', 'Transbordos'],
      ...p.dias.map((d) => [`${diaCurto(d.dia)}${d.hoje ? ' (hoje)' : ''}`, d.leadsDerivados, d.tmeSeg, d.oplSeg, d.torMin, d.tpaMin, d.calmaMin, d.normalMin, d.agressivaMin, d.robosLigadosMedia, d.transbordos]),
      ['Total', t.leadsDerivados, t.tmeSeg, t.oplSeg, t.torMin, t.tpaMin, t.calmaMin, t.normalMin, t.agressivaMin, null, t.transbordos],
    ],
  }, {
    nome: 'Totais',
    linhas: [
      ['Indicador', `Últimos ${p.tamanho} dias`, `${p.tamanho} dias antes`],
      ...([
        ['Dias com dados', 'dias'], ['Transbordos', 'transbordos'], ['Transbordos por dia', 'transbordosDia'],
        ['Leads derivados', 'leadsDerivados'], ['Leads por dia', 'leadsDia'], ['TME (s)', 'tmeSeg'], ['OPL (s)', 'oplSeg'],
        ['TOR (min)', 'torMin'], ['TOR por dia (min)', 'torMinDia'], ['TPA (min)', 'tpaMin'], ['TPA por dia (min)', 'tpaMinDia'],
        ['Calma (min)', 'calmaMin'], ['Normal (min)', 'normalMin'], ['Agressiva (min)', 'agressivaMin'],
      ] as const).map(([rotulo, campo]) => [rotulo, t[campo], a ? a[campo] : null]),
    ],
  }];
  if (p.porAtendente.length) {
    abas.push({
      nome: 'Por atendente',
      linhas: [
        ['Nome', 'Ramal', 'Dias', 'Atendimentos', 'Livre (min)', 'Em atendimento (min)', 'Em pausa (min)'],
        ...p.porAtendente.map((x) => [x.nome ?? '', x.ramal, x.dias, x.atendimentos, x.livreMin, x.atendimentoMin, x.pausaMin]),
      ],
    });
  }
  return abas;
}

/**
 * [NOVO] Contas do relatório do dia usadas pelos quadros e pela planilha (.xlsx):
 * os totais somam as horas mostradas (só o expediente); TME e OPL saem das somas.
 */

import type { Aba } from './planilha';
import type { RelatorioDoDia } from './tipos';

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

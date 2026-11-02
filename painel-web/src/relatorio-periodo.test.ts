import { describe, expect, it } from 'vitest';
import { abasDoPeriodo, colunaDoStatus, diaMaisOcioso, horaMaisOciosa, indicadoresDoPeriodo, statusPorDia } from './relatorio';
import type { DiaDoPeriodo, RelatorioDoPeriodo, TotaisDoPeriodo } from './tipos';

const dia = (d: string, x: Partial<DiaDoPeriodo> = {}): DiaDoPeriodo => ({
  dia: d, transbordos: 2, leadsDerivados: 10, derivacoes: 10, tmeSeg: 60, oplSeg: 120, livresMin: 20, torMin: 3, tpaMin: 5,
  calmaMin: 60, normalMin: 300, agressivaMin: 30, medindoMin: 10, robosLigadosMedia: 12.5, ...x,
});
const totais = (x: Partial<TotaisDoPeriodo> = {}): TotaisDoPeriodo => ({
  dias: 3, transbordos: 9, leadsDerivados: 30, derivacoes: 30, livresMin: 60, torMin: 9, tpaMin: 15, torMinDia: 3, tpaMinDia: 5, transbordosDia: 3, leadsDia: 10,
  calmaMin: 180, normalMin: 900, agressivaMin: 90, medindoMin: 30, tmeSeg: 60, oplSeg: 120, ...x,
});
const p: RelatorioDoPeriodo = {
  tamanho: 7, desde: '2026-10-27',
  dias: [dia('2026-10-27'), dia('2026-10-28', { oplSeg: 410, transbordos: 5 }), dia('2026-11-02', { hoje: true, oplSeg: 200 })],
  totais: totais(), anterior: totais({ transbordosDia: 4, torMinDia: 2 }),
  porAtendente: [{ ramal: '201', nome: 'Ana', dias: 3, atendimentos: 30, livreMin: 45, atendimentoMin: 600, pausaMin: 40 }],
  sugestoes: [{ tipo: 'progresso', texto: 'Juntando dados: 1 de 3 dias' }],
};

describe('relatório de 7 e 30 dias', () => {
  it('indicadores dos quadros: transbordos, TOR e TPA por dia (para comparar com as faixas); TME e OPL do período', () => {
    expect(indicadoresDoPeriodo(p.totais)).toEqual({ transbordos: 3, torMin: 3, tpaMin: 5, tmeSeg: 60, oplSeg: 120 });
    expect(indicadoresDoPeriodo(null)).toBeNull();
  });

  it('o dia mais ocioso é o de OPL mais alto, só acima da faixa verde (a mesma regra da hora)', () => {
    expect(diaMaisOcioso(p.dias)).toBe('2026-10-28');
    expect(diaMaisOcioso([dia('2026-10-27'), dia('2026-10-28', { oplSeg: 150 })])).toBeNull();
    expect(diaMaisOcioso([dia('2026-10-27', { oplSeg: 200 }), dia('2026-11-02', { hoje: true, oplSeg: 900 })]), 'hoje ainda não acabou').toBe('2026-10-27');
    expect(diaMaisOcioso([dia('2026-10-27', { oplSeg: null, derivacoes: 0, livresMin: 10 })]), 'sem lead: todo o tempo livre').toBe('2026-10-27');
    // a regra da hora continua a mesma
    expect(horaMaisOciosa([{ hora: '08', livresMin: 0, derivacoes: 0, esperaPorDerivacaoSeg: 400, ociosoSemRobosMin: 0, panicoMin: 0, calmaMin: 0, agressivaMin: 0 }])).toBe('08');
  });

  it('a coluna do status também vale para os dias', () => {
    expect(colunaDoStatus(p.dias, 'normal')).toMatchObject({ titulo: 'Normal', porHora: [300, 300, 300], total: 900 });
  });

  it('status por dia: minutos de cada status e o total', () => {
    expect(statusPorDia(p.dias)[0]).toEqual({ dia: '2026-10-27', calma: 60, normal: 300, agressiva: 30, medindo: 10, total: 400 });
  });

  it('planilha do período: por dia (com o total), totais com o período anterior e por atendente', () => {
    const abas = abasDoPeriodo(p);
    expect(abas.map((a) => a.nome)).toEqual(['Por dia', 'Totais', 'Por atendente']);
    expect(abas[0]!.linhas[0]![0]).toBe('Dia');
    expect(abas[0]!.linhas[1]).toEqual(['ter 27/10', 10, 60, 120, 3, 5, 60, 300, 30, 12.5, 2]);
    expect(abas[0]!.linhas.at(-1)?.[0]).toBe('Total');
    expect(abas[1]!.linhas[0]).toEqual(['Indicador', 'Últimos 7 dias', '7 dias antes']);
    expect(abas[1]!.linhas.find((l) => l[0] === 'Transbordos por dia')).toEqual(['Transbordos por dia', 3, 4]);
    expect(abas[2]!.linhas[1]).toEqual(['Ana', '201', 3, 30, 45, 600, 40]);
  });
});

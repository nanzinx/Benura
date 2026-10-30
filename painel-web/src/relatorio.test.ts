import { describe, expect, it } from 'vitest';
import { abasDoRelatorio, diaCurto, nivelDoIndicador, statusPorHora, tendencia, totaisDoRelatorio } from './relatorio';
import type { RelatorioDoDia } from './tipos';

const hora = (h: string, x: Partial<RelatorioDoDia['horas'][number]>) => ({
  hora: h, livresMin: 0, derivacoes: 0, esperaPorDerivacaoSeg: null, ociosoSemRobosMin: 0, panicoMin: 0, calmaMin: 0, agressivaMin: 0, ...x,
});
const r: RelatorioDoDia = {
  dia: '2026-10-27', livresMin: 0, derivacoes: 0, esperaPorDerivacaoSeg: null, ociosoSemRobosMin: 0,
  panicoMin: { zero: 0, saindo: 0, fixo: 0 }, panicoVezes: { zero: 1, saindo: 0, fixo: 1 }, termometroMin: { medindo: 0, calma: 0, normal: 0, agressiva: 0 },
  leadsDerivados: 30, transbordos: 3,
  horas: [
    hora('08', { livresMin: 20, derivacoes: 10, esperaSomaSeg: 600, esperaQtd: 10, tmeSeg: 60, esperaPorDerivacaoSeg: 120, ociosoSemRobosMin: 2, panicoMin: 5, leadsDerivados: 10, transbordos: 1 }),
    hora('09', { livresMin: 40, derivacoes: 10, esperaSomaSeg: 1200, esperaQtd: 10, tmeSeg: 120, esperaPorDerivacaoSeg: 240, ociosoSemRobosMin: 1, panicoMin: 0, leadsDerivados: 20, transbordos: 2 }),
  ],
  porAtendente: [{ ramal: '1001', nome: 'Ana', primeiroEm: null, ultimoEm: null, livreMin: 30, atendimentoMin: 60, outroMin: 0, pausaMin: 10, pausasMin: {}, pausaPct: 10, atendimentos: 12, pausasEstouradas: 1, maiorEsperaSeg: 300 }],
  comparacao: {
    anterior: { dia: '2026-10-23', transbordos: 5, leadsDerivados: 40, derivacoes: 30, esperaSomaSeg: 2700, esperaQtd: 30, livresMin: 90, torMin: 4, tpaMin: 8, calmaMin: 0, tmeSeg: 90, oplSeg: 180 },
    semana: { dias: 4, transbordos: 4, leadsDerivados: 35, torMin: 3.5, tpaMin: 6, calmaMin: 1, tmeSeg: 80, oplSeg: 170 },
  },
};

describe('relatório do dia', () => {
  it('totais como nos quadros: soma das horas; TME e OPL pela soma', () => {
    const t = totaisDoRelatorio(r);
    expect([t.tor, t.tpa, t.livres, t.derivacoes]).toEqual([3, 5, 60, 20]);
    expect(t.tme).toBe(90);
    expect(t.opl).toBe(180);
  });

  it('dia curto para a comparação', () => {
    expect(diaCurto('2026-10-23')).toBe('sex 23/10');
  });

  it('planilha: horas + total, comparação e por atendente', () => {
    const [dia, comp, pessoas] = abasDoRelatorio(r);
    expect(dia!.nome).toBe('Relatório 27-10-2026');
    expect(dia!.linhas[0]).toEqual(['Hora', 'Leads derivados', 'TME (s)', 'OPL (s)', 'TOR (min)', 'TPA (min)', 'Calma (min)', 'Transbordos']);
    expect(dia!.linhas[1]).toEqual(['08h', 10, 60, 120, 2, 5, 0, 1]);
    expect(dia!.linhas.at(-1)).toEqual(['Total', 30, 90, 180, 3, 5, 0, 3]);
    expect(comp!.linhas[0]).toEqual(['Indicador', 'Hoje', 'sex 23/10', 'Média 7 dias (4 dias)']);
    expect(comp!.linhas.find((l) => l[0] === 'Transbordos')).toEqual(['Transbordos', 3, 5, 4]);
    expect(pessoas!.linhas[1]).toEqual(['Ana', '1001', 12, 30, 60, 10, 10, 1, 300]);
  });

  it('sem histórico nem atendentes, só a aba do dia', () => {
    expect(abasDoRelatorio({ ...r, comparacao: { anterior: null, semana: null }, porAtendente: [] })).toHaveLength(1);
  });
});

describe('cores do relatório', () => {
  it('tendencia: menor é melhor; igual ou sem dado, neutro', () => {
    expect(tendencia(3, 8)).toBe('melhor');
    expect(tendencia(10, 8)).toBe('pior');
    expect(tendencia(8, 8)).toBe('igual');
    expect(tendencia(null, 8)).toBeNull();
    expect(tendencia(3, null)).toBeNull();
  });

  it('nivelDoIndicador: bom, atenção ou ruim pelas faixas de cada quadro', () => {
    expect(nivelDoIndicador('transbordos', 0)).toBe('bom');
    expect(nivelDoIndicador('transbordos', 3)).toBe('atencao');
    expect(nivelDoIndicador('transbordos', 6)).toBe('ruim');
    expect(nivelDoIndicador('torMin', 1)).toBe('bom');
    expect(nivelDoIndicador('torMin', 15)).toBe('ruim');
    expect(nivelDoIndicador('tmeSeg', 232)).toBe('atencao');
    expect(nivelDoIndicador('oplSeg', 100)).toBe('bom');
    expect(nivelDoIndicador('tpaMin', 45)).toBe('ruim');
    expect(nivelDoIndicador('tmeSeg', null)).toBeNull();
  });

  it('statusPorHora: os minutos de cada status em cada hora, e o que sobra até 60 min fica de fora', () => {
    const h = { ...hora('09', { calmaMin: 30, agressivaMin: 10 }), normalMin: 15, medindoMin: 5 };
    expect(statusPorHora([h])).toEqual([{ hora: '09', calma: 30, normal: 15, agressiva: 10, medindo: 5, total: 60 }]);
  });
});

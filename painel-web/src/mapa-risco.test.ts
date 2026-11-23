import { describe, expect, it } from 'vitest';
import { celulasDoMapa, faixaLarga, FAIXAS_LIVRES, FAIXAS_ROBOS, foraDoMapa, nivelDaCelula, pontoSeguro, resumoDoMapa, taxaEmTexto } from './mapa-risco';

const mapa = {
  '1|31-40|calma': { leads: 198, fila: 2, invisiveis: 1 },
  '1|31-40|agressiva': { leads: 10, fila: 1, invisiveis: 2 },
  '3|41+|normal': { leads: 300, fila: 0, invisiveis: 0 },
  '0|41+|calma': { leads: 0, fila: 3, invisiveis: 0 },
};

describe('mapa de risco dos robôs', () => {
  it('a grade inteira (livres × robôs), de todos os status ou de um', () => {
    const todos = celulasDoMapa(mapa, null);
    expect(todos).toHaveLength(FAIXAS_LIVRES.length * FAIXAS_ROBOS.length);
    expect(todos.find((c) => c.livres === '1' && c.robos === '21-40')).toMatchObject({ leads: 208, fila: 3, invisiveis: 3 });
    expect(celulasDoMapa(mapa, 'calma').find((c) => c.livres === '1' && c.robos === '21-40')).toMatchObject({ leads: 198, fila: 2 });
  });

  it('[NOVO] as faixas de 10 do servidor viram colunas de 20 (enchem mais rápido)', () => {
    expect(FAIXAS_ROBOS).toEqual(['0', '1-20', '21-40', '41+']);
    expect(['0', '1-10', '11-20', '21-30', '31-40', '41+', 'x'].map(faixaLarga)).toEqual(['0', '1-20', '1-20', '21-40', '21-40', '41+', null]);
    const c = celulasDoMapa({ '2|1-10|normal': { leads: 30, fila: 0, invisiveis: 0 }, '2|11-20|calma': { leads: 25, fila: 1, invisiveis: 1 } }, null)
      .find((x) => x.livres === '2' && x.robos === '1-20');
    expect(c).toMatchObject({ leads: 55, fila: 1, invisiveis: 1 });
    expect(nivelDaCelula(c!)).not.toBe('pouca'); // 30 + 26: sozinhas seriam pouca amostra
  });

  it('nível pela meta de 1 em 200 (0,5%): verde até ela, âmbar até 1%, vermelho acima; pouca amostra e vazia à parte', () => {
    const c = (leads: number, fila: number) => ({ livres: '1', robos: '1-10', leads, fila, invisiveis: 0 });
    expect(nivelDaCelula(c(199, 1))).toBe('bom');
    expect(nivelDaCelula(c(990, 10))).toBe('atencao');
    expect(nivelDaCelula(c(98, 2))).toBe('ruim');
    expect(nivelDaCelula(c(30, 0))).toBe('pouca');
    expect(nivelDaCelula(c(0, 0))).toBe('vazia');
  });

  it('a taxa em texto, com vírgula', () => {
    expect(taxaEmTexto({ livres: '1', robos: '1-10', leads: 199, fila: 1, invisiveis: 0 })).toBe('0,5%');
    expect(taxaEmTexto({ livres: '1', robos: '1-10', leads: 2000, fila: 3, invisiveis: 0 })).toBe('0,15%');
    expect(taxaEmTexto({ livres: '1', robos: '1-10', leads: 0, fila: 0, invisiveis: 0 })).toBe('–');
  });

  it('resumo do período: leads, callbacks de fila e invisíveis, e quantos de 200', () => {
    expect(resumoDoMapa(mapa, null)).toEqual({ leads: 508, fila: 6, invisiveis: 3, porDuzentos: 2.3 });
    expect(resumoDoMapa({}, null)).toEqual({ leads: 0, fila: 0, invisiveis: 0, porDuzentos: null });
  });

  it('ponto seguro: para cada tanto de livres, a maior faixa de robôs no verde antes da primeira fora da meta', () => {
    const m = {
      '1|1-10|calma': { leads: 220, fila: 0, invisiveis: 0 },
      '1|11-20|calma': { leads: 310, fila: 1, invisiveis: 0 }, // 1-20: 0,19% (verde)
      '1|21-30|calma': { leads: 180, fila: 2, invisiveis: 0 }, // 21-40: 1,1% (vermelho): para aqui
      '1|41+|calma': { leads: 400, fila: 0, invisiveis: 0 }, // verde depois do vermelho não conta
      '2|11-20|calma': { leads: 420, fila: 1, invisiveis: 0 },
      '2|21-30|calma': { leads: 20, fila: 0, invisiveis: 0 },
      '2|31-40|calma': { leads: 300, fila: 1, invisiveis: 0 }, // 21-40: 0,31% (verde)
      '2|41+|calma': { leads: 20, fila: 0, invisiveis: 0 }, // pouca amostra: pula
      '3|1-10|calma': { leads: 98, fila: 2, invisiveis: 0 }, // já começa vermelho
    };
    const p = pontoSeguro(celulasDoMapa(m, null));
    expect(p.find((x) => x.livres === '1')).toEqual({ livres: '1', ate: '1-20', parou: '21-40' });
    expect(p.find((x) => x.livres === '2')).toEqual({ livres: '2', ate: '21-40', parou: null });
    expect(p.find((x) => x.livres === '3')).toEqual({ livres: '3', ate: null, parou: '1-20' });
    expect(p.find((x) => x.livres === '4+')).toEqual({ livres: '4+', ate: null, parou: null });
    expect(p.map((x) => x.livres)).toEqual(['1', '2', '3', '4+']); // com 0 livre não há ponto seguro: é sempre fila
  });

  it('célula só com invisíveis não some: vira pouca amostra, com a taxa "–"', () => {
    const c = { livres: '2', robos: '1-20', leads: 0, fila: 0, invisiveis: 2 };
    expect(nivelDaCelula(c)).toBe('pouca');
    expect(taxaEmTexto(c)).toBe('–');
    expect(nivelDaCelula({ ...c, invisiveis: 0 })).toBe('vazia');
  });

  it('fora do mapa: os transbordos do período que o mapa não tem (antes de ele começar ou sem foto)', () => {
    expect(foraDoMapa(24, { fila: 0, invisiveis: 2 })).toBe(22);
    expect(foraDoMapa(3, { fila: 2, invisiveis: 2 })).toBe(0);
    expect(foraDoMapa(undefined, { fila: 0, invisiveis: 0 })).toBe(0);
  });
});

describe('[NOVO] motivos dos de fila e teto sugerido', () => {
  it('soma os motivos por quadrinho (faixa larga) e no período, respeitando o status', async () => {
    const { motivosDe } = await import('./mapa-risco');
    const motivos = {
      '1|0|normal': { juntas: 2, semLivre: 1 },
      '1|0|calma': { juntas: 1 },
      '1|11-20|normal': { carencia: 1 },
      '2|0|normal': { semLivre: 4 },
    };
    expect(motivosDe(motivos, null, '1', '0')).toEqual({ juntas: 3, semLivre: 1, carencia: 0 });
    expect(motivosDe(motivos, 'normal', '1', '0')).toEqual({ juntas: 2, semLivre: 1, carencia: 0 });
    expect(motivosDe(motivos, null, '1', '1-20')).toEqual({ juntas: 0, semLivre: 0, carencia: 1 });
    expect(motivosDe(motivos, null)).toEqual({ juntas: 3, semLivre: 5, carencia: 1 });
    expect(motivosDe(undefined, null)).toEqual({ juntas: 0, semLivre: 0, carencia: 0 });
  });

  it('teto sugerido para os livres de agora: o "até onde ficou na meta" em número de robôs', async () => {
    const { tetoSugerido } = await import('./mapa-risco');
    const pontos = [
      { livres: '1', ate: '1-20', parou: '21-40' },
      { livres: '2', ate: '41+', parou: null },
      { livres: '3', ate: null, parou: '1-20' },
      { livres: '4+', ate: '21-40', parou: null },
    ];
    expect(tetoSugerido(pontos, 1).teto).toBe(20);
    expect(tetoSugerido(pontos, 2).teto).toBe(Infinity);
    expect(tetoSugerido(pontos, 3).teto).toBeNull(); // nem a menor faixa ficou na meta: não sugere
    expect(tetoSugerido(pontos, 7).teto).toBe(40);
    expect(tetoSugerido(pontos, 0)).toEqual({ teto: null, ponto: null });
    expect(tetoSugerido(pontos, null).teto).toBeNull();
  });
});

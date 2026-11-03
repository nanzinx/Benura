import { describe, expect, it } from 'vitest';
import { celulasDoMapa, FAIXAS_LIVRES, FAIXAS_ROBOS, nivelDaCelula, resumoDoMapa, taxaEmTexto } from './mapa-risco';

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
    expect(todos.find((c) => c.livres === '1' && c.robos === '31-40')).toMatchObject({ leads: 208, fila: 3, invisiveis: 3 });
    expect(celulasDoMapa(mapa, 'calma').find((c) => c.livres === '1' && c.robos === '31-40')).toMatchObject({ leads: 198, fila: 2 });
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
});

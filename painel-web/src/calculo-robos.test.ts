import { describe, expect, it } from 'vitest';
import { descreverCalculo } from './calculo-robos';
import type { CalculoRobos } from './tipos';

const base: CalculoRobos = {
  fonte: 'taxa', status: 'calma', esperaAlvoS: 45, min: 6, max: 15, taxa: 0.08, bruto: 17, porLivre: 15, limitadoPor: 'teto', todosComLivres: 0,
  derivacoes30: 24, roboMinutos30: 300,
};

describe('descreverCalculo', () => {
  it('taxa valendo: meta do status, taxa e o resultado (com o teto quando bate)', () => {
    expect(descreverCalculo(base)).toBe('Calma: espera alvo 45 s · cada robô deriva 0,08 por min (30 min) → 17 por livre, teto 15');
    expect(descreverCalculo({ ...base, status: 'normal', esperaAlvoS: 90, bruto: 7, porLivre: 7, limitadoPor: null }))
      .toBe('Normal: espera alvo 90 s · cada robô deriva 0,08 por min (30 min) → 7 por livre');
    expect(descreverCalculo({ ...base, status: 'agressiva', esperaAlvoS: 120, min: 2, bruto: 1, porLivre: 2, limitadoPor: 'piso' }))
      .toBe('Agressiva: espera alvo 120 s · cada robô deriva 0,08 por min (30 min) → 1 por livre, piso 2');
  });

  it('medindo: diz o que tem até agora e entre quanto fica', () => {
    expect(descreverCalculo({ ...base, fonte: 'medindo', taxa: null, bruto: null, porLivre: null, limitadoPor: null, derivacoes30: 2, roboMinutos30: 12.5 }))
      .toBe('Calma: medindo a taxa (2 derivações e 12,5 robô-min em 30 min); até lá vale o ajuste do dia, entre 6 e 15 por livre');
  });

  it('calma com "todos com N livres": diz', () => {
    expect(descreverCalculo({ ...base, min: 20, max: 20, bruto: 14, porLivre: 20, limitadoPor: 'piso', todosComLivres: 2 }))
      .toBe('Calma: espera alvo 45 s · cada robô deriva 0,08 por min (30 min) → 14 por livre, piso 20; com 2 livres ou mais, todos os robôs');
  });

  it('à mão hoje: vale o escolhido até virar o dia', () => {
    expect(descreverCalculo({ ...base, fonte: 'manual' })).toBe('Por livre escolhido à mão hoje: vale até virar o dia (a taxa agora é 0,08 por robô por min)');
    expect(descreverCalculo({ ...base, fonte: 'manual', taxa: null })).toBe('Por livre escolhido à mão hoje: vale até virar o dia');
  });

  it('sem conta (ROBOS_CALCULO=fixo): nada', () => {
    expect(descreverCalculo(null)).toBeNull();
    expect(descreverCalculo(undefined)).toBeNull();
  });
});

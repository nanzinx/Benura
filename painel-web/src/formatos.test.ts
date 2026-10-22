import { describe, expect, it } from 'vitest';
import { dataBr, degraus, duracao, horaDeSegundos, minutos, motivoLegivel, reais, segundosDoDia } from './formatos';

describe('formatos', () => {
  it('minutos para leitura rápida', () => {
    expect(minutos(0)).toBe('0 min');
    expect(minutos(12.4)).toBe('12 min');
    expect(minutos(65)).toBe('1 h 05 min');
    expect(minutos(null)).toBe('–');
  });

  it('duração em português', () => {
    expect(duracao(45)).toBe('45 s');
    expect(duracao(185)).toBe('3 min 05 s');
    expect(duracao(7620)).toBe('2 h 07 min');
    expect(duracao(null)).toBe('–');
  });

  it('horas, datas e dinheiro', () => {
    expect(segundosDoDia('08:31:00')).toBe(30660);
    expect(horaDeSegundos(30660)).toBe('08:31');
    expect(dataBr('2026-10-20')).toBe('20/10/2026');
    expect(reais(18450.5).replace(/\s/g, ' ')).toBe('R$ 18.450,50');
    expect(motivoLegivel('PÂNICO: 0 livre na URA')).toBe('0 livre na URA');
  });

  it('linha do tempo em degraus: estende até agora e corta pela janela', () => {
    const pontos = [{ hora: '08:00:00', n: 2 }, { hora: '09:00:00', n: 1 }, { hora: '10:00:00', n: 3 }];
    const agora = segundosDoDia('10:30:00');
    expect(degraus(pontos, (p) => p.n, { agora, janelaSeg: null }).map((p) => p.y)).toEqual([2, 1, 3, 3]);
    // Última hora (9:30 → 10:30): começa com o valor que valia às 9:30.
    expect(degraus(pontos, (p) => p.n, { agora, janelaSeg: 3600 })).toEqual([
      { t: segundosDoDia('09:30:00'), y: 1 }, { t: segundosDoDia('10:00:00'), y: 3 }, { t: agora, y: 3 },
    ]);
    expect(degraus([{ hora: '08:00:00', n: null }], (p) => p.n, { agora, janelaSeg: null })).toEqual([]);
  });
});

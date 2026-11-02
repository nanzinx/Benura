import { describe, expect, it } from 'vitest';
import { faixaDosRobos } from './faixa-robos';
import type { Visao } from './tipos';

const visao = (x: { robosOnline?: boolean; emergencia?: boolean; separado?: boolean; aMao?: boolean; parada?: boolean; respondeuEm?: string | null } = {}) => ({
  servicos: {
    rodizio: { nome: 'Rodízio de pessoas', online: true, ms: 1, dados: { servicoDosRobos: { respondendo: x.robosOnline !== false, respondeuEm: x.respondeuEm ?? '2026-11-02T12:00:00.000Z', emergencia: Boolean(x.emergencia) } } },
    ...(x.separado === false ? {} : { robos: { nome: 'Robôs da URA', online: x.robosOnline !== false, ms: 1, dados: null } }),
  },
  automacao: { estado: x.parada ? 'desligada' : 'ligada', componentes: x.aMao ? { 'benura-robos': { desligado: true, desde: null, por: null } } : {} },
}) as unknown as Visao;

describe('faixa do serviço dos robôs', () => {
  it('no ar e respondendo: nenhuma', () => {
    expect(faixaDosRobos(visao())).toBeNull();
  });
  it('fora do ar: faixa vermelha dizendo que o rodízio de pessoas segue', () => {
    const f = faixaDosRobos(visao({ robosOnline: false }));
    expect(f?.titulo).toMatch(/Serviço dos robôs fora do ar/);
    expect(f?.detalhe).toMatch(/rodízio de pessoas segue/);
  });
  it('a rede de segurança agiu: diz que os robôs parados pararam de discar', () => {
    expect(faixaDosRobos(visao({ robosOnline: false, emergencia: true }))?.titulo).toMatch(/os robôs parados pararam de discar/);
  });
  it('desligado à mão, automação parada ou robôs no rodízio (não separado): nenhuma', () => {
    expect(faixaDosRobos(visao({ robosOnline: false, aMao: true }))).toBeNull();
    expect(faixaDosRobos(visao({ robosOnline: false, parada: true }))).toBeNull();
    expect(faixaDosRobos(visao({ separado: false }))).toBeNull();
  });
});

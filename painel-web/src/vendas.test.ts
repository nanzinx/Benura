import { describe, expect, it } from 'vitest';
import { acimaDaMeta, chegaram, diaCurto, haQuanto, iniciais, metaBatidaOntem, recente, somaDasVendas, subiramHoje, tomDoAvatar } from './vendas';

const status = {
  meta: 50000,
  ura: [
    { ramal: '1', nome: 'Ana', vendaOntem: 61000, promovidoNoDia: false },
    { ramal: '2', nome: 'Bia', vendaOntem: 20000, promovidoNoDia: true, vendaQueDisparou: 9000, promovidoEm: '2026-11-02T13:40:00.000Z' },
    { ramal: '3', nome: 'Caio', vendaOntem: 72000, promovidoNoDia: true, vendaQueDisparou: 25000, promovidoEm: '2026-11-02T12:05:00.000Z' },
  ],
  ativo: [
    { ramal: '4', nome: 'Davi', vendaOntem: 50000 },
    { ramal: '5', nome: 'Eva', vendaOntem: 53000 },
    { ramal: '6', nome: 'Fábio', vendaOntem: null },
  ],
};

describe('vendas', () => {
  it('meta batida ontem: URA e Ativo, venda acima da meta, do maior para o menor', () => {
    expect(metaBatidaOntem(status).map((v) => v.nome)).toEqual(['Caio', 'Ana', 'Eva']);
    expect(metaBatidaOntem(undefined)).toEqual([]);
  });

  it('subiram hoje: do maior para o menor; quem também bateu a meta ontem aparece nas duas', () => {
    expect(subiramHoje(status).map((v) => v.nome)).toEqual(['Caio', 'Bia']);
    expect(metaBatidaOntem(status).some((v) => v.nome === 'Caio')).toBe(true);
  });

  it('dia curto', () => {
    expect(diaCurto('20/10/2026')).toBe('20/10');
    expect(diaCurto(null)).toBeNull();
  });

  it('subiram hoje, mais recentes primeiro (sem a hora, ficam no fim)', () => {
    const com = { ...status, ativo: [...status.ativo, { ramal: '7', nome: 'Gil', promovidoNoDia: true, vendaQueDisparou: 99000 }] };
    expect(subiramHoje(com, 'recentes').map((v) => v.nome)).toEqual(['Bia', 'Caio', 'Gil']);
    expect(subiramHoje(com, 'valor').map((v) => v.nome)).toEqual(['Gil', 'Caio', 'Bia']);
    expect(somaDasVendas(subiramHoje(status))).toBe(34000);
  });

  it('quem chegou desde a última leitura (na primeira, ninguém: não anima ao abrir a página)', () => {
    const lista = subiramHoje(status);
    expect(chegaram(null, lista)).toEqual([]);
    expect(chegaram(new Set(['3']), lista)).toEqual(['2']);
    expect(chegaram(new Set(['2', '3']), lista)).toEqual([]);
  });

  it('subiu há pouco (15 min): o selo "novo"', () => {
    const agora = Date.parse('2026-11-02T13:50:00.000Z');
    expect(recente({ ramal: '2', promovidoEm: '2026-11-02T13:40:00.000Z' }, agora)).toBe(true);
    expect(recente({ ramal: '3', promovidoEm: '2026-11-02T12:05:00.000Z' }, agora)).toBe(false);
    expect(recente({ ramal: '4' }, agora)).toBe(false);
  });

  it('há quanto tempo subiu', () => {
    const agora = Date.parse('2026-11-02T13:50:00.000Z');
    expect(haQuanto('2026-11-02T13:49:40.000Z', agora)).toBe('agora');
    expect(haQuanto('2026-11-02T13:40:00.000Z', agora)).toBe('há 10 min');
    expect(haQuanto('2026-11-02T12:50:00.000Z', agora)).toBe('há 1 h');
    expect(haQuanto('2026-11-02T12:05:00.000Z', agora)).toBe('há 1 h 45 min');
    expect(haQuanto(undefined, agora)).toBeNull();
  });

  it('avatar: iniciais do nome e um tom fixo por vendedor', () => {
    expect(iniciais('Caio Souza Lima')).toBe('CL');
    expect(iniciais('Bia')).toBe('B');
    expect(iniciais(undefined, '1004')).toBe('04');
    expect(tomDoAvatar('1004')).toBe(tomDoAvatar('1004'));
    expect(new Set(['1', '2', '3', '4', '5', '6', '7', '8'].map(tomDoAvatar)).size).toBeGreaterThan(3);
    for (const r of ['1', '22', '333']) expect(tomDoAvatar(r)).toBeGreaterThanOrEqual(0);
  });

  it('meta batida ontem: quanto passou da meta (em % e em reais) e a barra em relação à maior venda', () => {
    expect(acimaDaMeta(72500, 50000, 98100)).toEqual({ porcento: 145, sobra: 22500, barra: 74 });
    expect(acimaDaMeta(98100, 50000, 98100)).toEqual({ porcento: 196, sobra: 48100, barra: 100 });
    expect(acimaDaMeta(50001, 50000, 0)).toEqual({ porcento: 100, sobra: 1, barra: 100 });
    expect(acimaDaMeta(null, undefined, 10)).toEqual({ porcento: null, sobra: null, barra: 0 });
  });
});

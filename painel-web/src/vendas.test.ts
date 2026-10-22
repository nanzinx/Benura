import { describe, expect, it } from 'vitest';
import { diaCurto, metaBatidaOntem, subiramHoje } from './vendas';

const status = {
  meta: 50000,
  ura: [
    { ramal: '1', nome: 'Ana', vendaOntem: 61000, promovidoNoDia: false },
    { ramal: '2', nome: 'Bia', vendaOntem: 20000, promovidoNoDia: true, vendaQueDisparou: 9000 },
    { ramal: '3', nome: 'Caio', vendaOntem: 72000, promovidoNoDia: true, vendaQueDisparou: 25000 },
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
});

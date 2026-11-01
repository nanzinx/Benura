import { describe, expect, it } from 'vitest';
import { deveMostrarEntrada, primeiroNome, saudacao, valorNaContagem } from './boas-vindas';

describe('boas-vindas', () => {
  it('saudação pela hora de Brasília', () => {
    expect(saudacao(new Date('2026-11-03T11:00:00Z'))).toBe('Bom dia'); // 08:00
    expect(saudacao(new Date('2026-11-03T15:30:00Z'))).toBe('Boa tarde'); // 12:30
    expect(saudacao(new Date('2026-11-03T22:00:00Z'))).toBe('Boa noite'); // 19:00
    expect(saudacao(new Date('2026-11-03T06:00:00Z'))).toBe('Boa noite'); // 03:00
  });

  it('primeiro nome, com a primeira letra maiúscula', () => {
    expect(primeiroNome('RENAN LEITE DA SILVA')).toBe('Renan');
    expect(primeiroNome('  ana  ')).toBe('Ana');
    expect(primeiroNome('')).toBeNull();
    expect(primeiroNome(undefined)).toBeNull();
  });

  it('aparece uma vez por dia; logo depois de entrar, aparece sempre', () => {
    expect(deveMostrarEntrada({ vistoEm: null, hoje: '2026-11-03', acabouDeEntrar: false })).toBe(true);
    expect(deveMostrarEntrada({ vistoEm: '2026-11-03', hoje: '2026-11-03', acabouDeEntrar: false })).toBe(false);
    expect(deveMostrarEntrada({ vistoEm: '2026-11-02', hoje: '2026-11-03', acabouDeEntrar: false })).toBe(true);
    expect(deveMostrarEntrada({ vistoEm: '2026-11-03', hoje: '2026-11-03', acabouDeEntrar: true })).toBe(true);
  });
});

describe('contagem dos números [NOVO]', () => {
  it('conta de 0 até o valor, rápido no começo e devagar no fim, e para no valor', () => {
    expect(valorNaContagem(34, 0, 650)).toBe(0);
    expect(valorNaContagem(34, 650, 650)).toBe(34);
    expect(valorNaContagem(34, 900, 650)).toBe(34);
    const meio = valorNaContagem(34, 325, 650);
    expect(meio).toBeGreaterThan(17); // passa da metade na metade do tempo (desacelera no fim)
    expect(meio).toBeLessThan(34);
    expect(valorNaContagem(4, -50, 650)).toBe(0);
  });
});

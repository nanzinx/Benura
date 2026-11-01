import { describe, expect, it } from 'vitest';
import { deveMostrarEntrada, primeiroNome, saudacao } from './boas-vindas';

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

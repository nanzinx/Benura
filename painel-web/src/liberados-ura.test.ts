import { describe, expect, it } from 'vitest';
import { contagem, contarPorStatus, corDoAvatar, diasDeOperacao, faltaAte, filtrarRanking, iniciais, larguraBarra, pctInteiro, textoDiferenca } from './liberados-ura';
import type { VendedorLiberados } from './tipos';

const v = (nome: string, valor: number, status: VendedorLiberados['status']): VendedorLiberados =>
  ({ nome, valor, pct: (valor / 50000) * 100, bateu: status === 'bateu', status, fixo: null, diferenca: valor - 50000 });
const ranking = [v('Emilly', 80000, 'bateu'), v('Eduardo', 46010, 'quase'), v('Ana', 10000, 'abaixo')];

describe('liberados da URA', () => {
  it('filtra o ranking e conta por status', () => {
    expect(filtrarRanking(ranking, 'todos')).toHaveLength(3);
    expect(filtrarRanking(ranking, 'quase').map((r) => r.nome)).toEqual(['Eduardo']);
    expect(contarPorStatus(ranking)).toEqual({ todos: 3, bateu: 1, quase: 1, abaixo: 1 });
  });

  it('formata iniciais, % e diferença', () => {
    expect(iniciais('Emilly Souza Lima')).toBe('EL');
    expect(iniciais('Eduardo')).toBe('ED');
    expect(pctInteiro(92.02)).toBe('92%');
    expect(textoDiferenca(-3990)).toBe('faltaram R$ 3.990');
    expect(textoDiferenca(30000)).toBe('+R$ 30.000');
    expect(larguraBarra(160)).toBe(100);
    expect(corDoAvatar('Ana')).toBe(corDoAvatar('Ana'));
  });

  it('conta até as 09:00 e descreve os dias', () => {
    expect(contagem(faltaAte(8 * 3600 + 30 * 60, '09:00'))).toBe('30:00');
    expect(faltaAte(10 * 3600, '09:00')).toBe(0);
    expect(contagem(4000)).toBe('1:06:40');
    expect(diasDeOperacao([1, 2, 3, 4, 5, 6])).toBe('seg a sáb');
    expect(diasDeOperacao([1, 3])).toBe('seg, qua');
  });
});

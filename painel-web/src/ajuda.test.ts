import { describe, expect, it } from 'vitest';
import { SECOES_DA_AJUDA, filtrarAjuda } from './ajuda';

describe('ajuda', () => {
  it('toda seção tem id único, título, onde fica e itens', () => {
    const ids = SECOES_DA_AJUDA.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SECOES_DA_AJUDA) {
      expect(s.titulo.length).toBeGreaterThan(3);
      expect(s.onde.length).toBeGreaterThan(3);
      expect(s.itens.length).toBeGreaterThan(0);
      for (const item of s.itens) expect(item.length).toBeGreaterThan(10);
    }
  });

  it('cobre o que a supervisão usa no dia a dia', () => {
    const tudo = JSON.stringify(SECOES_DA_AJUDA).toLowerCase();
    for (const termo of ['pânico', 'ura cheia', 'alocar todos no ativo', 'retomar rodízio', 'pausar', 'tor', 'tme', 'opl', 'tpa', 'transbordos', 'desligar automação', 'simulação', 'benhub', 'planilha']) {
      expect(tudo, termo).toContain(termo);
    }
  });

  it('a busca acha pelo título e pelo texto, sem ligar para acento e maiúscula', () => {
    expect(filtrarAjuda('').length).toBe(SECOES_DA_AJUDA.length);
    expect(filtrarAjuda('PANICO').map((s) => s.id)).toContain('panico');
    expect(filtrarAjuda('ociosidade por lead').map((s) => s.id)).toEqual(['relatorio']);
    expect(filtrarAjuda('xyzzy')).toEqual([]);
  });
});

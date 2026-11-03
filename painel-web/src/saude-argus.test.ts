import { describe, expect, it } from 'vitest';
import { falhasDaArgus, problemaNaArgus, saudeDaArgus } from './saude-argus';
import type { SaudeArgus, Visao } from './tipos';

const s = (x: Partial<SaudeArgus> = {}): SaudeArgus => ({
  janelaMin: 15, chamadas: 100, erros: 0, limites: 0, seguradas: 0, lentas: 0, msMedio: 200, ultimoErro: null, ultimoLimiteEm: null, pausaAte: null, ...x,
});
const visao = (rodizio: SaudeArgus | null, robos: SaudeArgus | null, roteador: SaudeArgus | null = null) => ({
  servicos: {
    rodizio: { nome: 'Rodízio de pessoas', online: true, ms: 1, dados: { saudeArgus: rodizio } },
    robos: { nome: 'Robôs da URA', online: true, ms: 1, dados: { saudeArgus: robos } },
    roteador: { nome: 'Roteador', online: true, ms: 1, dados: { saudeArgus: roteador } },
    rotinas: { nome: 'Rotinas', online: true, ms: 1, dados: {} },
  },
}) as unknown as Visao;

describe('saúde da Argus no painel', () => {
  it('soma os serviços: chamadas, erros, lentas, 429; tempo médio ponderado; a pausa mais longa e o erro mais novo', () => {
    const r = saudeDaArgus(visao(
      s({ chamadas: 100, msMedio: 200, erros: 2, ultimoErro: { em: '2026-11-02T12:00:00.000Z', texto: 'a' } }),
      s({ chamadas: 300, msMedio: 400, lentas: 3, limites: 1, pausaAte: '2026-11-02T12:05:00.000Z', ultimoErro: { em: '2026-11-02T12:01:00.000Z', texto: 'b' } }),
    ));
    expect(r).toMatchObject({ chamadas: 400, erros: 2, lentas: 3, limites: 1, msMedio: 350, pausaAte: '2026-11-02T12:05:00.000Z' });
    expect(r?.ultimoErro?.texto).toBe('b');
    expect(r?.porServico.map((p) => p.nome)).toEqual(['Rodízio de pessoas', 'Robôs da URA']);
  });

  it('sem nenhum serviço medindo: null', () => {
    expect(saudeDaArgus(visao(null, null))).toBeNull();
  });

  it('faixa no topo (todas as abas): só a pausa por excesso de chamadas, que tem hora para acabar', () => {
    expect(problemaNaArgus(saudeDaArgus(visao(s({ pausaAte: '2099-01-01T00:00:00.000Z' }), null)), Date.parse('2026-11-02T12:00:00Z'))?.titulo).toMatch(/desacelerar/);
    expect(problemaNaArgus(saudeDaArgus(visao(s({ chamadas: 50, erros: 40 }), null))), 'erro não vira faixa: fica na aba Serviços').toBeNull();
    expect(problemaNaArgus(saudeDaArgus(visao(s({ pausaAte: '2020-01-01T00:00:00.000Z' }), null)))).toBeNull();
  });

  it('falhando muito (20% ou mais, com 10 chamadas ou mais): o aviso da aba Serviços e o pontinho na aba', () => {
    expect(falhasDaArgus(saudeDaArgus(visao(s({ chamadas: 50, erros: 12 }), null)))).toEqual({ pct: 24, erros: 12, chamadas: 50 });
    expect(falhasDaArgus(saudeDaArgus(visao(s({ chamadas: 50, erros: 5 }), null)))).toBeNull();
    expect(falhasDaArgus(saudeDaArgus(visao(s({ chamadas: 5, erros: 3 }), null))), 'poucas chamadas').toBeNull();
    expect(falhasDaArgus(null)).toBeNull();
  });
});

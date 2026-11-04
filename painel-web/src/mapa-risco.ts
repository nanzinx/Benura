/**
 * [NOVO] Mapa de risco dos robôs (relatório de 7 e 30 dias): para cada tanto de livres e faixa de robôs
 * ligados, quantos leads e quantos callbacks de fila. A meta é 1 callback a cada 200 leads (0,5%).
 * Os callbacks "invisíveis" (havia livre, a ligação não chegou) ficam à parte: não dependem dos robôs.
 * O servidor anota (src/domain/mapa-risco.js); aqui só monta a grade e as cores.
 */

import type { CelulaDoMapa, MapaDeRisco, StatusDoMapa } from './tipos';

export const FAIXAS_LIVRES = ['0', '1', '2', '3', '4+'] as const;
export const FAIXAS_ROBOS = ['0', '1-10', '11-20', '21-30', '31-40', '41+'] as const;
const STATUS: StatusDoMapa[] = ['calma', 'normal', 'agressiva', 'medindo'];

/** A meta (1 em 200) e o limite do âmbar (1 em 100). */
export const META = 0.005;
const ATENCAO = 0.01;
/** Menos ligações que isto: pouca amostra (o mesmo AMOSTRA_MINIMA do servidor). */
export const AMOSTRA_MINIMA = 50;

/** A grade inteira, de um status (ou de todos, com null). */
export function celulasDoMapa(mapa: MapaDeRisco | undefined, status: StatusDoMapa | null): CelulaDoMapa[] {
  const grade: CelulaDoMapa[] = [];
  for (const livres of FAIXAS_LIVRES) {
    for (const robos of FAIXAS_ROBOS) {
      const c: CelulaDoMapa = { livres, robos, leads: 0, fila: 0, invisiveis: 0 };
      for (const s of status ? [status] : STATUS) {
        const v = mapa?.[`${livres}|${robos}|${s}`];
        if (!v) continue;
        c.leads += v.leads ?? 0;
        c.fila += v.fila ?? 0;
        c.invisiveis += v.invisiveis ?? 0;
      }
      grade.push(c);
    }
  }
  return grade;
}

const taxa = (c: { leads: number; fila: number }) => (c.leads + c.fila ? c.fila / (c.leads + c.fila) : null);

export type NivelDaCelula = 'vazia' | 'pouca' | 'bom' | 'atencao' | 'ruim';

export function nivelDaCelula(c: CelulaDoMapa): NivelDaCelula {
  const total = c.leads + c.fila;
  if (!total) return c.invisiveis ? 'pouca' : 'vazia'; // só invisíveis: aparece (não some), sem taxa
  if (total < AMOSTRA_MINIMA) return 'pouca';
  const t = taxa(c)!;
  return t <= META ? 'bom' : t <= ATENCAO ? 'atencao' : 'ruim';
}

/** "0,5%", "0,15%" ou "–". */
export function taxaEmTexto(c: CelulaDoMapa): string {
  const t = taxa(c);
  if (t == null) return '–';
  const pct = t * 100;
  const casas = pct > 0 && pct < 1 ? 2 : 1;
  return `${String(Number(pct.toFixed(casas))).replace('.', ',')}%`;
}

export type PontoSeguro = { livres: string; ate: string | null; parou: string | null };

/**
 * Para cada tanto de livres (1 ou mais; com 0 todo callback é de fila), até qual faixa de robôs ficou
 * na meta: anda das faixas menores para as maiores, pula as sem dados ou com pouca amostra e para na
 * primeira fora da meta (âmbar ou vermelho). `parou` é essa faixa (null se não houve).
 */
export function pontoSeguro(celulas: CelulaDoMapa[]): PontoSeguro[] {
  return FAIXAS_LIVRES.filter((l) => l !== '0').map((livres) => {
    let ate: string | null = null;
    for (const robos of FAIXAS_ROBOS) {
      if (robos === '0') continue;
      const c = celulas.find((x) => x.livres === livres && x.robos === robos);
      const nivel = c ? nivelDaCelula(c) : 'vazia';
      if (nivel === 'vazia' || nivel === 'pouca') continue;
      if (nivel !== 'bom') return { livres, ate, parou: robos };
      ate = robos;
    }
    return { livres, ate, parou: null };
  });
}

/**
 * Os transbordos do período que o mapa não tem: os de antes de ele começar a anotar (o quadro
 * Transbordos já contava) e os logo depois de um reinício (sem foto da URA). Nunca menos que zero.
 */
export function foraDoMapa(transbordos: number | null | undefined, r: { fila: number; invisiveis: number }): number {
  return Math.max(0, (transbordos ?? 0) - r.fila - r.invisiveis);
}

/** O período todo: leads, callbacks de fila, invisíveis e quantos de fila a cada 200 ligações. */
export function resumoDoMapa(mapa: MapaDeRisco | undefined, status: StatusDoMapa | null) {
  const soma = celulasDoMapa(mapa, status).reduce((t, c) => ({ leads: t.leads + c.leads, fila: t.fila + c.fila, invisiveis: t.invisiveis + c.invisiveis }), { leads: 0, fila: 0, invisiveis: 0 });
  const t = taxa(soma);
  return { ...soma, porDuzentos: t == null ? null : Math.round(t * 200 * 10) / 10 };
}

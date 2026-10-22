/** Listas do cartão "Vendas e filas" (roteador). */

import type { StatusRoteador, Vendedor } from './tipos';

const todos = (s: StatusRoteador | undefined) => [...(s?.ura ?? []), ...(s?.ativo ?? [])];

/** Quem passou da meta no dia anterior (mesma regra da carga do dia: venda > meta), do maior para o menor. */
export function metaBatidaOntem(s: StatusRoteador | undefined): Vendedor[] {
  if (!s?.meta) return [];
  return todos(s).filter((v) => (v.vendaOntem ?? 0) > s.meta!).sort((a, b) => (b.vendaOntem ?? 0) - (a.vendaOntem ?? 0));
}

/** Quem subiu do Ativo para a URA por venda hoje, do maior para o menor. */
export function subiramHoje(s: StatusRoteador | undefined): Vendedor[] {
  return todos(s).filter((v) => v.promovidoNoDia).sort((a, b) => (b.vendaQueDisparou ?? 0) - (a.vendaQueDisparou ?? 0));
}

/** "20/10/2026" → "20/10". */
export const diaCurto = (dia: string | null | undefined) => (dia ? dia.split('/').slice(0, 2).join('/') : null);

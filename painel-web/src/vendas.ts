/** Listas do cartão "Vendas e filas" (roteador). */

import type { StatusRoteador, Vendedor } from './tipos';

const todos = (s: StatusRoteador | undefined) => [...(s?.ura ?? []), ...(s?.ativo ?? [])];

/** Quem passou da meta no dia anterior (mesma regra da carga do dia: venda > meta), do maior para o menor. */
export function metaBatidaOntem(s: StatusRoteador | undefined): Vendedor[] {
  if (!s?.meta) return [];
  return todos(s).filter((v) => (v.vendaOntem ?? 0) > s.meta!).sort((a, b) => (b.vendaOntem ?? 0) - (a.vendaOntem ?? 0));
}

const porValor = (a: Vendedor, b: Vendedor) => (b.vendaQueDisparou ?? 0) - (a.vendaQueDisparou ?? 0);
const hora = (v: Vendedor) => (v.promovidoEm ? Date.parse(v.promovidoEm) : -Infinity);

/**
 * Quem subiu do Ativo para a URA por venda hoje: do maior para o menor, ou os mais recentes primeiro
 * (quem subiu antes de o roteador guardar a hora fica no fim, pelo valor).
 */
export function subiramHoje(s: StatusRoteador | undefined, ordem: 'valor' | 'recentes' = 'valor'): Vendedor[] {
  const lista = todos(s).filter((v) => v.promovidoNoDia);
  return lista.sort(ordem === 'valor' ? porValor : (a, b) => hora(b) - hora(a) || porValor(a, b));
}

export const somaDasVendas = (lista: Vendedor[]) => lista.reduce((t, v) => t + (v.vendaQueDisparou ?? 0), 0);

/** [NOVO] Quem apareceu desde a leitura anterior. Na primeira (antes = null), ninguém: não anima ao abrir a página. */
export function chegaram(antes: Set<string> | null, agora: Vendedor[]): string[] {
  if (!antes) return [];
  return agora.map((v) => v.ramal).filter((r) => !antes.has(r));
}

/** Subiu nos últimos `minutos`: ganha o selo "novo". */
export const recente = (v: Vendedor, agoraMs: number, minutos = 15) => (v.promovidoEm ? agoraMs - Date.parse(v.promovidoEm) < minutos * 60_000 : false);

/** "agora", "há 10 min", "há 1 h", "há 1 h 45 min". */
export function haQuanto(iso: string | undefined, agoraMs: number): string | null {
  if (!iso) return null;
  const min = Math.max(0, Math.floor((agoraMs - Date.parse(iso)) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return `há ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
}

/** Primeira letra do primeiro e do último nome; sem nome, o fim do ramal. */
export function iniciais(nome: string | undefined, ramal = ''): string {
  const partes = (nome ?? '').split(/\s+/).filter(Boolean);
  if (!partes.length) return ramal.slice(-2) || '?';
  return (partes[0]![0]! + (partes.length > 1 ? partes.at(-1)![0]! : '')).toUpperCase();
}

/** Tom do avatar (0 a 5), sempre o mesmo para o mesmo ramal. */
export const TONS_DO_AVATAR = 6;
export function tomDoAvatar(ramal: string): number {
  let h = 0;
  for (const c of ramal) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % TONS_DO_AVATAR;
}

/** "20/10/2026" → "20/10". */
export const diaCurto = (dia: string | null | undefined) => (dia ? dia.split('/').slice(0, 2).join('/') : null);

/**
 * [NOVO] "Meta batida ontem": quanto passou da meta (145%, R$ 22.500 a mais) e o tamanho da
 * barra em relação à maior venda da lista (a maior = 100).
 */
export function acimaDaMeta(venda: number | null | undefined, meta: number | null | undefined, maior: number) {
  const v = venda ?? 0;
  const barra = !v ? 0 : maior > 0 ? Math.min(100, Math.round((v / maior) * 100)) : 100;
  if (!meta || venda == null) return { porcento: null, sobra: null, barra };
  return { porcento: Math.floor((v / meta) * 100), sobra: Math.round(v - meta), barra };
}

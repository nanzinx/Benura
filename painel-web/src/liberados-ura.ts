/** [NOVO] Liberados da URA: filtros e formatação da tela (sem I/O; testado em liberados-ura.test.ts). */

import type { VendedorLiberados } from './tipos';

export type FiltroRanking = 'todos' | 'bateu' | 'quase' | 'abaixo';

export const filtrarRanking = (ranking: VendedorLiberados[], filtro: FiltroRanking) =>
  (filtro === 'todos' ? ranking : ranking.filter((r) => r.status === filtro));

export const contarPorStatus = (ranking: VendedorLiberados[]) => ({
  todos: ranking.length,
  bateu: ranking.filter((r) => r.status === 'bateu').length,
  quase: ranking.filter((r) => r.status === 'quase').length,
  abaixo: ranking.filter((r) => r.status === 'abaixo').length,
});

/** "Emilly Souza" → "ES"; "Eduardo" → "ED". */
export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  const [primeiro = '', ultimo = ''] = [partes[0], partes.at(-1)];
  if (!primeiro) return '?';
  if (partes.length === 1) return primeiro.slice(0, 2).toUpperCase();
  return (primeiro.charAt(0) + ultimo.charAt(0)).toUpperCase();
}

/** Uma das 4 cores de avatar, sempre a mesma para o mesmo nome. */
export function corDoAvatar(nome: string): 0 | 1 | 2 | 3 {
  let h = 0;
  for (const c of nome) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 4) as 0 | 1 | 2 | 3;
}

export const pctInteiro = (pct: number) => `${Math.round(pct)}%`;

/** R$ sem centavos: "R$ 3.990". */
export const reaisInteiros = (v: number) =>
  Math.round(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0, minimumFractionDigits: 0 }).replace(/\s/g, ' ');

/** "+R$ 30.000" / "faltaram R$ 3.990". */
export const textoDiferenca = (dif: number) => (dif >= 0 ? `+${reaisInteiros(dif)}` : `faltaram ${reaisInteiros(-dif)}`);

/** Largura da barra de progresso (0 a 100). */
export const larguraBarra = (pct: number) => Math.max(0, Math.min(100, pct));

/**
 * Quanto falta até a hora (HH:MM) de hoje, em segundos; 0 se já passou.
 * @param agoraSeg segundos desde a meia-noite
 */
export function faltaAte(agoraSeg: number, hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return Math.max(0, h * 3600 + m * 60 - agoraSeg);
}

/** 1234 s → "20:34"; 4000 s → "1:06:40". */
export function contagem(seg: number): string {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const dd = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${dd(m)}:${dd(s)}` : `${dd(m)}:${dd(s)}`;
}

/** Os nomes dos dias de operação: [1..6] → "seg a sáb". */
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export function diasDeOperacao(dias: number[]): string {
  const d = [...dias].sort((a, b) => a - b);
  const primeiro = d[0];
  const ultimo = d.at(-1);
  if (primeiro !== undefined && ultimo !== undefined && d.length > 1 && ultimo - primeiro === d.length - 1) return `${DIAS[primeiro]} a ${DIAS[ultimo]}`;
  return d.map((x) => DIAS[x]).join(', ');
}

/** Formatação em português (sem I/O; testada em formatos.test.ts). */

export const reais = (v: number | null | undefined): string =>
  Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const horaCurta = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '–';

/** 45 s · 3 min 05 s · 2 h 07 min */
export function duracao(seg: number | null | undefined): string {
  if (seg == null || !Number.isFinite(seg) || seg < 0) return '–';
  if (seg < 60) return `${Math.round(seg)} s`;
  if (seg < 3600) return `${Math.floor(seg / 60)} min ${String(Math.floor(seg % 60)).padStart(2, '0')} s`;
  return `${Math.floor(seg / 3600)} h ${String(Math.floor((seg % 3600) / 60)).padStart(2, '0')} min`;
}

/** "08:42:18" → segundos desde a meia-noite */
export function segundosDoDia(hora: string): number {
  const [h = 0, m = 0, s = 0] = hora.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** 30660 → "08:31" */
export function horaDeSegundos(seg: number): string {
  const h = Math.floor(seg / 3600) % 24;
  const m = Math.floor((seg % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "2026-10-20" → "20/10/2026" */
export const dataBr = (iso: string | null | undefined): string => (iso ? iso.split('-').reverse().join('/') : '–');

/** Segundos desde a meia-noite, agora (relógio do navegador). */
export function agoraEmSegundos(data = new Date()): number {
  return data.getHours() * 3600 + data.getMinutes() * 60 + data.getSeconds();
}

/** Tira o prefixo "PÂNICO: " do motivo para mostrar na tela. */
export const motivoLegivel = (motivo: string | null | undefined): string => String(motivo ?? '').replace(/^PÂNICO: /, '');

/**
 * Linha do tempo em degraus: cada valor vale até a próxima mudança. Acrescenta o
 * ponto de "agora" (o último valor continua valendo) e corta pela janela pedida.
 */
export function degraus<T extends { hora: string }>(pontos: T[], valor: (p: T) => number | null, { agora, janelaSeg }: { agora: number; janelaSeg: number | null }) {
  const serie = pontos
    .map((p) => ({ t: segundosDoDia(p.hora), y: valor(p) }))
    .filter((p): p is { t: number; y: number } => p.y != null);
  if (!serie.length) return [];
  const ultimo = serie[serie.length - 1]!;
  if (agora > ultimo.t) serie.push({ t: agora, y: ultimo.y });
  if (janelaSeg == null) return serie;
  const inicio = agora - janelaSeg;
  const antes = serie.filter((p) => p.t <= inicio).pop();
  const dentro = serie.filter((p) => p.t > inicio);
  return antes ? [{ t: inicio, y: antes.y }, ...dentro] : dentro;
}

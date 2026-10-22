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

/** Minutos para leitura rápida: "0 min", "12 min", "1 h 05 min". */
export function minutos(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min < 0) return '–';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** [NOVO] Ordem dos grupos na Visão Geral: em atendimento na URA → livres → pausa → sem resposta → offline. */
const ORDEM_DOS_GRUPOS: Record<string, number> = { atendimento: 0, livre: 1, outro: 2, erro: 3, offline: 4 };

/**
 * [NOVO] Operadores humanos (sem robô) na ordem da Visão Geral: pelo grupo; dentro dele,
 * quem está há mais tempo no status primeiro; empate pelo nome (A–Z).
 */
export function ordenarOperadores<T extends { ramal: string; nome: string | null; classe: string | null; statusDesde?: string | null; virtual?: boolean }>(lista: T[]): T[] {
  const desde = (o: T) => (o.statusDesde ? new Date(o.statusDesde).getTime() : Number.POSITIVE_INFINITY);
  return lista.filter((o) => !o.virtual).sort((a, b) => (ORDEM_DOS_GRUPOS[a.classe ?? 'erro']! - ORDEM_DOS_GRUPOS[b.classe ?? 'erro']!)
    || desde(a) - desde(b)
    || String(a.nome ?? a.ramal).localeCompare(String(b.nome ?? b.ramal), 'pt-BR'));
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** [NOVO] Limite (min) da pausa pelo tipo da Argus: casa pelo começo do nome, sem acento ("ALMOÇO 1" → almoço). */
export function limiteDaPausa(tipo: string | null | undefined, limites: Record<string, number> = {}): number | null {
  if (!tipo) return null;
  const t = semAcento(tipo);
  const chave = Object.keys(limites).find((k) => t.startsWith(semAcento(k)));
  return chave ? limites[chave]! : null;
}

/** [NOVO] "1:05" (m:ss) ou "1:02:05" (h:mm:ss). */
export function cronometro(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

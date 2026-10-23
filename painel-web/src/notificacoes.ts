/**
 * Som e notificação do navegador para cliente de risco em ligação (o navegador pede um clique antes).
 * [NOVO] Os avisos somem sozinhos depois de AVISO_MS: a faixa, a notificação e o "⚠" do título.
 */

import type { AlertaDeRisco } from './tipos';

/** [NOVO] Quanto tempo o aviso de cada cliente de risco fica na tela. */
export const AVISO_MS = 5000;

/** id do alerta → quando apareceu pela primeira vez neste navegador */
const vistos = new Map<string, number>();
let somLigado = false;

export function bipe(): void {
  try {
    const ctx = new AudioContext();
    for (const atraso of [0, 0.25]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.2, ctx.currentTime + atraso);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + atraso + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + atraso);
      o.stop(ctx.currentTime + atraso + 0.2);
    }
  } catch {
    /* sem áudio */
  }
}

/** @returns o estado das notificações depois do pedido */
export async function ativarAvisos(): Promise<{ som: boolean; notificacoes: NotificationPermission | 'sem suporte' }> {
  somLigado = true;
  bipe();
  if (!('Notification' in window)) return { som: true, notificacoes: 'sem suporte' };
  if (Notification.permission === 'default') await Notification.requestPermission().catch(() => undefined);
  return { som: true, notificacoes: Notification.permission };
}

export const avisosAtivos = () => somLigado;

/**
 * [NOVO] Marca os alertas novos e esquece os que saíram da lista (uma ligação nova do mesmo
 * cliente avisa de novo). @returns os alertas que apareceram agora
 */
export function registrarAlertas(alertas: AlertaDeRisco[], agora = Date.now()): AlertaDeRisco[] {
  const ids = new Set(alertas.map((a) => a.id));
  for (const id of vistos.keys()) if (!ids.has(id)) vistos.delete(id);
  const novos = alertas.filter((a) => !vistos.has(a.id));
  novos.forEach((a) => vistos.set(a.id, agora));
  return novos;
}

/** [NOVO] Só os alertas que apareceram há menos de AVISO_MS (os que ainda aparecem na tela). */
export function alertasRecentes(alertas: AlertaDeRisco[], agora = Date.now(), duracaoMs = AVISO_MS): AlertaDeRisco[] {
  return alertas.filter((a) => {
    const desde = vistos.get(a.id);
    return desde != null && agora - desde < duracaoMs;
  });
}

/** [NOVO] Quando o aviso mais novo some (para a tela se atualizar sem esperar o próximo pedido). */
export function proximoFimDeAviso(alertas: AlertaDeRisco[], agora = Date.now(), duracaoMs = AVISO_MS): number | null {
  const fins = alertasRecentes(alertas, agora, duracaoMs).map((a) => vistos.get(a.id)! + duracaoMs - agora);
  return fins.length ? Math.max(0, Math.min(...fins)) : null;
}

/** Som e notificação (que fecha sozinha em AVISO_MS) para os alertas que acabaram de aparecer. */
export function avisarClientesNovos(novos: AlertaDeRisco[]): void {
  if (!novos.length) return;
  if (somLigado) bipe();
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      for (const a of novos) {
        const n = new Notification('Cliente de risco em ligação', { body: `${a.robo ?? 'Robô'} com ${a.mascara} (${a.motivos.join(', ')})` });
        setTimeout(() => n.close(), AVISO_MS);
      }
    }
  } catch {
    /* sem notificação */
  }
}

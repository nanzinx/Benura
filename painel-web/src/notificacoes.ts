/** Som e notificação do navegador para cliente de risco em ligação (o navegador pede um clique antes). */

import type { AlertaDeRisco } from './tipos';

const vistos = new Set<string>();
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

export function avisarClientesNovos(alertas: AlertaDeRisco[]): void {
  const novos = alertas.filter((a) => !vistos.has(a.id));
  novos.forEach((a) => vistos.add(a.id));
  if (!novos.length) return;
  if (somLigado) bipe();
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      for (const a of novos) new Notification('Cliente de risco em ligação', { body: `${a.robo ?? 'Robô'} com ${a.mascara} (${a.motivos.join(', ')})` });
    }
  } catch {
    /* sem notificação */
  }
}

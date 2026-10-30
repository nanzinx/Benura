/**
 * [NOVO] Uma linha com a conta dos robôs no automático (cartão "Rodízio dos robôs"):
 * robôs por livre pela taxa real de derivação dos últimos 30 min, pela meta do status da URA.
 */

import type { CalculoRobos } from './tipos';

const NOMES: Record<string, string> = { calma: 'Calma', normal: 'Normal', agressiva: 'Agressiva', medindo: 'Medindo o status' };
const decimal = (n: number) => String(n).replace('.', ',');

export function descreverCalculo(c: CalculoRobos | null | undefined): string | null {
  if (!c) return null;
  if (c.fonte === 'manual') {
    return `Por livre escolhido à mão hoje: vale até virar o dia${c.taxa != null ? ` (a taxa agora é ${decimal(c.taxa)} por robô por min)` : ''}`;
  }
  const status = NOMES[c.status] ?? c.status;
  const todos = c.todosComLivres ? `; com ${c.todosComLivres} livres ou mais, todos os robôs` : '';
  if (c.fonte === 'medindo' || c.porLivre == null) {
    return `${status}: medindo a taxa (${c.derivacoes30} derivações e ${decimal(c.roboMinutos30)} robô-min em 30 min); até lá vale o ajuste do dia, entre ${c.min} e ${c.max} por livre${todos}`;
  }
  const limite = c.limitadoPor === 'teto' ? `, teto ${c.max}` : c.limitadoPor === 'piso' ? `, piso ${c.min}` : '';
  return `${status}: espera alvo ${c.esperaAlvoS} s · cada robô deriva ${decimal(c.taxa ?? 0)} por min (30 min) → ${c.bruto} por livre${limite}${todos}`;
}

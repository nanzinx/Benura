import { describe, expect, it } from 'vitest';
import { alertasRecentes, proximoFimDeAviso, registrarAlertas } from './notificacoes';
import type { AlertaDeRisco } from './tipos';

const alerta = (id: string): AlertaDeRisco => ({ id, robo: 'Oper Virtual 1', mascara: '(11) 9****-0000', atendeu: 3, callbacks: 0, motivos: ['atendeu 3 vez(es)'], inicio: '2026-10-23T13:00:00Z' } as AlertaDeRisco);

describe('[NOVO] avisos de cliente de risco somem em 5 s', () => {
  it('aparece, some em 5 s e não volta enquanto a ligação continua; ligação nova avisa de novo', () => {
    const a = alerta('a');
    expect(registrarAlertas([a], 0)).toEqual([a]);
    expect(alertasRecentes([a], 4_999)).toEqual([a]);
    expect(proximoFimDeAviso([a], 1_000)).toBe(4_000);
    expect(alertasRecentes([a], 5_000)).toEqual([]);
    expect(registrarAlertas([a], 6_000), 'a mesma ligação não avisa de novo').toEqual([]);
    expect(alertasRecentes([a], 6_000)).toEqual([]);
    registrarAlertas([], 7_000); // a ligação acabou
    expect(registrarAlertas([a], 8_000), 'outra ligação do mesmo cliente').toEqual([a]);
    expect(alertasRecentes([a], 8_100)).toEqual([a]);
  });
});

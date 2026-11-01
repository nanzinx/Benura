import { describe, expect, it } from 'vitest';
import { textoDaSaida } from './saida-da-ura';

const agora = Date.parse('2026-11-01T12:00:00Z');
const desde = (seg: number) => new Date(agora - seg * 1000).toISOString();

describe('textoDaSaida', () => {
  it('livre comum: contagem regressiva até voltar ao Ativo', () => {
    expect(textoDaSaida({ emMs: 45_000, limiteMs: 120_000, motivo: null }, desde(75), agora)).toEqual({ texto: 'sai em 0:45', tom: 'neutro', dica: 'Volta ao Ativo com 2:00 livre (limite com a antiguidade).' });
    expect(textoDaSaida({ emMs: 0, limiteMs: 120_000, motivo: null }, desde(130), agora)?.texto).toBe('saindo agora');
  });

  it('o motivo de ficar ou de sair já', () => {
    expect(textoDaSaida({ emMs: null, limiteMs: 120_000, motivo: 'fixo' }, desde(300), agora)?.texto).toBe('fica: fixo');
    expect(textoDaSaida({ emMs: null, limiteMs: 120_000, motivo: 'travado à mão' }, desde(300), agora)?.texto).toBe('fica: travado à mão');
    expect(textoDaSaida({ emMs: 0, limiteMs: 120_000, motivo: 'conta de supervisor' }, desde(10), agora)?.texto).toBe('sai já: conta de supervisor');
    expect(textoDaSaida({ emMs: null, limiteMs: 120_000, motivo: 'em transferência' }, desde(10), agora)?.texto).toBe('transferindo');
    const semGrupo = textoDaSaida({ emMs: 0, limiteMs: 120_000, motivo: 'sem grupo do Ativo' }, desde(200), agora);
    expect(semGrupo?.texto).toBe('não sai: sem grupo do Ativo');
    expect(semGrupo?.tom).toBe('alerta');
  });

  it('sem saída (não está livre): nada', () => {
    expect(textoDaSaida(null, null, agora)).toBeNull();
    expect(textoDaSaida(undefined, null, agora)).toBeNull();
  });
});

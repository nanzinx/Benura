/** Dados do painel com React Query: atualizam sozinhos (pausável) e ao voltar para a aba. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, type ComandoUra } from './api';
import { useRetorno } from './ui/retorno';

/** "Ao vivo" ou pausado (o botão do topo). */
export const AoVivo = createContext(true);
const intervalo = (ms: number, aoVivo: boolean) => (aoVivo ? ms : false);

export function useVisao() {
  return useQuery({ queryKey: ['visao'], queryFn: api.visao, refetchInterval: intervalo(5000, useContext(AoVivo)) });
}

export function useDia() {
  return useQuery({ queryKey: ['dia'], queryFn: api.dia, refetchInterval: intervalo(30_000, useContext(AoVivo)) });
}

export function useRoteador() {
  return useQuery({ queryKey: ['roteador'], queryFn: api.roteador, refetchInterval: intervalo(30_000, useContext(AoVivo)) });
}

export function useRisco() {
  return useQuery({ queryKey: ['risco'], queryFn: api.risco, refetchInterval: intervalo(60_000, useContext(AoVivo)) });
}

const DESCRICAO: Record<ComandoUra, [string, string]> = {
  panico: ['Pânico ligado.', 'Pânico desligado.'],
  'ura/passiva': ['URA passiva hoje: com um fixo livre, os robôs seguem até ele atender.', 'URA passiva desligada.'],
  'ura/cheia': ['URA cheia: os operadores do Ativo vão para a URA em até 5 s.', 'Rodízio de volta ao normal.'],
  'risco/desligar': ['Os robôs desligam quando um cliente de risco estiver em ligação.', 'Cliente de risco: só avisa.'],
};

/** Liga ou desliga um interruptor da URA e já relê a visão. */
export function useComandoUra(comando: ComandoUra) {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: (ligar: boolean) => api.comandoUra(comando, ligar),
    onSuccess: (r, ligar) => {
      avisar('ok', r?.mudou === false ? 'Já estava assim.' : DESCRICAO[comando][ligar ? 0 : 1]);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

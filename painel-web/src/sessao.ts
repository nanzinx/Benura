/**
 * [NOVO] Quem entrou e o papel dele, fora do React: o QueryCache avisa quando um pedido
 * volta 401 (sessão vencida, senha ou papel trocados, usuário desativado).
 */

import { useSyncExternalStore } from 'react';
import { api } from './api';

export type Papel = 'visualizacao' | 'supervisor' | 'administrador';
export const PAPEIS: Papel[] = ['visualizacao', 'supervisor', 'administrador'];
export const NOMES_PAPEIS: Record<Papel, string> = { visualizacao: 'Visualização', supervisor: 'Supervisor', administrador: 'Administrador' };
export const DESCRICAO_PAPEIS: Record<Papel, string> = {
  visualizacao: 'Só vê as telas.',
  supervisor: 'Opera o dia: atendentes, robôs, status da URA, pânico e esteira.',
  administrador: 'Tudo, inclusive Desligar automação, Modo simulação e usuários.',
};

export interface UsuarioDaSessao { nome: string; email: string; papel: Papel; senhaProvisoria: boolean }
export type Sessao =
  | { estado: 'verificando' | 'fora' }
  | { estado: 'dentro'; usuario: UsuarioDaSessao; emergencia: boolean };

let sessao: Sessao = { estado: 'verificando' };
const ouvintes = new Set<() => void>();
export const definirSessao = (s: Sessao) => { sessao = s; ouvintes.forEach((o) => o()); };
export const sessaoAcabou = () => definirSessao({ estado: 'fora' });
/** Pergunta ao servidor quem entrou (e o papel). */
export const conferirSessao = () => api.sessao().then(
  (s) => definirSessao({ estado: 'dentro', usuario: s.usuario, emergencia: s.emergencia }),
  () => definirSessao({ estado: 'fora' }),
);
export const useSessao = () => useSyncExternalStore((o) => { ouvintes.add(o); return () => ouvintes.delete(o); }, () => sessao);

/** O papel de quem entrou alcança o `minimo`? (a tela esconde ou desliga; quem garante é o servidor) */
export const podeFazer = (papel: Papel, minimo: Papel) => PAPEIS.indexOf(papel) >= PAPEIS.indexOf(minimo);
export function usePode(minimo: Papel) {
  const s = useSessao();
  return s.estado === 'dentro' && podeFazer(s.usuario.papel, minimo);
}

/** A dica num botão desligado pelo papel. */
export const semAcesso = (minimo: Papel) => (minimo === 'administrador' ? 'Só administrador' : 'Só supervisor ou administrador');

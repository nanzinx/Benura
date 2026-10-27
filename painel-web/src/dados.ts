/** Dados do painel com React Query: atualizam sozinhos (pausável) e ao voltar para a aba. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { api, type ComandoUra, type PedidoAcao } from './api';
import type { Componente, ModoRobos, ResultadoRetomada, ResultadoTransferencia, StatusDaUra } from './tipos';
import { useRetorno } from './ui/retorno';

/** "Ao vivo" ou pausado (o botão do topo). */
export const AoVivo = createContext(true);
const intervalo = (ms: number, aoVivo: boolean) => (aoVivo ? ms : false);

export function useVisao() {
  const aoVivo = useContext(AoVivo);
  return useQuery({
    queryKey: ['visao'],
    queryFn: api.visao,
    // Desligando ou religando a automação: acompanha de perto (mesmo pausado).
    refetchInterval: (q) => (['desligando', 'religando', 'reiniciando'].includes(q.state.data?.automacao?.estado ?? '') ? 1500 : intervalo(5000, aoVivo)),
  });
}

/** Botões "Desligar automação" / "Religar automação". */
export function useAutomacao() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: (ligar: boolean) => api.automacao(ligar),
    onSuccess: (_, ligar) => {
      avisar('ok', ligar ? 'Religando a automação…' : 'Desligando a automação: robôs primeiro, depois os serviços.');
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** [NOVO] Liga ou desliga só um componente (roteador, rodízio ou rotinas). */
export function useComponente() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: ({ app, ligar }: { app: Componente; ligar: boolean }) => api.componente(app, ligar),
    onSuccess: (_, { app, ligar }) => {
      avisar('ok', `${ligar ? 'Ligando' : 'Desligando'} o ${NOMES_DOS_COMPONENTES[app]}…`);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** [NOVO] Nome de cada componente e o que acontece com ele desligado (confirmação e Ajuda). */
export const NOMES_DOS_COMPONENTES: Record<Componente, string> = { 'benura-roteador': 'roteador', 'benura-rodizio': 'rodízio', 'benura-rotinas': 'rotinas' };
export const EFEITO_DESLIGADO: Record<Componente, string> = {
  'benura-roteador': 'Ninguém é movido entre Ativo e URA pelas vendas, e a lista de quem pode ir para a URA fica parada. O rodízio e o pânico seguem.',
  'benura-rodizio': 'Sem rodízio, pânico, URA cheia, status da URA, clientes de risco e relatório do dia. Os robôs são desligados antes; quem religa os robôs é a supervisão, pela Argus.',
  'benura-rotinas': 'Sem a checagem de fim de expediente. O resto segue normal.',
};

/** Botão "Modo simulação" (DRY_RUN): grava e reinicia os serviços. */
export function useSimulacao() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: (ligada: boolean) => api.simulacao(ligada),
    onSuccess: (_, ligada) => {
      avisar('ok', ligada ? 'Ligando a simulação: os serviços reiniciam em alguns segundos.' : 'Voltando a agir de verdade: os serviços reiniciam em alguns segundos.');
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
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

/** [NOVO] Leads derivados e transbordos do dia (GET /api/metricas/hoje). */
export function useMetricasHoje() {
  return useQuery({ queryKey: ['metricas'], queryFn: api.metricasHoje, refetchInterval: intervalo(10_000, useContext(AoVivo)) });
}

const NOMES_STATUS: Record<StatusDaUra, string> = { calma: 'URA CALMA', normal: 'URA NORMAL', agressiva: 'URA AGRESSIVA' };

/** [NOVO] Status da URA: manual (calma, normal, agressiva) ou de volta ao automático. Vale para todos. */
export function useStatusUra() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: (pedido: { status?: StatusDaUra; modo: 'manual' | 'automatico' }) => api.statusUra(pedido),
    onSuccess: (r, pedido) => {
      avisar('ok', r.mudou === false ? 'Já estava assim.' : pedido.modo === 'automatico'
        ? 'Status da URA de volta ao automático (termômetro).'
        : `${NOMES_STATUS[pedido.status!]} fixado: vale para todos até voltar ao automático.`);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** [NOVO] "Alocar Todos no Ativo": o backend escolhe quem vai (sem fixos e sem robôs). */
export function useTransferirUraAtivo() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: api.transferirUraAtivo,
    onSuccess: (r: ResultadoTransferencia) => {
      const partes = [`${r.movidos.length} movido(s)`, `${r.ignorados.length} mantido(s) na URA (fixo ou travado)`];
      if (r.erros.length) partes.push(`${r.erros.length} não moveram (${r.erros.map((e) => e.nome ?? e.ramal).join(', ')})`);
      if (r.uraCheiaDesligada) partes.push('URA cheia desligada');
      partes.push('ficam no Ativo até retomar o rodízio');
      avisar(r.erros.length ? 'erro' : 'ok', partes.join(', '));
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** [NOVO] "Retomar rodízio da URA": quem vendeu (ou bateu a meta, ou é fixo) volta para a URA na hora. */
export function useRetomarRodizio() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: api.retomarRodizio,
    onSuccess: (r: ResultadoRetomada) => {
      const texto = r.semLista
        ? 'Rodízio da URA retomado (sem a lista do dia: o rodízio leva quem atender no Ativo).'
        : `Rodízio da URA retomado: ${r.movidos.length} voltaram para a URA${r.erros.length ? `, ${r.erros.length} não moveram agora` : ''}.`;
      avisar(r.erros.length ? 'erro' : 'ok', texto);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** [NOVO] Lista de pausas da Argus (muda pouco: o rodízio guarda por 10 min). */
export function usePausasDisponiveis(ramal: string | null) {
  return useQuery({
    queryKey: ['pausas', ramal],
    queryFn: () => api.pausasDisponiveis(ramal!),
    enabled: Boolean(ramal),
    staleTime: 10 * 60_000,
  });
}

const TEXTOS_ACAO: Record<PedidoAcao['acao'], string> = {
  pausar: 'Pausa pedida',
  'sair-pausa': 'Saiu da pausa',
  'ficar-disponivel': 'Disponível para a próxima ligação',
  deslogar: 'Deslogado',
  mover: 'Movido',
  liberar: 'Liberado para o rodízio',
};

/** [NOVO] Ações por atendente: pausar, sair da pausa, ficar disponível, deslogar, mover (com trava) e liberar. */
export function useAcaoOperador() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: (p: PedidoAcao & { nome?: string | null }) => {
      const { nome: _nome, ...pedido } = p;
      return api.acaoOperador(pedido as PedidoAcao);
    },
    onSuccess: (r, p) => {
      const quem = p.nome ?? `ramal ${p.ramal}`;
      let texto = `${TEXTOS_ACAO[p.acao]}: ${quem}`;
      if (p.acao === 'mover') {
        texto = r.jaEstava
          ? `${quem} já estava ${p.para === 'ura' ? 'na URA' : 'no Ativo'}: travado lá até liberar`
          : `${quem} ${p.para === 'ura' ? 'veio para a URA' : 'foi para o Ativo'} e fica lá até liberar`;
      }
      if (p.acao === 'liberar' && r.estavaTravado === false) texto = `${quem} não estava travado`;
      avisar('ok', `${r.simulado ? '[Simulação] ' : ''}${texto}.`);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

const TEXTO_MODO: Record<ModoRobos, string> = {
  automatico: 'Robôs no automático: o BenURA liga e desliga conforme os livres.',
  panico: 'Robôs em "só pânico": a supervisão liga pela Argus e o BenURA só desliga no pânico.',
  desligados: 'Robôs desligados: os parados saem agora e os em ligação ao terminar. O resto da automação segue.',
};

/** [NOVO] Modo dos robôs (automático, só pânico ou desligados). */
export function useModoRobos() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: api.modoRobos,
    onSuccess: (r) => {
      avisar('ok', r.mudou === false ? 'Já estava assim.' : TEXTO_MODO[r.modo]);
      cliente.invalidateQueries({ queryKey: ['visao'] });
    },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

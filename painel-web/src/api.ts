/** Cliente da API do benura-painel. Escrita leva o cabeçalho X-Painel (o servidor exige). */

import type {
  ClienteDeRisco, Dia, EstadoAutomacao, MetricasHoje, OndeTravado, PausaDaArgus, RespostaInterruptor, ResultadoAcao, ResultadoEsteira, ResultadoRetomada,
  ResultadoTransferencia, StatusDaUra, StatusRoteador, StatusUra, Visao,
} from './tipos';

/** A sessão venceu ou não existe: a página volta para a entrada. */
export class SemSessao extends Error {
  constructor() {
    super('Entre com a senha da supervisão');
  }
}

export type Metodo = 'GET' | 'POST' | 'PUT' | 'DELETE';

export async function pedir<T>(metodo: Metodo, url: string, corpo?: unknown): Promise<T> {
  const resposta = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers: { 'X-Painel': '1', ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  let json: unknown = null;
  try {
    json = await resposta.json();
  } catch {
    /* sem corpo */
  }
  if (resposta.status === 401 && url !== '/api/entrar') throw new SemSessao();
  if (!resposta.ok) throw new Error((json as { erro?: string } | null)?.erro ?? `HTTP ${resposta.status}`);
  return json as T;
}

/** Comandos da URA (lista fechada no servidor: src/painel/servicos.js). */
export type ComandoUra = 'panico' | 'ura/cheia' | 'risco/desligar';

export const api = {
  sessao: () => pedir<{ ok: true }>('GET', '/api/sessao'),
  entrar: (senha: string) => pedir<{ ok: true }>('POST', '/api/entrar', { senha }),
  sair: () => pedir<{ ok: true }>('POST', '/api/sair'),
  visao: () => pedir<Visao>('GET', '/api/visao'),
  dia: () => pedir<Dia>('GET', '/api/dia'),
  roteador: () => pedir<StatusRoteador>('GET', '/api/roteador/status'),
  risco: () => pedir<{ clientes: ClienteDeRisco[] }>('GET', '/api/rodizio/perfis/risco'),
  comandoUra: (comando: ComandoUra, ligar: boolean) => pedir<RespostaInterruptor>(ligar ? 'POST' : 'DELETE', `/api/rodizio/${comando}`),
  colarEsteira: (texto: string) => pedir<ResultadoEsteira>('POST', '/api/roteador/manual', { texto }),
  limparEsteira: () => pedir<{ apagados: number }>('DELETE', '/api/roteador/manual'),
  recarregarVendas: () => pedir<{ mensagem: string }>('POST', '/api/roteador/recarregar'),
  automacao: (ligar: boolean) => pedir<EstadoAutomacao>('POST', ligar ? '/api/automacao/religar' : '/api/automacao/desligar'),
  simulacao: (ligada: boolean) => pedir<EstadoAutomacao>('POST', '/api/simulacao', { ligada }),
  // [NOVO]
  metricasHoje: () => pedir<MetricasHoje>('GET', '/api/metricas/hoje'),
  statusUra: (pedido: { status?: StatusDaUra; modo: 'manual' | 'automatico' }) => pedir<StatusUra & { mudou: boolean }>('PUT', '/api/ura/status', pedido),
  transferirUraAtivo: () => pedir<ResultadoTransferencia>('POST', '/api/operadores/transferir-ura-ativo', {}),
  retomarRodizio: () => pedir<ResultadoRetomada>('POST', '/api/operadores/retomar-rodizio', {}),
  // [NOVO] ações por atendente (aba Receptivo)
  pausasDisponiveis: (ramal: string) => pedir<{ pausas: PausaDaArgus[] }>('POST', '/api/operadores/pausas', { ramal }),
  acaoOperador: (pedido: PedidoAcao) => {
    const { acao, ...corpo } = pedido;
    return pedir<ResultadoAcao>('POST', `/api/operadores/${acao}`, corpo);
  },
};

/** [NOVO] uma ação por atendente: a rota e o corpo (ramal, e o que a ação pede) */
export type PedidoAcao =
  | { acao: 'pausar'; ramal: string; idPausa: number }
  | { acao: 'sair-pausa' | 'ficar-disponivel' | 'deslogar' | 'liberar'; ramal: string }
  | { acao: 'mover'; ramal: string; para: OndeTravado };

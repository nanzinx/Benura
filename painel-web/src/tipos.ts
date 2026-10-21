/** Formatos que o benura-painel devolve (veja src/painel/servidor.js e o /health do rodízio). */

export type Classe = 'livre' | 'atendimento' | 'outro' | 'offline' | 'erro';

export interface OperadorNaUra {
  ramal: string;
  nome: string | null;
  classe: Classe | null;
  livreDesde: string | null;
  emCarencia: boolean;
  fixo: boolean;
}

export interface Interruptor {
  ligado: boolean;
  desde: string | null;
}

export interface SaudeRodizio {
  lastLoopUra?: string;
  uptime?: number;
  dryRun?: boolean;
  uraAgora?: OperadorNaUra[];
  fixosPermanentes?: string[];
  robos?: { ligados: number | null; total?: number; alvo?: number | null; modo?: 'panico' | 'automatico' };
  uraCheia?: { ligada: boolean; desde: string | null };
  panico?: Interruptor & {
    modo: boolean;
    ativoAgora: string | null;
    motivo: string | null;
    antesDeSairMs?: number;
    uraPassiva?: Interruptor;
  };
}

export interface SaudeRoteador { uptime?: number; cargaInicialFeita?: boolean; ultimoMonitoramento?: string | null }
export interface SaudeRotinas { uptime?: number; ultimaExecucao?: string | null }

export interface Servico<T extends { uptime?: number } = { uptime?: number }> {
  nome: string;
  online: boolean;
  ms: number;
  dados: T | null;
}

export interface AlertaDeRisco {
  id: string;
  robo: string | null;
  mascara: string;
  atendeu: number;
  callbacks: number;
  motivos: string[];
  inicio: string;
}

export interface Alertas {
  ativo: boolean;
  alertas: AlertaDeRisco[];
  desligaRobos?: Interruptor;
  perfis?: { clientes: number; historicoAte: string | null; risco: number };
}

/** Botão "Desligar automação" (src/painel/automacao.js). */
export interface EstadoAutomacao {
  estado: 'ligada' | 'desligando' | 'desligada' | 'religando';
  etapa: string | null;
  desde: string | null;
  por: string | null;
  aviso: string | null;
}

export interface Visao {
  agora: string;
  servicos: {
    roteador: Servico<SaudeRoteador>;
    rodizio: Servico<SaudeRodizio>;
    rotinas: Servico<SaudeRotinas>;
    atualizador?: Servico;
  };
  argus: { tokenRecusado: boolean; cicloUraHaSeg: number | null; respondendo: boolean };
  alertas: Alertas | null;
  automacao?: EstadoAutomacao;
}

export interface PontoDoDia { hora: string; livres: number; humanos: number; robos: number | null }
export interface Callback { hora: string; robo: string | null; duracaoSeg: number; conclusao: string | null; detalhes: string[] }
export interface Aviso { hora: string; servico: string; nivel: 'AVISO' | 'ERRO'; texto: string }

export interface Dia {
  dia: string;
  linhaDoTempo: PontoDoDia[];
  callbacks: Callback[];
  avisos: Aviso[];
}

export interface Vendedor {
  ramal: string;
  nome?: string;
  equipe?: string;
  fila?: string;
  promovidoNoDia?: boolean;
  vendaQueDisparou?: number;
}

export interface StatusRoteador {
  cargaInicialFeita?: boolean;
  ultimoMonitoramento?: string | null;
  meta?: number;
  ura?: Vendedor[];
  ativo?: Vendedor[];
}

export interface ClienteDeRisco { mascara: string; callbacks: number; atendeu: number; ultimoDia: string | null; motivos: string[] }

export interface ResultadoEsteira {
  diasColados: string[];
  vendas: number;
  ignoradas: number;
  hoje: string;
  metaDiaria: number;
  diaAnterior: string | null;
  acimaDaMeta: { nome: string; total: number }[];
  vendeuHoje: { nome: string; total: number }[];
}

export interface RespostaInterruptor extends Interruptor { mudou?: boolean }

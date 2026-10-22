/** Formatos que o benura-painel devolve (veja src/painel/servidor.js e o /health do rodízio). */

export type Classe = 'livre' | 'atendimento' | 'outro' | 'offline' | 'erro';

export interface OperadorNaUra {
  ramal: string;
  nome: string | null;
  classe: Classe | null;
  livreDesde: string | null;
  emCarencia: boolean;
  fixo: boolean;
  /** [NOVO] robô (operador virtual) na lista da URA: fora das contagens de humanos */
  virtual?: boolean;
  /** [NOVO] tipo da pausa (descricaoPausa da Argus), quando em pausa */
  pausa?: string | null;
  /** [NOVO] desde quando está no status (tempoStatus da Argus; livre: desde que ficou livre) */
  statusDesde?: string | null;
  /** [NOVO] travado à mão pelo painel (o rodízio não mexe até liberarem) */
  travado?: OndeTravado | null;
}

/** [NOVO] onde a supervisão travou o atendente à mão */
export type OndeTravado = 'ativo' | 'ura';

/** [NOVO] quem está no Ativo agora (para "Trazer para a URA") */
export interface OperadorNoAtivo {
  ramal: string;
  nome: string | null;
  grupo: number;
  grupoDesc: string | null;
  travado: OndeTravado | null;
}

/** [NOVO] relatório do dia por atendente (só o tempo no grupo da URA) */
export interface AtendenteDoDia {
  ramal: string;
  nome: string | null;
  primeiroEm: string | null;
  ultimoEm: string | null;
  livreMin: number;
  atendimentoMin: number;
  outroMin: number;
  pausaMin: number;
  pausasMin: Record<string, number>;
  pausaPct: number;
  atendimentos: number;
  pausasEstouradas: number;
  maiorEsperaSeg: number;
}

/** [NOVO] resposta das ações por atendente */
export interface ResultadoAcao {
  ok: boolean;
  simulado?: boolean;
  jaEstava?: boolean;
  estavaTravado?: boolean;
  descStatus?: string | null;
}

export interface PausaDaArgus {
  idPausa: number;
  pausaDesc: string;
}

export interface Interruptor {
  ligado: boolean;
  desde: string | null;
}

export type EstadoTermometro = 'medindo' | 'calma' | 'normal' | 'agressiva';
export type StatusDaUra = 'calma' | 'normal' | 'agressiva';

/** Termômetro automático (src/rodizio/termometro-ura.js; faixas em src/config/uraThresholds.js). */
export interface Termometro {
  estado: EstadoTermometro;
  desde: string | null;
  /** espera média dos humanos livres por uma ligação, em segundos (null = sem dado) */
  esperaSeg: number | null;
  atendimentos: number;
  livresAgora: number;
  callbacks: number;
  janelaMin: number;
  faixas: { estado: StatusDaUra; deSeg: number }[];
}

/** [NOVO] Status da URA que vale para o pânico (src/rodizio/status-ura.js). */
export interface StatusUra {
  status: EstadoTermometro;
  modo: 'automatico' | 'manual';
  desde: string | null;
  por: string | null;
  automatico: Termometro | null;
}

export interface SaudeRodizio {
  lastLoopUra?: string;
  uptime?: number;
  dryRun?: boolean;
  uraAgora?: OperadorNaUra[];
  /** [NOVO] quem está no Ativo agora */
  noAtivo?: OperadorNoAtivo[];
  fixosPermanentes?: string[];
  robos?: { ligados: number | null; total?: number; alvo?: number | null; modo?: 'panico' | 'automatico' };
  uraCheia?: { ligada: boolean; desde: string | null };
  panico?: Interruptor & {
    modo: boolean;
    ativoAgora: string | null;
    motivo: string | null;
    tipo?: 'zero' | 'saindo' | 'fixo' | null;
    antesDeSairMs?: number;
    fixoOciosoMs?: number | null;
    fixoReduzirMs?: number | null;
    /** A regra do fixo está relaxada agora (URA calma). */
    passivaAgora?: boolean;
  };
  termometro?: Termometro | null;
  statusUra?: StatusUra | null;
  /** [NOVO] quantos o "Alocar Todos no Ativo" moveria (o filtro é do backend) */
  transferenciaUraAtivo?: { elegiveis: number; fixos: number; uraCheiaLigada: boolean };
  /** [NOVO] "Alocar Todos no Ativo" segura todos lá até "Retomar rodízio da URA" (null = sem lista de elegíveis) */
  retencaoAtivo?: { ativa: boolean; desde: string | null; por: string | null; elegiveisParaVoltar: number | null };
  /** [NOVO] limites das pausas em minutos (src/config/pausas.js) */
  pausasLimitesMin?: Record<string, number>;
  relatorio?: RelatorioDoDia | null;
}

export interface HoraDoRelatorio {
  hora: string;
  livresMin: number;
  derivacoes: number;
  esperaPorDerivacaoSeg: number | null;
  ociosoSemRobosMin: number;
  panicoMin: number;
  calmaMin: number;
  agressivaMin: number;
  leadsDerivados?: number;
  transbordos?: number;
}

/** Relatório do dia (src/rodizio/estatisticas-dia.js). Minutos com uma casa. */
export interface RelatorioDoDia {
  dia: string;
  livresMin: number;
  derivacoes: number;
  esperaPorDerivacaoSeg: number | null;
  ociosoSemRobosMin: number;
  panicoMin: Record<'zero' | 'saindo' | 'fixo', number>;
  panicoVezes: Record<'zero' | 'saindo' | 'fixo', number>;
  termometroMin: Record<EstadoTermometro, number>;
  leadsDerivados?: number;
  transbordos?: number;
  transbordosPorMotivo?: Record<string, number>;
  filaMediaSeg?: number | null;
  /** [NOVO] minutos em pausa por tipo, hoje */
  pausasMin?: Record<string, number>;
  /** [NOVO] por atendente, hoje */
  porAtendente?: AtendenteDoDia[];
  horas: HoraDoRelatorio[];
}

/** [NOVO] GET /api/metricas/hoje (00:00 até agora). */
export interface MetricasHoje {
  dia: string | null;
  leadsDerivadosHoje: number | null;
  transbordosHoje: number | null;
  transbordosPorMotivo: Record<string, number>;
  filaClienteMediaSeg: number | null;
  esperaLivresSeg: number | null;
  /** a API da Argus não traz a fila em tempo real: null até haver fonte */
  emFilaAgora: number | null;
  ultimoWebhookEncerramento: string | null;
}

/** [NOVO] POST /api/operadores/retomar-rodizio */
export interface ResultadoRetomada {
  movidos: string[];
  erros: { ramal: string; erro: string }[];
  /** sem lista de elegíveis: ninguém foi movido, o rodízio gira todos */
  semLista: boolean;
  mudou: boolean;
}

/** [NOVO] POST /api/operadores/transferir-ura-ativo */
export interface ResultadoTransferencia {
  movidos: string[];
  ignorados: { ramal: string; nome: string | null; motivo: string }[];
  erros: { ramal: string; nome: string | null; erro: string }[];
  uraCheiaDesligada: boolean;
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
  estado: 'ligada' | 'desligando' | 'desligada' | 'religando' | 'reiniciando';
  etapa: string | null;
  desde: string | null;
  por: string | null;
  aviso: string | null;
  /** Botão "Modo simulação" (DRY_RUN): a escolha do painel; fixaPeloEnv = DRY_RUN=1 no .env. */
  simulacao?: { escolhida: boolean; fixaPeloEnv: boolean; desde: string | null; por: string | null };
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
  /** Total vendido no dia anterior (carga do dia). */
  vendaOntem?: number | null;
  fixo?: boolean;
}

export interface StatusRoteador {
  cargaInicialFeita?: boolean;
  ultimoMonitoramento?: string | null;
  meta?: number;
  /** Carga do dia: de que dia são as vendas de "ontem" (ex.: "20/10/2026"). */
  carga?: { diaAnterior?: string | null } | null;
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

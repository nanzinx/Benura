'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ROTEADOR DE VENDAS — Integração Site de Vendas ↔ Discadora Argus
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Autor: Automação BenConsig
 *  Requisitos: Node.js 18+ (usa fetch nativo e AbortController)
 *
 *  REGRAS DE NEGÓCIO:
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │ 1. CARGA INICIAL (início do dia):                                     │
 *  │    - Consulta vendas do dia anterior no site carrossel.benconsig.com   │
 *  │    - Vendedor com vendas > R$ 50.000 → vai direto para a URA          │
 *  │    - Vendedor com vendas ≤ R$ 50.000 → vai para o Ativo               │
 *  │                                                                       │
 *  │ 2. GATILHO DE MUDANÇA (durante o dia):                                │
 *  │    - Monitora vendedores no Ativo em tempo real                        │
 *  │    - Se vendedor fizer qualquer venda (valor > 0) hoje → URA          │
 *  │    - Transferência é imediata e permanece pelo resto do dia            │
 *  │                                                                       │
 *  │ 3. RESET DIÁRIO:                                                      │
 *  │    - À meia-noite ou ao reiniciar, o ciclo recomeça                    │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 *  COMO ADAPTAR PARA SUA API REAL:
 *  ────────────────────────────────
 *  1. Substitua as URLs em CFG.urlSiteVendas e CFG.urlArgusBase
 *  2. Ajuste os headers de autenticação em buscarVendasDoDia()
 *  3. Adapte o mapeamento de campos em mapearVendedor()
 *  4. Configure as variáveis de ambiente (veja seção CONFIG)
 *
 *  VARIÁVEIS DE AMBIENTE:
 *  ──────────────────────
 *  ARGUS_TOKEN            → Token de autenticação da API Argus
 *  ARGUS_BASE             → URL base da API Argus (ex: https://argus.app.br/apiargus/cmd)
 *  GRUPO_URA_ID           → ID do grupo da URA na discadora
 *  GRUPO_ATIVO_ID         → ID do grupo Ativo na discadora
 *  SITE_VENDAS_URL        → URL da API do site de vendas
 *  SITE_VENDAS_TOKEN      → Token de autenticação do site de vendas
 *  META_DIARIA            → Meta em reais (padrão: 50000)
 *  POLL_VENDAS_MS         → Intervalo de polling das vendas em ms (padrão: 60000)
 *  HORARIO_CARGA          → Horário da carga inicial no formato HH:MM (padrão: 08:00)
 *  PORT                   → Porta do servidor HTTP (padrão: 3001)
 *  DEBUG                  → 1 para habilitar logs de debug
 *  DRY_RUN                → 1 para simular sem executar transferências
 *  USAR_MOCK              → 1 para usar dados mockados (desenvolvimento)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 1: CONFIGURAÇÃO
// ═══════════════════════════════════════════════════════════════════════════════
// Todas as configurações são carregadas de variáveis de ambiente com valores
// padrão seguros para desenvolvimento. Em produção, configure via .env ou
// variáveis do sistema operacional.

const CFG = {
  // --- Argus (Discadora) ---
  argusToken: process.env.ARGUS_TOKEN || '',
  argusBase: (process.env.ARGUS_BASE || 'https://argus.app.br/apiargus/cmd').replace(/\/$/, ''),
  grupoUraId: Number(process.env.GRUPO_URA_ID || 2),
  grupoAtivoId: Number(process.env.GRUPO_ATIVO_ID || 1),

  // --- Site de Vendas ---
  siteVendasUrl: process.env.SITE_VENDAS_URL || 'https://carrossel.benconsig.com/api',
  siteVendasToken: process.env.SITE_VENDAS_TOKEN || '',

  // --- Regras de Negócio ---
  metaDiaria: Number(process.env.META_DIARIA || 50000),           // R$ 50.000,00
  pollVendasMs: Number(process.env.POLL_VENDAS_MS || 60000),      // 1 min entre checagens
  horarioCarga: process.env.HORARIO_CARGA || '08:00',             // Horário da carga inicial
  horarioFim: process.env.HORARIO_FIM || '18:00',                 // Fim do expediente

  // --- Operacional ---
  porta: Number(process.env.PORT || 3001),
  debug: process.env.DEBUG === '1',
  dryRun: process.env.DRY_RUN === '1',
  usarMock: process.env.USAR_MOCK === '1',
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'state-vendas.json'),
};

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2: DADOS MOCKADOS (para desenvolvimento e testes)
// ═══════════════════════════════════════════════════════════════════════════════
// Estes dados simulam a resposta da API do site de vendas.
// Em produção, eles NÃO serão usados — os dados reais virão da API.
//
// ESTRUTURA ESPERADA DO VENDEDOR:
// {
//   id:        number  → Identificador único do vendedor no site
//   nome:      string  → Nome completo do vendedor
//   ramal:     string  → Ramal na discadora (usado para transferências Argus)
//   equipe:    string  → Nome da equipe/supervisor
//   vendaOntem: number → Total vendido no dia anterior (em centavos ou reais)
//   vendaHoje:  number → Total vendido no dia de hoje
//   metaBatida: boolean → Se bateu a meta no dia anterior (calculado)
// }

const MOCK_VENDEDORES = [
  // ── Vendedores que BATERAM a meta ontem (vão para URA) ──
  {
    id: 1,
    nome: 'Ana Clara Souza',
    ramal: '1001',
    equipe: 'Equipe Alpha',
    vendaOntem: 72500.00,    // R$ 72.500 → acima de R$ 50.000 → URA
    vendaHoje: 0,
  },
  {
    id: 2,
    nome: 'Carlos Eduardo Lima',
    ramal: '1002',
    equipe: 'Equipe Alpha',
    vendaOntem: 55300.00,    // R$ 55.300 → acima de R$ 50.000 → URA
    vendaHoje: 0,
  },
  {
    id: 3,
    nome: 'Mariana Ferreira Costa',
    ramal: '1003',
    equipe: 'Equipe Beta',
    vendaOntem: 98100.00,    // R$ 98.100 → acima de R$ 50.000 → URA
    vendaHoje: 0,
  },

  // ── Vendedores que NÃO bateram a meta ontem (começam no Ativo) ──
  {
    id: 4,
    nome: 'Ricardo Mendes',
    ramal: '1004',
    equipe: 'Equipe Beta',
    vendaOntem: 32000.00,    // R$ 32.000 → abaixo de R$ 50.000 → Ativo
    vendaHoje: 0,
  },
  {
    id: 5,
    nome: 'Juliana Alves',
    ramal: '1005',
    equipe: 'Equipe Alpha',
    vendaOntem: 15800.00,    // R$ 15.800 → abaixo de R$ 50.000 → Ativo
    vendaHoje: 0,
  },
  {
    id: 6,
    nome: 'Fernando Ribeiro',
    ramal: '1006',
    equipe: 'Equipe Gamma',
    vendaOntem: 48900.00,    // R$ 48.900 → abaixo de R$ 50.000 → Ativo (por pouco!)
    vendaHoje: 0,
  },
  {
    id: 7,
    nome: 'Patrícia Santos',
    ramal: '1007',
    equipe: 'Equipe Gamma',
    vendaOntem: 0,           // R$ 0 → sem vendas ontem → Ativo
    vendaHoje: 0,
  },
  {
    id: 8,
    nome: 'Diego Oliveira',
    ramal: '1008',
    equipe: 'Equipe Beta',
    vendaOntem: 50000.00,    // R$ 50.000 → exatamente a meta → Ativo (precisa ser SUPERIOR)
    vendaHoje: 0,
  },
];

// Simula vendas acontecendo ao longo do dia (para testes do gatilho de mudança)
const MOCK_VENDAS_HOJE_SIMULADAS = [
  // Após ~2 minutos de execução, Ricardo faz uma venda → deve sair do Ativo → URA
  { ramal: '1004', valor: 12500.00, delay: 120000 },
  // Após ~5 minutos, Juliana faz uma venda → deve sair do Ativo → URA
  { ramal: '1005', valor: 3200.00, delay: 300000 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 3: UTILITÁRIOS (Logging, Persistência, HTTP)
// ═══════════════════════════════════════════════════════════════════════════════

// --- Logger com timestamp ISO ---
const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const dbg = (...args) => CFG.debug && log('[DEBUG]', ...args);
const warn = (...args) => log('[AVISO]', ...args);
const erro = (...args) => console.error(`[${new Date().toISOString()}] [ERRO]`, ...args);

// --- Estado persistido ---
// Este objeto guarda o estado do roteamento entre reinícios do script.
// Estrutura:
// {
//   data: "2026-10-06",            → Data do último processamento
//   vendedoresUra: ["1001", ...],  → Ramais atualmente na URA
//   vendedoresAtivo: ["1004", ...],→ Ramais atualmente no Ativo
//   historico: { "1004": { ... } } → Histórico de movimentações do dia
// }
let estado = {
  data: '',
  vendedoresUra: [],
  vendedoresAtivo: [],
  historico: {},
};

/**
 * Carrega o estado salvo do disco.
 * Recupera de .bak se o arquivo principal estiver corrompido.
 */
function carregarEstado() {
  try {
    const raw = fs.readFileSync(CFG.stateFile, 'utf8');
    estado = JSON.parse(raw);
    log(`Estado carregado: URA=${estado.vendedoresUra.length} Ativo=${estado.vendedoresAtivo.length}`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try {
        estado = JSON.parse(fs.readFileSync(`${CFG.stateFile}.bak`, 'utf8'));
        warn('State principal corrompido, recuperado via .bak');
      } catch {
        warn('Nenhum state encontrado, iniciando do zero');
      }
    }
  }
}

/**
 * Salva o estado atual no disco de forma atômica (tmp → rename).
 * Mantém um backup (.bak) para recuperação em caso de falha.
 */
async function salvarEstado() {
  try {
    const tmp = `${CFG.stateFile}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(estado, null, 2));
    await fs.promises.rename(tmp, CFG.stateFile);
    await fs.promises.copyFile(CFG.stateFile, `${CFG.stateFile}.bak`);
    dbg('Estado salvo com sucesso');
  } catch (e) {
    erro('Falha ao salvar estado:', e.message);
  }
}

/**
 * Retorna a data de ontem no formato YYYY-MM-DD.
 * Usada para consultar vendas do dia anterior.
 */
function dataOntem() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

/**
 * Retorna a data de hoje no formato YYYY-MM-DD.
 */
function dataHoje() {
  return new Date().toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 4: CLIENTE HTTP GENÉRICO
// ═══════════════════════════════════════════════════════════════════════════════
// Encapsula chamadas HTTP com timeout, retry e tratamento de erros.

/**
 * Executa uma requisição HTTP genérica.
 *
 * @param {string} url - URL completa do endpoint
 * @param {object} options - Opções da requisição
 * @param {string} options.method - GET ou POST (padrão: GET)
 * @param {object} options.headers - Headers adicionais
 * @param {object} options.body - Corpo da requisição (será serializado em JSON)
 * @param {number} options.timeout - Timeout em ms (padrão: 5000)
 * @returns {object} - { ok: boolean, status: number, data: object }
 */
async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 5000,
  } = options;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);

  try {
    const fetchOptions = {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      signal: ctl.signal,
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url, fetchOptions);
    const data = await res.json().catch(() => ({}));

    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    const descricao = e.name === 'AbortError' ? 'Timeout' : e.message;
    return { ok: false, status: 0, data: { erro: descricao } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executa uma requisição com retry automático.
 *
 * @param {Function} fn - Função async que retorna resultado de httpRequest
 * @param {number} tentativas - Número máximo de tentativas (padrão: 3)
 * @param {number} delayMs - Delay entre tentativas em ms (padrão: 1000)
 */
async function comRetry(fn, tentativas = 3, delayMs = 1000) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    const resultado = await fn();
    if (resultado.ok) return resultado;
    ultimo = resultado;
    if (i < tentativas - 1) {
      dbg(`Retry ${i + 1}/${tentativas} após falha: ${ultimo.data?.erro || ultimo.status}`);
      await new Promise(r => setTimeout(r, delayMs * (i + 1))); // backoff linear
    }
  }
  return ultimo;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 5: API DO SITE DE VENDAS
// ═══════════════════════════════════════════════════════════════════════════════
// Funções para consumir os dados de vendas do site carrossel.benconsig.com.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║  ATENÇÃO: ADAPTE ESTA SEÇÃO PARA A SUA API REAL                        ║
// ║                                                                         ║
// ║  Os endpoints abaixo são FICTÍCIOS, baseados na estrutura comum de      ║
// ║  APIs REST de sistemas de vendas. Você precisará:                       ║
// ║                                                                         ║
// ║  1. Trocar as URLs pelos endpoints reais do seu backend                 ║
// ║  2. Ajustar os headers de autenticação (Bearer, API Key, etc.)         ║
// ║  3. Adaptar o mapeamento de campos na função mapearVendedor()          ║
// ║  4. Testar com dados reais antes de colocar em produção                ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/**
 * Busca os dados de vendas de todos os vendedores para uma data específica.
 *
 * ENDPOINT REAL ESPERADO:
 *   GET {siteVendasUrl}/vendedores?data=2026-10-05
 *
 * RESPOSTA ESPERADA:
 *   {
 *     "success": true,
 *     "data": [
 *       {
 *         "id": 1,
 *         "nome": "Ana Clara Souza",
 *         "ramal": "1001",
 *         "equipe": "Equipe Alpha",
 *         "total_vendas": 72500.00,
 *         "quantidade_vendas": 12
 *       },
 *       ...
 *     ]
 *   }
 *
 * @param {string} data - Data no formato YYYY-MM-DD
 * @returns {Array} - Lista de vendedores com vendas do dia
 */
async function buscarVendasDoDia(data) {
  // ── MODO MOCK (desenvolvimento) ──
  if (CFG.usarMock) {
    log(`[MOCK] Retornando ${MOCK_VENDEDORES.length} vendedores mockados para data=${data}`);
    return MOCK_VENDEDORES.map(v => ({
      ...v,
      // No mock, "ontem" usa vendaOntem e "hoje" usa vendaHoje
      totalVendas: data === dataHoje() ? v.vendaHoje : v.vendaOntem,
    }));
  }

  // ── MODO REAL ──
  // TODO: Substitua pela URL real da sua API
  const url = `${CFG.siteVendasUrl}/vendedores?data=${data}`;
  const resultado = await comRetry(() => httpRequest(url, {
    headers: {
      // TODO: Ajuste o método de autenticação conforme sua API
      // Exemplos comuns:
      //   'Authorization': `Bearer ${CFG.siteVendasToken}`,
      //   'X-API-Key': CFG.siteVendasToken,
      //   'Token-Signature': CFG.siteVendasToken,
      'Authorization': `Bearer ${CFG.siteVendasToken}`,
    },
    timeout: 10000,
  }));

  if (!resultado.ok) {
    erro(`Falha ao buscar vendas para ${data}:`, resultado.data);
    return [];
  }

  // TODO: Adapte o mapeamento conforme a estrutura real da resposta
  const vendedores = resultado.data?.data || resultado.data?.vendedores || [];
  return vendedores.map(mapearVendedor);
}

/**
 * Mapeia os campos da API real para a estrutura interna do script.
 *
 * ADAPTE ESTA FUNÇÃO para os nomes de campo da sua API.
 * A estrutura interna espera:
 *   { id, nome, ramal, equipe, totalVendas }
 *
 * @param {object} raw - Objeto cru da API
 * @returns {object} - Objeto normalizado
 */
function mapearVendedor(raw) {
  // TODO: Ajuste os nomes dos campos conforme sua API real
  // Exemplo de mapeamento caso os campos da API sejam diferentes:
  //
  //   Campo da API Real       →  Campo Interno
  //   ─────────────────────────────────────────
  //   raw.seller_id            →  id
  //   raw.full_name            →  nome
  //   raw.extension_number     →  ramal
  //   raw.team_name            →  equipe
  //   raw.total_sales_amount   →  totalVendas
  //
  return {
    id: raw.id || raw.seller_id || raw.vendedor_id,
    nome: raw.nome || raw.full_name || raw.nome_vendedor,
    ramal: String(raw.ramal || raw.extension || raw.extension_number),
    equipe: raw.equipe || raw.team_name || raw.equipe_nome || 'Sem equipe',
    totalVendas: Number(raw.totalVendas || raw.total_vendas || raw.total_sales_amount || 0),
  };
}

/**
 * Busca as vendas do dia ATUAL de um vendedor específico.
 * Usada no monitoramento em tempo real para detectar o gatilho de mudança.
 *
 * ENDPOINT REAL ESPERADO:
 *   GET {siteVendasUrl}/vendedores/{ramal}/vendas-hoje
 *
 * RESPOSTA ESPERADA:
 *   { "total_vendas_hoje": 12500.00 }
 *
 * @param {string} ramal - Ramal do vendedor
 * @returns {number} - Total vendido hoje
 */
async function buscarVendasHojeDoVendedor(ramal) {
  // ── MODO MOCK ──
  if (CFG.usarMock) {
    // Simula vendas acontecendo ao longo do tempo
    const agora = Date.now();
    const vendaSimulada = MOCK_VENDAS_HOJE_SIMULADAS.find(
      v => v.ramal === ramal && agora - inicioExecucao >= v.delay
    );
    const valor = vendaSimulada ? vendaSimulada.valor : 0;
    if (valor > 0) dbg(`[MOCK] Venda simulada detectada: ramal=${ramal} valor=R$${valor.toFixed(2)}`);
    return valor;
  }

  // ── MODO REAL ──
  // TODO: Substitua pela URL real
  const url = `${CFG.siteVendasUrl}/vendedores/${ramal}/vendas-hoje`;
  const resultado = await comRetry(() => httpRequest(url, {
    headers: { 'Authorization': `Bearer ${CFG.siteVendasToken}` },
    timeout: 5000,
  }), 2);

  if (!resultado.ok) {
    dbg(`Falha ao buscar vendas hoje do ramal ${ramal}`);
    return -1; // -1 indica erro (não confundir com 0 = sem vendas)
  }

  return Number(resultado.data?.total_vendas_hoje || resultado.data?.totalVendas || 0);
}

// Timestamp de início da execução (usado para simulação de vendas mock)
const inicioExecucao = Date.now();

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 6: API DA DISCADORA ARGUS
// ═══════════════════════════════════════════════════════════════════════════════
// Funções para interagir com a API da discadora Argus.
// Estas funções já seguem o padrão do arquivo argus-automacao.js existente.

/**
 * Transfere um vendedor para um grupo na discadora.
 *
 * @param {string} ramal - Ramal do vendedor
 * @param {number} grupoDestinoId - ID do grupo destino (URA ou Ativo)
 * @returns {boolean} - true se a transferência foi bem-sucedida
 */
async function transferirParaGrupo(ramal, grupoDestinoId) {
  const nomeGrupo = grupoDestinoId === CFG.grupoUraId ? 'URA' : 'ATIVO';

  // Em modo DRY_RUN, apenas loga sem executar
  if (CFG.dryRun) {
    log(`[DRY_RUN] Transferiria ramal=${ramal} para ${nomeGrupo} (grupo=${grupoDestinoId})`);
    return true;
  }

  const url = `${CFG.argusBase}/transferiroperadorgrupo`;
  const resultado = await comRetry(() => httpRequest(url, {
    method: 'POST',
    headers: { 'Token-Signature': CFG.argusToken },
    body: {
      idGrupoUsuarioDestino: grupoDestinoId,
      ramaisOperadores: [ramal],
    },
    timeout: 4000,
  }), 2);

  if (resultado.ok && resultado.data?.codStatus === 1) {
    return true;
  }

  erro(`Falha ao transferir ramal=${ramal} para ${nomeGrupo}:`, resultado.data?.descStatus || resultado.status);
  return false;
}

/**
 * Transfere um vendedor para a URA (Receptivo).
 *
 * @param {string} ramal - Ramal do vendedor
 * @param {string} nome - Nome do vendedor (para log)
 * @param {string} motivo - Motivo da transferência (para log)
 * @returns {boolean}
 */
async function moverParaUra(ramal, nome, motivo) {
  log(`🟢 URA ← ramal=${ramal} (${nome}) | Motivo: ${motivo}`);
  const sucesso = await transferirParaGrupo(ramal, CFG.grupoUraId);
  if (sucesso) {
    log(`   ✅ Transferido com sucesso para URA`);
  } else {
    erro(`   ❌ Falha na transferência para URA`);
  }
  return sucesso;
}

/**
 * Transfere um vendedor para o Ativo (Prospecção).
 *
 * @param {string} ramal - Ramal do vendedor
 * @param {string} nome - Nome do vendedor (para log)
 * @param {string} motivo - Motivo da transferência (para log)
 * @returns {boolean}
 */
async function moverParaAtivo(ramal, nome, motivo) {
  log(`🔵 ATIVO ← ramal=${ramal} (${nome}) | Motivo: ${motivo}`);
  const sucesso = await transferirParaGrupo(ramal, CFG.grupoAtivoId);
  if (sucesso) {
    log(`   ✅ Transferido com sucesso para Ativo`);
  } else {
    erro(`   ❌ Falha na transferência para Ativo`);
  }
  return sucesso;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 7: LÓGICA DE NEGÓCIO — CARGA INICIAL
// ═══════════════════════════════════════════════════════════════════════════════
// Executada no início do dia (ou ao reiniciar o script).
// Consulta vendas do dia anterior e distribui os vendedores.

/**
 * Executa a carga inicial do dia.
 *
 * Fluxo:
 *  1. Busca vendas do dia anterior
 *  2. Separa vendedores em dois arrays: URA e Ativo
 *  3. Executa as transferências na discadora
 *  4. Salva o estado
 *
 * Diagrama:
 *                      ┌─────────────────┐
 *                      │ Buscar vendas    │
 *                      │ dia anterior     │
 *                      └────────┬────────┘
 *                               │
 *                    ┌──────────┴──────────┐
 *                    │                     │
 *              vendas > R$50k?        vendas ≤ R$50k?
 *                    │                     │
 *              ┌─────┴─────┐         ┌─────┴─────┐
 *              │    URA    │         │   ATIVO   │
 *              │ Receptivo │         │ Prospecção│
 *              └───────────┘         └───────────┘
 */
async function executarCargaInicial() {
  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  CARGA INICIAL — Distribuição de vendedores do dia');
  log(`  Data de referência (ontem): ${dataOntem()}`);
  log(`  Meta diária: R$ ${CFG.metaDiaria.toLocaleString('pt-BR')}`);
  log('════════════════════════════════════════════════════════════════');
  log('');

  // Passo 1: Buscar vendas do dia anterior
  const vendedores = await buscarVendasDoDia(dataOntem());

  if (vendedores.length === 0) {
    warn('Nenhum vendedor retornado pela API. Verifique a conexão e os endpoints.');
    return;
  }

  log(`📊 ${vendedores.length} vendedores encontrados no site de vendas`);
  log('');

  // Passo 2: Separar vendedores por regra de negócio
  //
  //   REGRA 1: vendaOntem > R$ 50.000 → URA (Receptivo)
  //   REGRA 2: vendaOntem ≤ R$ 50.000 → Ativo (Prospecção)
  //
  //   IMPORTANTE: O critério é "SUPERIOR a R$ 50.000", ou seja, R$ 50.000,00
  //   exatos NÃO se qualificam — o vendedor precisa ter vendido R$ 50.000,01+

  const paraUra = [];
  const paraAtivo = [];

  for (const vendedor of vendedores) {
    if (vendedor.totalVendas > CFG.metaDiaria) {
      paraUra.push(vendedor);
    } else {
      paraAtivo.push(vendedor);
    }
  }

  // Passo 3: Log detalhado da distribuição
  log('┌──────────────────────────────────────────────────────────────┐');
  log('│  🟢 VENDEDORES → URA (bateram meta ontem)                   │');
  log('├──────────────────────────────────────────────────────────────┤');
  if (paraUra.length === 0) {
    log('│  (nenhum vendedor bateu a meta)                             │');
  }
  for (const v of paraUra) {
    log(`│  Ramal: ${v.ramal.padEnd(6)} | ${v.nome.padEnd(25)} | R$ ${v.totalVendas.toLocaleString('pt-BR').padStart(12)} │`);
  }
  log('├──────────────────────────────────────────────────────────────┤');
  log('│  🔵 VENDEDORES → ATIVO (não bateram meta ontem)              │');
  log('├──────────────────────────────────────────────────────────────┤');
  if (paraAtivo.length === 0) {
    log('│  (todos bateram a meta!)                                    │');
  }
  for (const v of paraAtivo) {
    log(`│  Ramal: ${v.ramal.padEnd(6)} | ${v.nome.padEnd(25)} | R$ ${v.totalVendas.toLocaleString('pt-BR').padStart(12)} │`);
  }
  log('└──────────────────────────────────────────────────────────────┘');
  log('');

  // Passo 4: Executar transferências
  log('🔄 Executando transferências na discadora...');
  log('');

  // Transfere para URA
  for (const v of paraUra) {
    await moverParaUra(v.ramal, v.nome, `Meta batida ontem: R$ ${v.totalVendas.toLocaleString('pt-BR')}`);
  }

  // Transfere para Ativo
  for (const v of paraAtivo) {
    await moverParaAtivo(v.ramal, v.nome, `Abaixo da meta: R$ ${v.totalVendas.toLocaleString('pt-BR')}`);
  }

  // Passo 5: Salvar estado
  estado.data = dataHoje();
  estado.vendedoresUra = paraUra.map(v => v.ramal);
  estado.vendedoresAtivo = paraAtivo.map(v => v.ramal);
  estado.historico = {};

  // Registra histórico de cada vendedor
  for (const v of [...paraUra, ...paraAtivo]) {
    estado.historico[v.ramal] = {
      nome: v.nome,
      equipe: v.equipe,
      vendaOntem: v.totalVendas,
      filaAtual: v.totalVendas > CFG.metaDiaria ? 'URA' : 'ATIVO',
      movidoParaUraDuranteDia: false,
      horaMovimentacao: new Date().toISOString(),
    };
  }

  await salvarEstado();

  log('');
  log(`✅ Carga inicial concluída: ${paraUra.length} na URA | ${paraAtivo.length} no Ativo`);
  log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 8: LÓGICA DE NEGÓCIO — MONITORAMENTO EM TEMPO REAL
// ═══════════════════════════════════════════════════════════════════════════════
// Roda em loop durante o dia, checando se vendedores do Ativo fizeram vendas.
// Quando detecta uma venda, transfere imediatamente para a URA.

/**
 * Verifica vendedores no Ativo e transfere para URA se fizeram vendas hoje.
 *
 * REGRA 3 (Gatilho de Mudança):
 *   Vendedor no Ativo + qualquer venda hoje (valor > 0) → URA imediatamente
 *
 * Este método é chamado periodicamente (a cada POLL_VENDAS_MS milissegundos).
 */
async function monitorarVendasAtivo() {
  // Só monitora vendedores que estão no Ativo
  const vendedoresNoAtivo = [...estado.vendedoresAtivo];

  if (vendedoresNoAtivo.length === 0) {
    dbg('Nenhum vendedor no Ativo para monitorar');
    return;
  }

  dbg(`Monitorando ${vendedoresNoAtivo.length} vendedor(es) no Ativo...`);

  // Checa cada vendedor do Ativo
  for (const ramal of vendedoresNoAtivo) {
    const hist = estado.historico[ramal];
    if (!hist) continue;

    // Se já foi movido para URA durante o dia, pula
    if (hist.movidoParaUraDuranteDia) continue;

    // Busca vendas do dia atual
    const vendasHoje = await buscarVendasHojeDoVendedor(ramal);

    // -1 indica erro na API — não toma ação (princípio da cautela)
    if (vendasHoje < 0) {
      dbg(`Erro ao consultar vendas do ramal ${ramal}, ignorando neste ciclo`);
      continue;
    }

    // GATILHO: Vendedor fez qualquer venda hoje (valor > 0)
    if (vendasHoje > 0) {
      log('');
      log('⚡ GATILHO DE MUDANÇA DETECTADO!');
      log(`   Vendedor: ${hist.nome} (ramal=${ramal})`);
      log(`   Venda hoje: R$ ${vendasHoje.toLocaleString('pt-BR')}`);
      log(`   Ação: Transferir ATIVO → URA`);

      const sucesso = await moverParaUra(
        ramal,
        hist.nome,
        `Venda detectada hoje: R$ ${vendasHoje.toLocaleString('pt-BR')}`
      );

      if (sucesso) {
        // Atualiza arrays de estado
        estado.vendedoresAtivo = estado.vendedoresAtivo.filter(r => r !== ramal);
        estado.vendedoresUra.push(ramal);

        // Atualiza histórico
        hist.filaAtual = 'URA';
        hist.movidoParaUraDuranteDia = true;
        hist.vendaHojeQueDisparou = vendasHoje;
        hist.horaMovimentacao = new Date().toISOString();

        await salvarEstado();

        log(`   📊 Status: URA=${estado.vendedoresUra.length} | Ativo=${estado.vendedoresAtivo.length}`);
        log('');
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 9: WEBHOOK (alternativa ao polling para receber vendas em tempo real)
// ═══════════════════════════════════════════════════════════════════════════════
// Se o sistema de vendas suportar webhooks, esta rota pode receber notificações
// de vendas em tempo real, eliminando a necessidade de polling.
//
// COMO USAR:
//   Configure o sistema de vendas para enviar POST para:
//   http://seu-servidor:3001/webhook/venda
//
// PAYLOAD ESPERADO:
//   {
//     "ramal": "1004",
//     "vendedor": "Ricardo Mendes",
//     "valor": 12500.00,
//     "data": "2026-10-06",
//     "tipo": "nova_venda"
//   }

/**
 * Processa um webhook de venda recebido do sistema de vendas.
 *
 * @param {object} payload - Dados da venda
 */
async function processarWebhookVenda(payload) {
  const { ramal, vendedor, valor } = payload;

  if (!ramal || !valor || valor <= 0) {
    dbg('Webhook ignorado: dados incompletos ou valor inválido');
    return;
  }

  // Verifica se o vendedor está no Ativo
  if (!estado.vendedoresAtivo.includes(String(ramal))) {
    dbg(`Webhook: ramal=${ramal} não está no Ativo (já na URA ou desconhecido)`);
    return;
  }

  const hist = estado.historico[ramal];
  if (hist?.movidoParaUraDuranteDia) {
    dbg(`Webhook: ramal=${ramal} já foi movido para URA hoje`);
    return;
  }

  log('');
  log('⚡ WEBHOOK: Venda detectada em tempo real!');
  log(`   Vendedor: ${vendedor || hist?.nome || 'Desconhecido'} (ramal=${ramal})`);
  log(`   Valor: R$ ${valor.toLocaleString('pt-BR')}`);

  const sucesso = await moverParaUra(
    String(ramal),
    vendedor || hist?.nome || 'Desconhecido',
    `Webhook de venda: R$ ${valor.toLocaleString('pt-BR')}`
  );

  if (sucesso && hist) {
    estado.vendedoresAtivo = estado.vendedoresAtivo.filter(r => r !== String(ramal));
    estado.vendedoresUra.push(String(ramal));
    hist.filaAtual = 'URA';
    hist.movidoParaUraDuranteDia = true;
    hist.vendaHojeQueDisparou = valor;
    hist.horaMovimentacao = new Date().toISOString();
    await salvarEstado();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 10: SERVIDOR HTTP (Health Check, Webhook, Dashboard)
// ═══════════════════════════════════════════════════════════════════════════════

const servidor = http.createServer(async (req, res) => {
  // ── Health Check ──
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      dataAtual: dataHoje(),
      vendedoresUra: estado.vendedoresUra.length,
      vendedoresAtivo: estado.vendedoresAtivo.length,
      ultimoMonitoramento: ultimoMonitoramento,
    }));
  }

  // ── Dashboard: Resumo visual do estado atual ──
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      data: estado.data,
      meta: `R$ ${CFG.metaDiaria.toLocaleString('pt-BR')}`,
      ura: estado.vendedoresUra.map(r => ({
        ramal: r,
        ...estado.historico[r],
      })),
      ativo: estado.vendedoresAtivo.map(r => ({
        ramal: r,
        ...estado.historico[r],
      })),
    }, null, 2));
  }

  // ── Endpoint para forçar re-carga inicial manualmente ──
  if (req.url === '/recarregar' && req.method === 'POST') {
    res.writeHead(200).end('Recarga iniciada');
    log('📡 Recarga manual solicitada via API');
    executarCargaInicial();
    return;
  }

  // ── Webhook de Vendas (recebe notificações do sistema de vendas) ──
  if (req.url === '/webhook/venda' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) req.destroy(); // proteção contra payload grande
    });
    req.on('end', async () => {
      res.writeHead(200).end('ok');
      try {
        const payload = JSON.parse(body);
        await processarWebhookVenda(payload);
      } catch (e) {
        dbg('Webhook inválido:', e.message);
      }
    });
    return;
  }

  // ── 404 para rotas não reconhecidas ──
  res.writeHead(404).end('Not Found');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 11: ORQUESTRADOR PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
// Gerencia o ciclo de vida do script: carga inicial + monitoramento contínuo.

let ultimoMonitoramento = null;
let intervaloMonitoramento = null;

/**
 * Verifica se o horário atual está dentro do expediente.
 * O monitoramento só roda durante o expediente.
 */
function dentroDoExpediente() {
  const agora = new Date();
  const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  return horaAtual >= CFG.horarioCarga && horaAtual <= CFG.horarioFim;
}

/**
 * Verifica se a carga inicial do dia já foi executada.
 * Compara a data salva no estado com a data de hoje.
 */
function cargaInicialJaExecutadaHoje() {
  return estado.data === dataHoje();
}

/**
 * Inicia o loop de monitoramento de vendas.
 * Usa setInterval para checar periodicamente se houve vendas no dia.
 */
function iniciarMonitoramento() {
  if (intervaloMonitoramento) {
    clearInterval(intervaloMonitoramento);
  }

  log(`🔄 Monitoramento iniciado (intervalo: ${CFG.pollVendasMs / 1000}s)`);

  // Executa imediatamente na primeira vez
  monitorarVendasAtivo();

  // Agenda execução periódica
  intervaloMonitoramento = setInterval(async () => {
    if (!dentroDoExpediente()) {
      dbg('Fora do expediente, monitoramento pausado');
      return;
    }

    try {
      await monitorarVendasAtivo();
      ultimoMonitoramento = new Date().toISOString();
    } catch (e) {
      erro('Erro no monitoramento:', e.message);
    }
  }, CFG.pollVendasMs);
}

/**
 * Ponto de entrada principal do script.
 */
async function main() {
  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║     ROTEADOR DE VENDAS — BenConsig                         ║');
  log('║     Integração Site de Vendas ↔ Discadora Argus            ║');
  log('╠══════════════════════════════════════════════════════════════╣');
  log(`║  Meta diária:      R$ ${CFG.metaDiaria.toLocaleString('pt-BR').padEnd(36)}║`);
  log(`║  Horário:          ${CFG.horarioCarga} - ${CFG.horarioFim}                              ║`);
  log(`║  Polling vendas:   ${(CFG.pollVendasMs / 1000)}s                                   ║`);
  log(`║  Modo:             ${CFG.dryRun ? 'DRY RUN (simulação)' : 'PRODUÇÃO'}${CFG.dryRun ? '        ' : '                        '}║`);
  log(`║  Mock:             ${CFG.usarMock ? 'SIM (dados fictícios)' : 'NÃO (API real)'}${CFG.usarMock ? '       ' : '                  '}║`);
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');

  // Carrega estado anterior (se existir)
  carregarEstado();

  // Verifica se precisa executar carga inicial
  if (!cargaInicialJaExecutadaHoje()) {
    log('📅 Carga inicial do dia ainda não executada, iniciando...');
    await executarCargaInicial();
  } else {
    log(`📅 Carga inicial já executada hoje (${estado.data}). Retomando monitoramento.`);
    log(`   URA: ${estado.vendedoresUra.length} vendedores | Ativo: ${estado.vendedoresAtivo.length} vendedores`);
  }

  // Inicia monitoramento contínuo
  iniciarMonitoramento();

  // Inicia servidor HTTP
  servidor.listen(CFG.porta, () => {
    log(`🌐 Servidor HTTP ouvindo na porta ${CFG.porta}`);
    log(`   Health:    http://localhost:${CFG.porta}/health`);
    log(`   Status:    http://localhost:${CFG.porta}/status`);
    log(`   Webhook:   http://localhost:${CFG.porta}/webhook/venda`);
    log(`   Recarregar: POST http://localhost:${CFG.porta}/recarregar`);
    log('');
  });

  // Agenda checagem diária para reset da carga inicial
  // Verifica a cada 5 minutos se o dia mudou
  setInterval(async () => {
    if (!cargaInicialJaExecutadaHoje() && dentroDoExpediente()) {
      log('🌅 Novo dia detectado! Executando carga inicial...');
      await executarCargaInicial();
    }
  }, 5 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEÇÃO 12: GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

async function encerrar() {
  log('');
  log('🛑 Encerrando graciosamente...');

  // Para o monitoramento
  if (intervaloMonitoramento) clearInterval(intervaloMonitoramento);

  // Salva estado final
  await salvarEstado();

  // Fecha servidor
  servidor.close();

  log('   Estado salvo. Bye!');
  process.exit(0);
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
process.on('uncaughtException', (e) => {
  erro('Exceção não tratada:', e);
  encerrar();
});
process.on('unhandledRejection', (e) => {
  warn('Promise rejeitada não tratada:', e);
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUÇÃO
// ═══════════════════════════════════════════════════════════════════════════════
main().catch(e => {
  erro('Falha fatal ao iniciar:', e);
  process.exit(1);
});

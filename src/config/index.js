'use strict';
/**
 * Configuração centralizada do Roteador de Vendas.
 *
 * Toda configuração vem de variáveis de ambiente (opcionalmente carregadas de
 * um arquivo .env via dotenv). Nenhum outro módulo lê `process.env` diretamente:
 * isso mantém o restante do código testável e independente do ambiente.
 */

const path = require('path');
const { METRICAS } = require('../integrations/carrossel/carrossel.mapper');

/**
 * Carrega o .env, a menos que BENURA_SEM_DOTENV=1 (usado pela simulação no PM2
 * para não misturar um .env de produção com a configuração simulada).
 * dotenv é opcional: se não estiver instalado, seguimos só com process.env.
 */
function carregarDotenv() {
  if (process.env.BENURA_SEM_DOTENV === '1') return;
  try {
    require('dotenv').config();
  } catch {
    /* dotenv ausente — sem problema */
  }
}
carregarDotenv();

const env = (nome, padrao = '') => {
  const v = process.env[nome];
  return v === undefined || v === '' ? padrao : v;
};
const envNum = (nome, padrao) => {
  const n = Number(env(nome, padrao));
  return Number.isFinite(n) ? n : padrao;
};
const envBool = (nome, padrao = false) => {
  const v = env(nome, '');
  if (v === '') return padrao;
  return ['1', 'true', 'sim', 'yes'].includes(v.toLowerCase());
};
const semBarraFinal = (url) => url.replace(/\/+$/, '');
const envListaNum = (nome) => env(nome, '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
const envLista = (nome, padrao) => env(nome, padrao).split(',').map((x) => x.trim()).filter(Boolean);
const envListaTexto = (nome, padrao) => env(nome, padrao).toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);

/** Raiz do projeto: padrão dos arquivos do rodízio (mesmo lugar do argus-automacao.js original). */
const RAIZ = path.resolve(__dirname, '..', '..');

/**
 * Lê e valida a configuração.
 *
 * @param {object} [overrides] - Valores que sobrescrevem o ambiente (útil em testes).
 * @returns {Readonly<object>}
 */
function carregarConfig(overrides = {}) {
  const cfg = {
    // --- API do Carrossel (repositório Carrosel-BenApi) ---
    carrossel: {
      // Ex.: http://servidor-do-carrossel:4115 (sem barra no final)
      baseUrl: semBarraFinal(env('CARROSSEL_API_URL', env('SITE_VENDAS_URL', ''))),
      rotaRanking: env('CARROSSEL_ROTA_RANKING', '/ranking/vendedores'),
      // Campo da linha "GERAL" usado como total vendido. vendaConcluida é o
      // mesmo que o Carrossel usa para a meta diária de R$ 50 mil.
      metrica: env('CARROSSEL_METRICA', 'vendaConcluida'),
      // /ranking/vendedores hoje é aberto; preencha se a API passar a exigir token.
      token: env('CARROSSEL_API_TOKEN', env('SITE_VENDAS_TOKEN', '')),
      headerAuth: env('CARROSSEL_HEADER_AUTH', 'Authorization'),
      esquemaAuth: env('CARROSSEL_ESQUEMA_AUTH', ''),
      timeoutMs: envNum('CARROSSEL_TIMEOUT_MS', 15_000),
      tentativas: envNum('CARROSSEL_TENTATIVAS', 3),
    },

    // Exceções opcionais. O ramal e o grupo de cada um vêm do /listarusuarios da Argus;
    // estes arquivos só corrigem casos que a descoberta automática não resolve.
    arquivoRamais: env('VENDEDORES_RAMAIS_FILE', path.join(process.cwd(), 'vendedores-ramais.json')),
    arquivoSupervisoresGrupos: env('SUPERVISORES_GRUPOS_FILE', path.join(process.cwd(), 'supervisores-grupos.json')),

    // --- Discadora Argus ---
    argus: {
      baseUrl: semBarraFinal(env('ARGUS_BASE', 'https://argus.app.br/apiargus/cmd')),
      // Comandos de mailing ficam em /apiargus/{hashSkill}/... (sem o /cmd).
      baseMailing: semBarraFinal(env('ARGUS_BASE_MAILING',
        semBarraFinal(env('ARGUS_BASE', 'https://argus.app.br/apiargus/cmd')).replace(/\/cmd$/, ''))),
      token: env('ARGUS_TOKEN'),
      grupoUraId: envNum('GRUPO_URA_ID', 2),
      // Grupos do Ativo (um por supervisor). Mesmo formato do argus-automacao.js.
      gruposAtivosIds: envListaNum('GRUPOS_ATIVOS_IDS').length
        ? envListaNum('GRUPOS_ATIVOS_IDS')
        : envListaNum('GRUPO_ATIVO_ID'),
      timeoutMs: envNum('ARGUS_TIMEOUT_MS', 5_000),
      tentativas: envNum('ARGUS_TENTATIVAS', 2),
      // Cache curto da lista de grupos: evita martelar a Argus a cada venda.
      cacheGruposMs: envNum('ARGUS_CACHE_GRUPOS_MS', 15_000),
      // Cache do diretório de usuários (/listarusuarios).
      cacheDiretorioMs: envNum('ARGUS_CACHE_DIRETORIO_MS', 5 * 60_000),
      dryRun: envBool('DRY_RUN'),
    },

    // --- Rodízio Ativo ↔ URA e robôs (argus-automacao.js) ---
    // Mesmos nomes de variável do script original, para o .env existente continuar valendo.
    rodizio: {
      grupoUraDefinido: env('GRUPO_URA_ID') !== '',
      // Grupos dos robôs da URA (hoje URA PORT 3). GRUPO_ROBOS_URA_ID (um só) continua aceito.
      gruposRobosIds: envListaNum('GRUPOS_ROBOS_URA_IDS').length
        ? envListaNum('GRUPOS_ROBOS_URA_IDS')
        : envListaNum('GRUPO_ROBOS_URA_ID').filter(Boolean),
      // Robôs ligados por humano livre na URA (1 livre = 7 robôs, 2 = 14...). 0 livres = todos desligados.
      robosPorLivre: envNum('ROBOS_POR_LIVRE', 7),
      robosMaximo: envNum('ROBOS_MAXIMO', 0), // 0 = sem teto além do total de robôs
      tempoNaUraMs: envNum('TEMPO_MIN', 3) * 60_000,
      pollAtivoMs: envNum('POLL_ATIVO_MS', 3000),
      pollUraMs: envNum('POLL_URA_MS', 500),
      refreshGruposMs: envNum('REFRESH_GRUPOS_MS', 30_000),
      reativarRobos: env('REATIVAR_ROBOS', 'true') !== 'false',
      minRobosDesligadosMs: envNum('MIN_ROBOS_OFF_MS', 3000),
      concorrencia: envNum('CONCORRENCIA', 20),
      carenciaWebhookMs: envNum('WEBHOOK_GRACE_MS', 1500),
      descricoesStatus: {
        livres: envListaTexto('STATUS_LIVRE', 'livre,disponivel'),
        atendimento: envListaTexto('STATUS_ATENDIMENTO', 'em atendimento,falando,conversa'),
      },
      // Nomes próprios para não colidir com o roteador (que usa PORT e STATE_FILE).
      porta: envNum('RODIZIO_PORT', 3000),
      arquivoEstado: env('RODIZIO_STATE_FILE', path.join(RAIZ, 'state.json')),
      arquivoTrava: env('RODIZIO_LOCK_FILE', path.join(RAIZ, 'argus.lock')),
    },

    // --- Regras de negócio ---
    regras: {
      metaDiaria: envNum('META_DIARIA', 50_000),
      // Se true, vendedores que estão em um grupo diferente de URA/Ativo
      // (ex.: colocados manualmente em treinamento/supervisão) não são tocados.
      respeitarGruposExternos: envBool('RESPEITAR_GRUPOS_EXTERNOS', true),
    },

    // --- Agenda ---
    agenda: {
      pollVendasMs: envNum('POLL_VENDAS_MS', 60_000),
      horarioCarga: env('HORARIO_CARGA', '08:00'),
      horarioFim: env('HORARIO_FIM', '18:00'),
      fusoHorario: env('FUSO_HORARIO', 'America/Sao_Paulo'),
      verificarNovoDiaMs: envNum('VERIFICAR_NOVO_DIA_MS', 5 * 60_000),
    },

    // --- Servidor HTTP ---
    http: {
      porta: envNum('PORT', 3001),
      // Protege /webhook/venda e /recarregar. Vazio = sem autenticação.
      tokenAdmin: env('WEBHOOK_TOKEN', ''),
      limiteCorpoBytes: envNum('HTTP_LIMITE_CORPO', 64 * 1024),
    },

    // Simula Carrossel e Argus em memória (desenvolvimento, sem rede).
    usarMock: envBool('USAR_MOCK'),
    debug: envBool('DEBUG'),
    arquivoEstado: env('STATE_FILE', path.join(process.cwd(), 'state-vendas.json')),
    arquivoAuditoria: env('AUDITORIA_FILE', path.join(process.cwd(), 'auditoria-cadastro.jsonl')),
  };

  // --- Atualizador da produção (atualizador.js) ---
  // Depois do objeto acima porque as URLs de saúde usam as portas dos serviços.
  cfg.atualizador = {
    diretorio: RAIZ,
    branch: env('ATUALIZADOR_BRANCH', 'main'),
    intervaloMs: envNum('ATUALIZADOR_INTERVALO_MS', 60_000),
    apps: envLista('ATUALIZADOR_APPS', 'benura-roteador,benura-rodizio,benura-rotinas'),
    healthUrls: envLista('ATUALIZADOR_HEALTH_URLS', [cfg.http.porta, cfg.rodizio.porta, envNum('ROTINAS_PORT', 3003)]
      .map((p) => `http://localhost:${p}/health`).join(',')),
    healthTimeoutMs: envNum('ATUALIZADOR_HEALTH_TIMEOUT_MS', 30_000),
    porta: envNum('ATUALIZADOR_PORT', 3002),
    arquivoLog: env('ATUALIZADOR_LOG_FILE', path.join(RAIZ, 'logs', 'deploy.jsonl')),
    arquivoTrava: env('ATUALIZADOR_LOCK_FILE', path.join(RAIZ, 'atualizador.lock')),
  };

  // --- Notificações (avisos e resumos) ---
  cfg.notificacoes = {
    tipo: env('NOTIFICADOR', 'log'),
    arquivo: env('NOTIFICACOES_FILE', path.join(RAIZ, 'logs', 'notificacoes.jsonl')),
    benhub: {
      url: env('BENHUB_URL', 'https://benhub.benconsig.com'),
      // id do grupo no BenHub (o número em /api/internal-chat/{id}/messages)
      chatId: env('BENHUB_CHAT_ID', ''),
      // usuário próprio do robô: o token do BenHub vence em ~24 h e é renovado com ele
      email: env('BENHUB_EMAIL', ''),
      senha: env('BENHUB_SENHA', ''),
      token: env('BENHUB_TOKEN', ''),
      caminhoLogin: env('BENHUB_LOGIN_PATH', '/api/auth/login'),
      campoUsuario: env('BENHUB_LOGIN_CAMPO_USUARIO', 'email'),
      campoSenha: env('BENHUB_LOGIN_CAMPO_SENHA', 'password'),
      timeoutMs: envNum('BENHUB_TIMEOUT_MS', 10_000),
    },
  };

  // --- Rotinas diárias (rotinas.js / benura-rotinas) ---
  cfg.rotinas = {
    porta: envNum('ROTINAS_PORT', 3003),
    intervaloMs: envNum('ROTINAS_INTERVALO_MS', 60_000),
    arquivoTrava: env('ROTINAS_LOCK_FILE', path.join(RAIZ, 'rotinas.lock')),
    arquivoEstado: env('ROTINAS_STATE_FILE', path.join(RAIZ, 'state-rotinas.json')),
    fimExpediente: {
      ativo: envBool('FIM_EXPEDIENTE_ATIVO', true),
      // relatar = só avisa quem ficou logado; deslogar = também desconecta
      acao: env('FIM_EXPEDIENTE_ACAO', 'relatar'),
      margemMin: envNum('FIM_EXPEDIENTE_MARGEM_MIN', 10),
      ignorarRamais: envLista('FIM_EXPEDIENTE_IGNORAR_RAMAIS', ''),
      arquivoLog: env('FIM_EXPEDIENTE_LOG_FILE', path.join(RAIZ, 'logs', 'fim-expediente.jsonl')),
    },
    // Quem está Inativo no Vanguard e ativo na Argus: avisa e desloga.
    desligados: {
      ativo: envBool('DESLIGADOS_ATIVO', false),
      // Vazio = 07:30 e o horário do fim de expediente (HORARIO_FIM + margem)
      horarios: envLista('DESLIGADOS_HORARIOS', ''),
      arquivoLog: env('DESLIGADOS_LOG_FILE', path.join(RAIZ, 'logs', 'desligados.jsonl')),
    },
  };

  // --- Bases de mailing (Ativo, URA, Digital) — dentro do benura-rotinas ---
  cfg.bases = {
    // Uma entrada por base (agenda, filtros da esteira, equipes e skills). Veja bases.example.json.
    arquivoConfig: env('BASES_CONFIG_FILE', path.join(RAIZ, 'bases.json')),
    // arquivos = só gera os CSVs na pasta; argus = também sobe na skill de cada equipe
    modo: env('BASES_MODO', 'arquivos'),
    pastaSaida: env('BASES_PASTA_SAIDA', path.join(RAIZ, 'bases-geradas')),
    pastaDownloads: env('BASES_PASTA_ESTEIRA', path.join(RAIZ, 'bases-geradas', 'esteira')),
    diasSemana: envListaNum('BASES_DIAS_SEMANA').length ? envListaNum('BASES_DIAS_SEMANA') : [1, 2, 3, 4, 5],
    toleranciaMin: envNum('BASES_TOLERANCIA_MIN', 120),
    pausaEntreUploadsMs: envNum('BASES_PAUSA_UPLOAD_MS', 20_000),
    codificacao: env('BASES_CODIFICACAO', 'latin1'),
    arquivoEstado: env('BASES_STATE_FILE', path.join(RAIZ, 'state-bases.json')),
    arquivoLog: env('BASES_LOG_FILE', path.join(RAIZ, 'logs', 'bases.jsonl')),
    vanguard: {
      url: env('VANGUARD_URL', 'https://gestao.sistemacorban.com.br'),
      usuario: env('VANGUARD_USUARIO', ''),
      senha: env('VANGUARD_SENHA', ''),
      timeoutMs: envNum('VANGUARD_TIMEOUT_MS', 120_000),
      // Tela Funcionários (para a conferência de desligados): copie o endereço da barra do navegador
      urlFuncionarios: env('VANGUARD_FUNCIONARIOS_URL', ''),
      navegador: {
        canal: env('VANGUARD_NAVEGADOR', 'chrome'), // chrome ou msedge (já instalados no PC)
        executavel: env('VANGUARD_NAVEGADOR_CAMINHO', ''),
        headless: !envBool('VANGUARD_MOSTRAR_NAVEGADOR', false),
      },
    },
  };

  // --- Retorno de quem desistiu da fila da URA (dentro do benura-rodizio) ---
  cfg.retornoFila = {
    ativo: envBool('RETORNO_FILA_ATIVO', false),
    skillHash: env('RETORNO_SKILL_HASH', ''),
    janelaHoras: envNum('RETORNO_JANELA_HORAS', 4),
    incluirForaHorario: envBool('RETORNO_INCLUIR_FORA_HORARIO', true),
    origem: env('RETORNO_ORIGEM', 'RETORNO_URA'),
    arquivoEstado: env('RETORNO_STATE_FILE', path.join(RAIZ, 'state-retorno-fila.json')),
    arquivoLog: env('RETORNO_LOG_FILE', path.join(RAIZ, 'logs', 'retorno-fila.jsonl')),
  };

  return Object.freeze(mesclarProfundo(cfg, overrides));
}

function mesclarProfundo(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object'
      ? mesclarProfundo(base[k], v)
      : v;
  }
  return out;
}

/**
 * Valida a configuração e retorna a lista de problemas encontrados.
 * Problemas fatais impedem a inicialização; avisos apenas são logados.
 *
 * @param {object} cfg
 * @param {{ escopo?: 'roteador'|'argus' }} [opcoes] - 'argus' valida só o necessário
 *        para ferramentas que usam apenas a Argus (ex.: cadastro de operadores).
 * @returns {{ fatais: string[], avisos: string[] }}
 */
function validarConfig(cfg, { escopo = 'roteador' } = {}) {
  const fatais = [];
  const avisos = [];
  const horaValida = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h);

  if (!cfg.usarMock && !cfg.argus.token) fatais.push('ARGUS_TOKEN é obrigatório (ou use USAR_MOCK=1).');
  if (!cfg.usarMock && !cfg.carrossel.baseUrl) fatais.push('CARROSSEL_API_URL é obrigatório (ou use USAR_MOCK=1).');
  if (!METRICAS.includes(cfg.carrossel.metrica)) fatais.push(`CARROSSEL_METRICA inválida: "${cfg.carrossel.metrica}" (use ${METRICAS.join(', ')}).`);
  if (!cfg.argus.gruposAtivosIds.length || cfg.argus.gruposAtivosIds.some((id) => !Number.isInteger(id))) {
    fatais.push('GRUPOS_ATIVOS_IDS é obrigatório: IDs dos grupos do Ativo separados por vírgula (ex.: 3,5,7).');
  }
  if (cfg.argus.gruposAtivosIds.includes(cfg.argus.grupoUraId)) fatais.push('GRUPO_URA_ID não pode estar em GRUPOS_ATIVOS_IDS.');
  if (!horaValida(cfg.agenda.horarioCarga)) fatais.push(`HORARIO_CARGA inválido: "${cfg.agenda.horarioCarga}" (use HH:MM).`);
  if (!horaValida(cfg.agenda.horarioFim)) fatais.push(`HORARIO_FIM inválido: "${cfg.agenda.horarioFim}" (use HH:MM).`);
  if (cfg.regras.metaDiaria <= 0) fatais.push('META_DIARIA deve ser maior que zero.');
  if (cfg.agenda.pollVendasMs < 5_000) avisos.push('POLL_VENDAS_MS < 5s pode sobrecarregar a API do Carrossel.');
  if (!cfg.http.tokenAdmin) avisos.push('WEBHOOK_TOKEN vazio: /webhook/venda e /recarregar estão sem autenticação.');

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.agenda.fusoHorario });
  } catch {
    fatais.push(`FUSO_HORARIO inválido: "${cfg.agenda.fusoHorario}".`);
  }

  if (escopo === 'rodizio') return validarRodizio(cfg);
  if (escopo === 'atualizador') return validarAtualizador(cfg, fatais);
  if (escopo === 'rotinas') return validarRotinas(cfg, fatais);
  if (escopo === 'argus') {
    const relevantes = /ARGUS|GRUPO/;
    return { fatais: fatais.filter((f) => relevantes.test(f)), avisos: [] };
  }
  return { fatais, avisos };
}

/** Validação do rodízio: os grupos são obrigatórios e sem valor padrão (um erro aqui mexe na URA). */
function validarRodizio(cfg) {
  const fatais = [];
  const avisos = [];
  const { rodizio: r, argus: a } = cfg;

  if (!a.token) fatais.push('ARGUS_TOKEN é obrigatório.');
  if (!r.grupoUraDefinido) fatais.push('GRUPO_URA_ID é obrigatório.');
  if (!r.gruposRobosIds.length || r.gruposRobosIds.some((id) => !Number.isInteger(id))) {
    fatais.push('GRUPOS_ROBOS_URA_IDS é obrigatório (grupos dos robôs da URA, ex.: 6).');
  }
  if (!(r.robosPorLivre >= 1)) fatais.push('ROBOS_POR_LIVRE deve ser 1 ou mais.');
  if (!a.gruposAtivosIds.length) fatais.push('GRUPOS_ATIVOS_IDS é obrigatório (whitelist dos grupos do Ativo).');
  if (a.gruposAtivosIds.includes(a.grupoUraId)) fatais.push('GRUPO_URA_ID não pode estar em GRUPOS_ATIVOS_IDS.');
  if (r.gruposRobosIds.includes(a.grupoUraId)) fatais.push('GRUPOS_ROBOS_URA_IDS não pode conter o GRUPO_URA_ID.');
  if (r.tempoNaUraMs <= 0) fatais.push('TEMPO_MIN deve ser maior que zero.');
  if (!cfg.http.tokenAdmin) avisos.push('WEBHOOK_TOKEN vazio: o webhook do rodízio aceita chamadas sem autenticação.');
  if (cfg.retornoFila.ativo && !cfg.retornoFila.skillHash) {
    fatais.push('RETORNO_FILA_ATIVO=true exige RETORNO_SKILL_HASH (hash da skill que recebe os retornos; veja /listarskills).');
  }
  if (cfg.retornoFila.janelaHoras <= 0) fatais.push('RETORNO_JANELA_HORAS deve ser maior que zero.');
  return { fatais, avisos };
}

/** Validação das rotinas diárias. */
function validarRotinas(cfg, fataisGerais) {
  const fatais = fataisGerais.filter((f) => /HORARIO|FUSO|ARGUS_TOKEN/.test(f));
  const { fimExpediente: f } = cfg.rotinas;
  if (!['relatar', 'deslogar'].includes(f.acao)) fatais.push(`FIM_EXPEDIENTE_ACAO inválida: "${f.acao}" (use relatar ou deslogar).`);
  if (f.margemMin < 0 || f.margemMin > 180) fatais.push('FIM_EXPEDIENTE_MARGEM_MIN deve estar entre 0 e 180.');
  return { fatais, avisos: [] };
}

const urlValida = (u) => {
  try {
    return Boolean(new URL(u));
  } catch {
    return false;
  }
};

/** Validação do atualizador; reaproveita as checagens de horário e fuso já feitas. */
function validarAtualizador(cfg, fataisGerais) {
  const a = cfg.atualizador;
  const fatais = fataisGerais.filter((f) => /HORARIO|FUSO/.test(f));
  if (a.intervaloMs < 10_000) fatais.push('ATUALIZADOR_INTERVALO_MS deve ser de pelo menos 10000 (10 s).');
  if (!a.apps.length) fatais.push('ATUALIZADOR_APPS vazio: informe os apps do PM2 a recarregar.');
  const invalidas = a.healthUrls.filter((u) => !urlValida(u));
  if (invalidas.length) fatais.push(`ATUALIZADOR_HEALTH_URLS com URL inválida: ${invalidas.join(', ')}`);
  return { fatais, avisos: [] };
}

module.exports = { carregarConfig, validarConfig };

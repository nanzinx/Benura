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
      // Mover de grupo quem já está logado muda a lista na hora, mas a telefonia só troca
      // quando a pessoa fica livre, com atraso. Quem fica preso no grupo antigo (na URA,
      // a derivação dos robôs não chega e vira callback) é relogado (logaroperador).
      alinharLogin: envBool('ALINHAR_LOGIN_APOS_TRANSFERIR', true),
      esperaLoginMs: envNum('ALINHAR_LOGIN_ESPERA_MS', 1500),
      // A discadora troca o grupo sozinha quando a pessoa fica livre (com atraso):
      // só reloga quem continua no grupo antigo depois deste tempo.
      alinharAposMs: envNum('ALINHAR_LOGIN_APOS_MS', 30_000),
      // Pausa por limite (HTTP 429) compartilhada entre roteador, rodízio e rotinas.
      arquivoPausa: env('ARGUS_PAUSA_FILE', path.join(RAIZ, 'argus-pausa.json')),
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
      // Cada callback (cliente desistiu da fila: webhook tipo 5) baixa um degrau de robôs
      // por livre, até o mínimo; sem callback por ROBOS_RECUPERAR_APOS_MIN, sobe um de volta.
      ajusteCallback: envBool('ROBOS_AJUSTE_CALLBACK', true),
      porLivreMinimo: envNum('ROBOS_POR_LIVRE_MINIMO', 4),
      recuperarAposMs: envNum('ROBOS_RECUPERAR_APOS_MIN', 15) * 60_000,
      intervaloAjusteMs: envNum('ROBOS_AJUSTE_INTERVALO_S', 60) * 1000,
      // Ajuste gravado para um reinício no mesmo dia retomar o degrau em que estava.
      arquivoAjuste: env('RODIZIO_AJUSTE_FILE', path.join(RAIZ, 'state-ajuste-robos.json')),
      // Minutos ocioso (Livre) seguidos na URA antes de voltar ao Ativo. Atender zera a contagem.
      tempoNaUraMs: envNum('TEMPO_MIN', 3) * 60_000,
      // A regra do ocioso vale sempre. Quando o último livre da URA está a este tempo de
      // sair, os robôs param de discar para os que estão em ligação terminarem antes. 0 = não prepara.
      // (SEGURAR_ULTIMO_LIVRE_MS, do .env antigo, não vale mais: era 90 s, demais com poucos na URA.)
      prepararSaidaMs: envNum('PREPARAR_SAIDA_ULTIMO_LIVRE_MS', 30_000),
      // Quem acabou de passar a telefonia para a URA (troca de grupo ou relogin) só conta
      // como livre para os robôs depois deste tempo (15/10: callback 37 s depois da troca).
      carenciaTrocaMs: envNum('CARENCIA_TROCA_GRUPO_MS', 60_000),
      // Movido que fica offline só volta ao Ativo se continuar offline por este tempo
      // (durante a troca ou um relogin o status pisca "deslogado").
      offlineVoltaAposMs: envNum('OFFLINE_VOLTA_APOS_MS', 60_000),
      // Só sobe do Ativo para a URA quem o roteador pôs na URA hoje (meta de ontem, venda
      // hoje ou fixo), lido do STATE_FILE do roteador. Sem a lista do dia, gira todos.
      soElegiveis: envBool('RODIZIO_SO_ELEGIVEIS', true),
      arquivoVendas: env('STATE_FILE', path.join(process.cwd(), 'state-vendas.json')),
      // Intervalo entre as consultas à Argus (Ativo e URA). 5 s evita o liga-desliga
      // de robôs a cada oscilação de status; o webhook de atendimento continua imediato.
      pollAtivoMs: envNum('POLL_ATIVO_MS', 5000),
      pollUraMs: envNum('POLL_URA_MS', 5000),
      // URA em alerta: com 1 a LIVRES_ALERTA livres, o próximo atendimento pode deixar a URA
      // sem ninguém livre e os robôs ligados. Lê mais rápido até a situação passar
      // (dispensável quando o webhook tipo 1 está configurado, que desliga na hora).
      pollUraAlertaMs: envNum('POLL_URA_ALERTA_MS', 1000),
      livresAlerta: envNum('LIVRES_ALERTA', 2),
      refreshGruposMs: envNum('REFRESH_GRUPOS_MS', 30_000),
      reativarRobos: env('REATIVAR_ROBOS', 'true') !== 'false',
      // Espera desde a última redução para voltar a AUMENTAR (reduzir é sempre imediato).
      // 15 s amortece o sobe-e-desce de 7 em 7 quando um emprestado entra e sai da URA.
      minRobosDesligadosMs: envNum('MIN_ROBOS_OFF_MS', 15_000),
      // Como na operação manual: reduzir com gente livre só quando a queda dura isso
      // (ninguém livre continua desligando na hora) e religar em degraus.
      reduzirAposMs: envNum('ROBOS_REDUZIR_APOS_MS', 10_000),
      degrauSubida: envNum('ROBOS_DEGRAU', 7),
      intervaloSubidaMs: envNum('ROBOS_SUBIDA_INTERVALO_MS', 10_000),
      concorrencia: envNum('CONCORRENCIA', 20),
      carenciaWebhookMs: envNum('WEBHOOK_GRACE_MS', 1500),
      descricoesStatus: {
        livres: envListaTexto('STATUS_LIVRE', 'livre,disponivel'),
        atendimento: envListaTexto('STATUS_ATENDIMENTO', 'atendimento,em atendimento,falando,conversa'),
        // Robô desligado: a Argus responde sucesso com status "Deslogado".
        offline: envListaTexto('STATUS_OFFLINE', 'deslogado,offline,desconectado'),
      },
      // Nomes próprios para não colidir com o roteador (que usa PORT e STATE_FILE).
      porta: envNum('RODIZIO_PORT', 3000),
      arquivoEstado: env('RODIZIO_STATE_FILE', path.join(RAIZ, 'state.json')),
      arquivoTrava: env('RODIZIO_LOCK_FILE', path.join(RAIZ, 'argus.lock')),
      // URA cheia (GET /ura): ligada pela supervisão, vale até desligar ou virar o dia.
      arquivoUraCheia: env('RODIZIO_URA_CHEIA_FILE', path.join(RAIZ, 'state-ura-cheia.json')),
    },

    // --- Regras de negócio ---
    regras: {
      metaDiaria: envNum('META_DIARIA', 50_000),
      // Operadores fixos: começam o dia na URA com ou sem venda (ramais ou nomes, separados por vírgula).
      // Depois seguem o rodízio: ociosos vão ao Ativo e voltam à URA ao atender lá.
      fixosUra: envLista('OPERADORES_FIXOS_URA', ''),
      // Equipes fixas: toda a equipe destes supervisores (nomes como na Argus) começa o dia
      // na URA, como os fixos. Ex.: EQUIPES_FIXAS_URA=ROBSON JUNIOR
      equipesFixasUra: envLista('EQUIPES_FIXAS_URA', ''),
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
    // Uma instância só do roteador (PM2 e uma janela ao mesmo tempo transfeririam em dobro).
    arquivoTrava: env('ROTEADOR_LOCK_FILE', path.join(RAIZ, 'roteador.lock')),
    // Esteira colada em GET /manual (redundância do Carrossel)
    arquivoEsteiraManual: env('ESTEIRA_MANUAL_FILE', path.join(process.cwd(), 'state-esteira-manual.json')),
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
 * @param {{ escopo?: 'roteador'|'rodizio'|'rotinas'|'atualizador' }} [opcoes] - qual serviço está subindo
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
  avisos.push(...avisosDeEnvAntigo(r));
  return { fatais, avisos };
}

/**
 * O .env manda mais que o padrão: um .env feito com uma versão antiga anula
 * correções novas sem ninguém perceber. Avisa os valores que já causaram problema.
 */
function avisosDeEnvAntigo(r) {
  const avisos = [];
  const { atendimento, offline } = r.descricoesStatus;
  if (r.pollUraMs < 2000) avisos.push(`POLL_URA_MS=${r.pollUraMs} é de uma versão antiga e faz os robôs oscilarem. Use 5000 (ou apague a linha do .env).`);
  if (r.pollAtivoMs < 2000) avisos.push(`POLL_ATIVO_MS=${r.pollAtivoMs} é de uma versão antiga. Use 5000 (ou apague a linha do .env).`);
  if (r.minRobosDesligadosMs < 10_000) avisos.push(`MIN_ROBOS_OFF_MS=${r.minRobosDesligadosMs} deixa os robôs subirem e descerem a cada oscilação. Use 15000 (ou apague a linha do .env).`);
  if (!atendimento.includes('atendimento')) avisos.push('STATUS_ATENDIMENTO não tem "atendimento", o texto que a Argus usa: quem está em ligação pode ser devolvido ao Ativo. Apague a linha do .env.');
  if (!offline.includes('deslogado')) avisos.push('STATUS_OFFLINE não tem "deslogado", o texto que a Argus usa para robô desligado. Apague a linha do .env.');
  return avisos;
}

/** Validação das rotinas diárias. */
function validarRotinas(cfg, fataisGerais) {
  const fatais = fataisGerais.filter((f) => /HORARIO|FUSO|ARGUS_TOKEN/.test(f));
  const { fimExpediente: f } = cfg.rotinas;
  if (!['relatar', 'deslogar'].includes(f.acao)) fatais.push(`FIM_EXPEDIENTE_ACAO inválida: "${f.acao}" (use relatar ou deslogar).`);
  if (f.margemMin < 0 || f.margemMin > 180) fatais.push('FIM_EXPEDIENTE_MARGEM_MIN deve estar entre 0 e 180.');
  const avisos = [];
  if (f.ativo && f.acao === 'deslogar' && !f.ignorarRamais.length) {
    avisos.push('FIM_EXPEDIENTE_ACAO=deslogar sem FIM_EXPEDIENTE_IGNORAR_RAMAIS: o plantão também será desconectado. '
      + 'Liste os ramais de plantão ou use "relatar".');
  }
  return { fatais, avisos };
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

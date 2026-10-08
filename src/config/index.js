'use strict';
/**
 * Configuração centralizada do Roteador de Vendas.
 *
 * Toda configuração vem de variáveis de ambiente (opcionalmente carregadas de
 * um arquivo .env via dotenv). Nenhum outro módulo lê `process.env` diretamente:
 * isso mantém o restante do código testável e independente do ambiente.
 */

const path = require('path');

// dotenv é opcional: se não estiver instalado, seguimos só com process.env.
try {
  require('dotenv').config();
} catch {
  /* dotenv ausente — sem problema */
}

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

/**
 * Lê e valida a configuração.
 *
 * @param {object} [overrides] - Valores que sobrescrevem o ambiente (útil em testes).
 * @returns {Readonly<object>}
 */
function carregarConfig(overrides = {}) {
  const cfg = {
    // --- API do Carrossel (fonte dos dados de vendas) ---
    carrossel: {
      baseUrl: semBarraFinal(env('CARROSSEL_API_URL', env('SITE_VENDAS_URL', 'https://carrossel.benconsig.com/api'))),
      token: env('CARROSSEL_API_TOKEN', env('SITE_VENDAS_TOKEN', '')),
      // Contrato da API é configurável para não exigir mudança de código
      // caso a rota ou a autenticação do Carrossel mudem.
      rotaVendedores: env('CARROSSEL_ROTA_VENDEDORES', '/vendedores'),
      parametroData: env('CARROSSEL_PARAM_DATA', 'data'),
      headerAuth: env('CARROSSEL_HEADER_AUTH', 'Authorization'),
      esquemaAuth: env('CARROSSEL_ESQUEMA_AUTH', 'Bearer'),
      timeoutMs: envNum('CARROSSEL_TIMEOUT_MS', 10_000),
      tentativas: envNum('CARROSSEL_TENTATIVAS', 3),
      usarMock: envBool('USAR_MOCK'),
    },

    // --- Discadora Argus ---
    argus: {
      baseUrl: semBarraFinal(env('ARGUS_BASE', 'https://argus.app.br/apiargus/cmd')),
      token: env('ARGUS_TOKEN'),
      grupoUraId: envNum('GRUPO_URA_ID', 2),
      grupoAtivoId: envNum('GRUPO_ATIVO_ID', 1),
      timeoutMs: envNum('ARGUS_TIMEOUT_MS', 5_000),
      tentativas: envNum('ARGUS_TENTATIVAS', 2),
      // Cache curto da lista de grupos: evita martelar a Argus a cada venda.
      cacheGruposMs: envNum('ARGUS_CACHE_GRUPOS_MS', 15_000),
      dryRun: envBool('DRY_RUN'),
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

    debug: envBool('DEBUG'),
    arquivoEstado: env('STATE_FILE', path.join(process.cwd(), 'state-vendas.json')),
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
 * @returns {{ fatais: string[], avisos: string[] }}
 */
function validarConfig(cfg) {
  const fatais = [];
  const avisos = [];
  const horaValida = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h);

  if (!cfg.argus.dryRun && !cfg.argus.token) fatais.push('ARGUS_TOKEN é obrigatório (ou use DRY_RUN=1).');
  if (!cfg.carrossel.usarMock && !cfg.carrossel.baseUrl) fatais.push('CARROSSEL_API_URL é obrigatório (ou use USAR_MOCK=1).');
  if (cfg.argus.grupoUraId === cfg.argus.grupoAtivoId) fatais.push('GRUPO_URA_ID e GRUPO_ATIVO_ID não podem ser iguais.');
  if (!horaValida(cfg.agenda.horarioCarga)) fatais.push(`HORARIO_CARGA inválido: "${cfg.agenda.horarioCarga}" (use HH:MM).`);
  if (!horaValida(cfg.agenda.horarioFim)) fatais.push(`HORARIO_FIM inválido: "${cfg.agenda.horarioFim}" (use HH:MM).`);
  if (cfg.regras.metaDiaria <= 0) fatais.push('META_DIARIA deve ser maior que zero.');
  if (cfg.agenda.pollVendasMs < 5_000) avisos.push('POLL_VENDAS_MS < 5s pode sobrecarregar a API do Carrossel.');
  if (!cfg.carrossel.usarMock && !cfg.carrossel.token) avisos.push('CARROSSEL_API_TOKEN vazio: requisições irão sem autenticação.');
  if (!cfg.http.tokenAdmin) avisos.push('WEBHOOK_TOKEN vazio: /webhook/venda e /recarregar estão sem autenticação.');

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.agenda.fusoHorario });
  } catch {
    fatais.push(`FUSO_HORARIO inválido: "${cfg.agenda.fusoHorario}".`);
  }

  return { fatais, avisos };
}

module.exports = { carregarConfig, validarConfig };

'use strict';
/**
 * Anti-corruption layer da API do Carrossel (Carrosel-BenApi).
 *
 * É o ÚNICO ponto do sistema que conhece o formato da resposta de
 * `GET /ranking/vendedores`, que tem esta forma:
 *
 *   {
 *     "hoje":    [ Vendedor, ... ],
 *     "ontem":   [ Vendedor, ... ],   // dia ÚTIL anterior (pula fim de semana/feriado)
 *     "semanal": [ ... ], "mensal": [ ... ],
 *     "ultimaExtracao": "08/10/2026 10:42:00" | "Erro" | "Desconhecida",
 *     "diaOntem": "07/10/2026"
 *   }
 *
 *   Vendedor = {
 *     "nome": "FULANO DE TAL",
 *     "performance": [
 *       { "Equipe": "GERAL", "vendaConcluida": 1234.5, "vendaGeral": ..., "Integrado": ..., ... },
 *       { "Equipe": "Equipe X", ... }
 *     ],
 *     "ranking-geral": 1, "ranking-integrado": 3
 *   }
 *
 * Observações sobre a API:
 *  - Vendedores identificados apenas por NOME (sem ramal).
 *  - Cada período lista só quem teve venda nele: quem não vendeu não aparece.
 *  - Em erro interno a API responde 200 com listas vazias e ultimaExtracao "Erro".
 */

const { paraNumero } = require('../../utils/moeda');

const PERIODOS = Object.freeze(['hoje', 'ontem', 'semanal', 'mensal']);

/** Métricas aceitas (campos da linha GERAL de `performance`). */
const METRICAS = Object.freeze(['vendaConcluida', 'vendaGeral', 'Integrado', 'vendaPendente']);

class RespostaCarrosselInvalidaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'RespostaCarrosselInvalidaError';
  }
}

/**
 * Normaliza um nome para comparação: maiúsculas, sem acento, espaços simples.
 * "  Joao  da Silva " e "JOÃO DA SILVA" → "JOAO DA SILVA"
 */
function normalizarNome(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * Converte um vendedor cru do Carrossel no modelo interno.
 * @returns {{ nome: string, chave: string, equipe: string, totalVendas: number }|null}
 */
function mapearVendedor(raw, metrica) {
  if (!raw || typeof raw !== 'object' || !raw.nome) return null;

  const performance = Array.isArray(raw.performance) ? raw.performance : [];
  const geral = performance.find((p) => p?.Equipe === 'GERAL');
  const equipes = performance.filter((p) => p?.Equipe && p.Equipe !== 'GERAL').map((p) => p.Equipe);

  return {
    nome: String(raw.nome).trim(),
    chave: normalizarNome(raw.nome),
    equipe: equipes.join(', ') || 'Sem equipe',
    totalVendas: paraNumero(geral?.[metrica]),
  };
}

/**
 * Extrai e normaliza um período da resposta de /ranking/vendedores.
 *
 * @param {object} payload - Resposta crua
 * @param {'hoje'|'ontem'} periodo
 * @param {string} metrica - Campo da linha GERAL usado como total de vendas
 * @returns {{ vendedores: object[], ultimaExtracao: string|null, diaOntem: string|null, descartados: number }}
 * @throws {RespostaCarrosselInvalidaError}
 */
function mapearRanking(payload, periodo, metrica) {
  if (!PERIODOS.includes(periodo)) throw new RangeError(`Período inválido: ${periodo}`);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RespostaCarrosselInvalidaError('Resposta do Carrossel não é um objeto de ranking.');
  }
  if (payload.ultimaExtracao === 'Erro') {
    throw new RespostaCarrosselInvalidaError('O Carrossel reportou erro ao processar seus relatórios (ultimaExtracao = "Erro").');
  }
  if (!Array.isArray(payload[periodo])) {
    throw new RespostaCarrosselInvalidaError(`Resposta do Carrossel sem a lista "${periodo}".`);
  }

  // Soma por nome normalizado, caso o mesmo agente apareça mais de uma vez.
  const porChave = new Map();
  let descartados = 0;
  for (const raw of payload[periodo]) {
    const v = mapearVendedor(raw, metrica);
    if (!v) { descartados++; continue; }
    const existente = porChave.get(v.chave);
    if (existente) existente.totalVendas += v.totalVendas;
    else porChave.set(v.chave, v);
  }

  return {
    vendedores: [...porChave.values()],
    ultimaExtracao: payload.ultimaExtracao ?? null,
    diaOntem: payload.diaOntem ?? null,
    descartados,
  };
}

module.exports = {
  mapearRanking, mapearVendedor, normalizarNome, PERIODOS, METRICAS, RespostaCarrosselInvalidaError,
};

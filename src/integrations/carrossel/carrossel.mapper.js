'use strict';
/**
 * Anti-corruption layer da API do Carrossel.
 *
 * Converte o payload cru da API no modelo interno `Vendedor`:
 *   { id, nome, ramal, equipe, totalVendas }
 *
 * É o ÚNICO ponto do sistema que conhece os nomes de campos do Carrossel.
 * Se a API mudar o formato, ajuste apenas os aliases abaixo.
 */

const { paraNumero } = require('../../utils/moeda');

/** Aliases aceitos para cada campo interno, em ordem de prioridade. */
const ALIASES = Object.freeze({
  id: ['id', 'vendedor_id', 'vendedorId', 'seller_id', 'sellerId', 'idVendedor'],
  nome: ['nome', 'nome_vendedor', 'nomeVendedor', 'vendedor', 'name', 'full_name'],
  ramal: ['ramal', 'extension', 'extension_number', 'ramalArgus', 'ramal_argus'],
  equipe: ['equipe', 'equipe_nome', 'equipeNome', 'team', 'team_name', 'supervisor'],
  totalVendas: [
    'totalVendas', 'total_vendas', 'total', 'valorTotal', 'valor_total',
    'total_sales_amount', 'vendas', 'valor',
  ],
});

/** Chaves comuns que envolvem a lista de registros na resposta. */
const CHAVES_LISTA = ['data', 'vendedores', 'items', 'results', 'resultado', 'ranking', 'carrossel'];

const primeiro = (obj, chaves) => {
  for (const k of chaves) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
};

/**
 * Extrai o array de registros de qualquer formato de resposta suportado:
 *   [ ... ] | { data: [ ... ] } | { data: { vendedores: [ ... ] } } | ...
 *
 * @returns {Array<object>}
 * @throws {TypeError} quando não há lista reconhecível
 */
function extrairLista(payload, profundidade = 0) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && profundidade < 3) {
    for (const k of CHAVES_LISTA) {
      if (payload[k] !== undefined) return extrairLista(payload[k], profundidade + 1);
    }
  }
  throw new TypeError('Resposta do Carrossel em formato desconhecido (lista de vendedores não encontrada)');
}

/**
 * Normaliza um registro cru.
 * @returns {object|null} Vendedor normalizado, ou null se não tiver ramal.
 */
function mapearVendedor(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Alguns formatos aninham o vendedor: { vendedor: { nome, ramal }, total: 10 }
  const fonte = raw.vendedor && typeof raw.vendedor === 'object' ? { ...raw, ...raw.vendedor } : raw;

  const ramal = primeiro(fonte, ALIASES.ramal);
  if (ramal === undefined) return null;

  const nome = primeiro(fonte, ALIASES.nome);
  return {
    id: primeiro(fonte, ALIASES.id) ?? null,
    nome: typeof nome === 'string' ? nome.trim() : `Ramal ${ramal}`,
    ramal: String(ramal).trim(),
    equipe: primeiro(fonte, ALIASES.equipe) ?? 'Sem equipe',
    totalVendas: paraNumero(primeiro(fonte, ALIASES.totalVendas)),
  };
}

/**
 * Converte o payload em lista de vendedores únicos por ramal.
 * Se a API devolver várias linhas para o mesmo ramal (ex.: uma por venda),
 * os valores são somados.
 *
 * @returns {{ vendedores: object[], descartados: number }}
 */
function mapearResposta(payload) {
  const lista = extrairLista(payload);
  const porRamal = new Map();
  let descartados = 0;

  for (const raw of lista) {
    const v = mapearVendedor(raw);
    if (!v) { descartados++; continue; }

    const existente = porRamal.get(v.ramal);
    if (existente) existente.totalVendas += v.totalVendas;
    else porRamal.set(v.ramal, v);
  }

  return { vendedores: [...porRamal.values()], descartados };
}

module.exports = { mapearResposta, mapearVendedor, extrairLista, ALIASES };

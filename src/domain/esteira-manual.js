'use strict';
/**
 * Esteira colada à mão — redundância do Carrossel. Funções puras, sem I/O.
 *
 * Quando o Carrossel está fora do ar, a esteira (exportada em CSV ou copiada
 * da tela) vira um ranking no MESMO formato de GET /ranking/vendedores, e o
 * roteador segue com as regras de sempre. Usa só três colunas:
 *   Agente (quem vendeu) · Valor Contrato · Data/Hora (cadastro)
 * e Proposta, quando existir, para não contar a mesma proposta duas vezes.
 *
 * "Ontem" é o último dia trabalhado: a data mais recente antes de hoje que
 * tem vendas na esteira (segunda-feira → sexta; depois de feriado, o dia útil).
 */

const { paraNumero } = require('../utils/moeda');
const { normalizarNome } = require('../utils/texto');

class EsteiraInvalidaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'EsteiraInvalidaError';
  }
}

/** Colunas aceitas (cabeçalho normalizado → campo). */
const COLUNAS = Object.freeze({
  agente: ['AGENTE'],
  valor: ['VALOR CONTRATO'],
  data: ['DATA/HORA', 'DATA CADASTRO', 'DATA'],
  proposta: ['PROPOSTA'],
});
const OBRIGATORIAS = ['agente', 'valor', 'data'];

/** Quebra uma linha respeitando aspas ("a;b" é um campo só; "" é aspas literal). */
function dividirLinha(linha, separador) {
  const campos = [];
  let atual = '';
  let entreAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"' && entreAspas && linha[i + 1] === '"') {
      atual += '"';
      i++;
    } else if (c === '"') {
      entreAspas = !entreAspas;
    } else if (c === separador && !entreAspas) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos.map((v) => v.trim());
}

/** Export da esteira usa ";"; copiar a tabela da tela usa TAB. */
const detectarSeparador = (cabecalho) => (cabecalho.split('\t').length > cabecalho.split(';').length ? '\t' : ';');

/** Índice de cada campo no cabeçalho. @throws {EsteiraInvalidaError} */
function indicesDasColunas(cabecalho) {
  const nomes = cabecalho.map(normalizarNome);
  const indices = Object.fromEntries(Object.entries(COLUNAS)
    .map(([campo, aceitos]) => [campo, nomes.findIndex((n) => aceitos.includes(n))]));

  const faltando = OBRIGATORIAS.filter((campo) => indices[campo] < 0);
  if (faltando.length) {
    const esperadas = faltando.map((campo) => COLUNAS[campo][0]).join(', ');
    throw new EsteiraInvalidaError(`Faltam as colunas ${esperadas} no cabeçalho. Vieram: ${cabecalho.filter(Boolean).join(', ')}.`);
  }
  return indices;
}

/** "13/10/2026  10:21:33" → "2026-10-13"; null se não for uma data dd/mm/aaaa. */
function dataDoCadastro(texto) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(texto || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Linha da esteira → venda; null quando falta agente, data ou valor. */
function paraVenda(campos, indices) {
  const venda = {
    agente: String(campos[indices.agente] || '').trim(),
    valor: paraNumero(campos[indices.valor]),
    data: dataDoCadastro(campos[indices.data]),
    proposta: indices.proposta >= 0 ? String(campos[indices.proposta] || '').trim() : '',
  };
  return venda.agente && venda.data && venda.valor > 0 ? venda : null;
}

/**
 * Lê a esteira colada (CSV com ";" ou tabela copiada com TAB).
 * @returns {{ vendas: Array<{ agente, valor, data, proposta }>, ignoradas: number }}
 * @throws {EsteiraInvalidaError}
 */
function lerEsteira(texto) {
  const linhas = String(texto || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (linhas.length < 2) throw new EsteiraInvalidaError('A esteira colada precisa do cabeçalho e de pelo menos uma linha.');

  const separador = detectarSeparador(linhas[0]);
  const indices = indicesDasColunas(dividirLinha(linhas[0], separador));
  const lidas = linhas.slice(1).map((l) => paraVenda(dividirLinha(l, separador), indices));
  const vendas = lidas.filter(Boolean);
  return { vendas, ignoradas: lidas.length - vendas.length };
}

/**
 * Soma as vendas por dia e por agente, contando cada proposta uma vez.
 * @returns {Record<string, Record<string, { nome: string, total: number }>>} dia → chave do agente → total
 */
function totaisPorDia(vendas) {
  const vistas = new Set();
  const dias = {};
  for (const v of vendas) {
    if (v.proposta && vistas.has(v.proposta)) continue;
    if (v.proposta) vistas.add(v.proposta);

    const dia = (dias[v.data] ||= {});
    const chave = normalizarNome(v.agente);
    dia[chave] = { nome: dia[chave]?.nome || v.agente, total: (dia[chave]?.total || 0) + v.valor };
  }
  return dias;
}

/** Último dia trabalhado antes de `hoje` (YYYY-MM-DD), entre os dias colados. */
const ultimoDiaAntes = (dias, hoje) => Object.keys(dias).filter((d) => d < hoje).sort().pop() || null;

const formatarDia = (iso) => (iso ? iso.split('-').reverse().join('/') : null);

/** Vendedores de um dia no formato do Carrossel (linha GERAL com a métrica). */
const vendedoresDoDia = (dia, metrica) => Object.values(dia || {})
  .map(({ nome, total }) => ({ nome, performance: [{ Equipe: 'GERAL', [metrica]: Math.round(total * 100) / 100 }] }));

/**
 * Ranking no formato de GET /ranking/vendedores, a partir dos dias colados.
 * @param {object} dias - saída de totaisPorDia (ou a união de várias colagens)
 * @param {string} hoje - YYYY-MM-DD
 * @param {string} metrica - campo da linha GERAL lido pelo mapper (CARROSSEL_METRICA)
 * @param {string} [coladaEm] - descrição de quando foi colada, para o log
 */
function rankingDaEsteira(dias, hoje, metrica, coladaEm = '') {
  const ontem = ultimoDiaAntes(dias, hoje);
  return {
    hoje: vendedoresDoDia(dias[hoje], metrica),
    ontem: vendedoresDoDia(ontem && dias[ontem], metrica),
    ultimaExtracao: `Esteira colada${coladaEm ? ` ${coladaEm}` : ''}`,
    diaOntem: formatarDia(ontem),
  };
}

/** Une colagens: os dias da nova substituem os mesmos dias da anterior; guarda os `manter` mais recentes. */
function unirDias(anteriores, novos, manter = 7) {
  const todos = { ...anteriores, ...novos };
  return Object.fromEntries(Object.keys(todos).sort().slice(-manter).map((d) => [d, todos[d]]));
}

/** Lista de um dia, maior venda primeiro, com o total arredondado. */
const listaDoDia = (dia) => Object.values(dia || {})
  .map(({ nome, total }) => ({ nome, total: Math.round(total * 100) / 100 }))
  .sort((a, b) => b.total - a.total);

/**
 * O que a esteira colada vai decidir hoje, para conferir na página.
 * @returns {{ diaAnterior: string|null, acimaDaMeta: object[], vendeuHoje: object[] }}
 */
function resumoDaEsteira(dias, hoje, metaDiaria) {
  const anterior = ultimoDiaAntes(dias, hoje);
  return {
    diaAnterior: formatarDia(anterior),
    acimaDaMeta: listaDoDia(anterior && dias[anterior]).filter((v) => v.total > metaDiaria),
    vendeuHoje: listaDoDia(dias[hoje]),
  };
}

module.exports = {
  resumoDaEsteira,
  EsteiraInvalidaError, lerEsteira, totaisPorDia, rankingDaEsteira, unirDias, ultimoDiaAntes, dataDoCadastro, formatarDia,
};

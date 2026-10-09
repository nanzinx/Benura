'use strict';
/**
 * Bases de mailing (Ativo, URA, Digital) — regras puras.
 *
 * Como a base é montada hoje na planilha (Power Query "Base atualizada"):
 *   base mestra ("NÃO MEXA")  −  clientes da esteira (remoção)  →  embaralha  →  divide pelas equipes
 *
 * Ativo/URA: a esteira define quem SAI da base mestra (já convertido ou reprovado).
 * Digital: a esteira define a própria base (clientes parados em certos status).
 *
 * O CSV de cada equipe segue o layout que vocês sobem hoje na Argus:
 *   CPF;BENEFICIO;NOME;TELEFONE1;TELEFONE2;TELEFONE3;TELEFONE4;TELEFONE5
 */

const { normalizarNome } = require('../utils/texto');

/** Tipo de base: de onde vêm os clientes. */
const TipoBase = Object.freeze({
  REMOCAO: 'remocao', // base mestra − esteira (Ativo, URA)
  ESTEIRA: 'esteira', // a base é a própria esteira filtrada (Digital)
});

const CABECALHO_MAILING = ['CPF', 'BENEFICIO', 'NOME', 'TELEFONE1', 'TELEFONE2', 'TELEFONE3', 'TELEFONE4', 'TELEFONE5'];

/** Compara status sem acento, caixa ou espaços duplos ("CLIENTE COM  AÇÃO" = "cliente com acao"). */
const normalizarStatus = normalizarNome;

/** Lista vazia = aceita todos os status. */
function criarFiltroStatus(lista = []) {
  const aceitos = new Set(lista.map(normalizarStatus));
  if (!aceitos.size) return () => true;
  return (status) => aceitos.has(normalizarStatus(status));
}

/** Valor de uma coluna, aceitando variações de caixa/acento no cabeçalho. */
function coluna(linha, nome) {
  if (nome in linha) return linha[nome];
  const alvo = normalizarNome(nome);
  const chave = Object.keys(linha).find((k) => normalizarNome(k) === alvo);
  return chave === undefined ? undefined : linha[chave];
}

const texto = (v) => String(v ?? '').trim();

/**
 * Chaves (código/CPF) das linhas da esteira que passam no filtro de status.
 * @param {object[]} linhas - linhas da esteira (cabeçalho → valor)
 * @param {{ colunaChave: string, colunaStatus?: string, status?: string[] }} regra
 */
function chavesDaEsteira(linhas, { colunaChave, colunaStatus = 'Status', status = [] }) {
  const aceita = criarFiltroStatus(status);
  const chaves = new Set();
  for (const l of linhas) {
    const chave = texto(coluna(l, colunaChave));
    if (chave && aceita(coluna(l, colunaStatus))) chaves.add(chave);
  }
  return chaves;
}

/** Base mestra − remoção (o "left anti join" do Power Query), sem repetir cliente. */
function removerDaBase(base, chavesRemover) {
  const vistos = new Set();
  return base.filter((lead) => {
    if (!lead.chave || chavesRemover.has(lead.chave) || vistos.has(lead.chave)) return false;
    vistos.add(lead.chave);
    return true;
  });
}

/**
 * Converte linhas de uma planilha em leads { chave, beneficio, nome }.
 * @param {{ chave: string, beneficio: string, nome: string }} colunas - nomes das colunas
 */
function paraLeads(linhas, colunas) {
  return linhas.map((l) => ({
    chave: texto(coluna(l, colunas.chave)),
    beneficio: texto(coluna(l, colunas.beneficio)),
    nome: texto(coluna(l, colunas.nome)),
  }));
}

/** Base Digital: clientes da esteira nos status escolhidos, sem repetir. */
function leadsDaEsteira(linhas, { colunas, colunaStatus = 'Status', status = [] }) {
  const aceita = criarFiltroStatus(status);
  return removerDaBase(paraLeads(linhas.filter((l) => aceita(coluna(l, colunaStatus))), colunas), new Set());
}

/** Fisher–Yates: o "=ALEATÓRIO()" + ordenar da planilha. */
function embaralhar(lista, aleatorio = Math.random) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(aleatorio() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Partes iguais: 5 equipes → total / 5. A sobra vai uma para cada, a partir da primeira.
 * @param {number} [limite] - máximo por equipe (opcional)
 */
function dividirIgual(lista, partes, limite = Infinity) {
  const base = Math.floor(lista.length / partes);
  const sobra = lista.length % partes;
  let inicio = 0;
  return Array.from({ length: partes }, (_, i) => {
    const tamanho = base + (i < sobra ? 1 : 0);
    const parte = lista.slice(inicio, inicio + Math.min(tamanho, limite));
    inicio += tamanho;
    return parte;
  });
}

/** Equipes que entram na divisão (as com "copiaDe" recebem cópia de outra e não dividem). */
const equipesDaDivisao = (equipes) => equipes.filter((e) => !e.copiaDe);

/**
 * De qual equipe uma equipe-cópia recebe a base hoje.
 *   "rodizio" → reveza por dia entre as equipes da divisão;
 *   nome de uma equipe → sempre aquela.
 * @returns {string} nome da equipe de origem
 */
function origemDaCopia(copiaDe, divididas, dataIso) {
  if (!divididas.length) throw new Error('Nenhuma equipe na divisão para copiar.');
  if (normalizarNome(copiaDe) === 'RODIZIO') {
    const dia = Math.floor(Date.parse(`${dataIso}T12:00:00Z`) / 86_400_000);
    return divididas[dia % divididas.length].nome;
  }
  const origem = divididas.find((e) => normalizarNome(e.nome) === normalizarNome(copiaDe));
  if (!origem) throw new Error(`"copiaDe": "${copiaDe}" não é uma equipe da divisão (${divididas.map((e) => e.nome).join(', ')}).`);
  return origem.nome;
}

/**
 * Quem recebe o quê: as equipes da divisão recebem uma parte cada; as
 * equipes-cópia recebem a mesma parte da equipe de origem.
 * @returns {Array<{ equipe: object, leads: object[], copiaDe?: string }>}
 */
function distribuir(equipes, partes, dataIso) {
  const divididas = equipesDaDivisao(equipes);
  const parteDe = new Map(divididas.map((e, i) => [e.nome, partes[i]]));
  return equipes.map((equipe) => {
    if (!equipe.copiaDe) return { equipe, leads: parteDe.get(equipe.nome) };
    const origem = origemDaCopia(equipe.copiaDe, divididas, dataIso);
    return { equipe, leads: parteDe.get(origem), copiaDe: origem };
  });
}

/** Tira o separador e quebras de linha de um campo do CSV. */
const campoCsv = (v) => texto(v).replace(/[;\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

/** CSV no layout de importação da Argus (separador ";", quebra CRLF). */
function montarCsvMailing(leads) {
  const linhas = leads.map((l) => [l.chave, l.beneficio, l.nome, '', '', '', '', ''].map(campoCsv).join(';'));
  return `${[CABECALHO_MAILING.join(';'), ...linhas].join('\r\n')}\r\n`;
}

/** Nome do arquivo (é também a descrição do mailing dentro da Argus). */
function nomeDoArquivo({ base, equipe, data, horario }) {
  const limpo = (s) => normalizarNome(s).replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `BASE-${limpo(base)}-${limpo(equipe)}-${data.replace(/-/g, '')}-${horario.replace(':', '')}.csv`;
}

// ───────────────────────────── Agenda ─────────────────────────────

const minutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (total) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/**
 * Horários do dia de uma base.
 *   ["08:00"]                                → uma vez por dia
 *   { de: "08:00", ate: "18:00", aCadaMin: 60 } → 08:00, 09:00 … 18:00
 */
function horariosDoDia(agenda) {
  if (Array.isArray(agenda)) return [...agenda].sort();
  const lista = [];
  for (let t = minutos(agenda.de); t <= minutos(agenda.ate); t += agenda.aCadaMin) lista.push(hhmm(t));
  return lista;
}

/**
 * Qual horário rodar agora (ou null). Só o mais recente que já passou e ainda não
 * rodou hoje: se o PC ligar às 09:30, roda o das 09:00 uma vez (não recupera os perdidos).
 * Depois de `toleranciaMin` sem rodar, o horário é dado como perdido.
 */
function horarioPendente({ horarios, hora, data, diaSemana, diasSemana, ultima, toleranciaMin }) {
  if (!diasSemana.includes(diaSemana)) return null;
  const passados = horarios.filter((h) => h <= hora);
  const alvo = passados[passados.length - 1];
  if (!alvo) return null;
  if (minutos(hora) - minutos(alvo) > toleranciaMin) return null;
  if (ultima?.data === data && ultima.horario >= alvo) return null;
  return alvo;
}

module.exports = {
  TipoBase,
  CABECALHO_MAILING,
  normalizarStatus,
  criarFiltroStatus,
  coluna,
  chavesDaEsteira,
  removerDaBase,
  paraLeads,
  leadsDaEsteira,
  embaralhar,
  dividirIgual,
  equipesDaDivisao,
  origemDaCopia,
  distribuir,
  montarCsvMailing,
  nomeDoArquivo,
  horariosDoDia,
  horarioPendente,
};

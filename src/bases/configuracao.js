'use strict';
/**
 * Configuração das bases (bases.json): uma entrada por base (ativo, ura, digital).
 * Veja bases.example.json. O arquivo fica fora do git (tem os hashes das skills).
 */

const fs = require('fs');
const { TipoBase, horariosDoDia } = require('../domain/bases');
const { normalizarNome } = require('../utils/texto');

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Lê o bases.json. Sem arquivo → nenhuma base (a rotina fica parada). */
function carregarBases(arquivo) {
  if (!arquivo || !fs.existsSync(arquivo)) return {};
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return Object.fromEntries(Object.entries(dados).filter(([nome]) => !nome.startsWith('_')));
}

/** Problemas de uma base. @returns {string[]} */
function problemasDaBase(nome, b, { modo }) {
  const p = [];
  const erro = (m) => p.push(`bases.json › ${nome}: ${m}`);
  if (!Object.values(TipoBase).includes(b.tipo)) erro(`"tipo" deve ser ${Object.values(TipoBase).join(' ou ')}.`);
  if (!Array.isArray(b.equipes) || !b.equipes.length) erro('informe as "equipes".');
  if (!Array.isArray(b.cenarios) || !b.cenarios.length) erro('informe os "cenarios" da esteira.');
  (b.cenarios || []).forEach((c, i) => {
    if (!c.nome || !c.tipoData) erro(`cenário ${i + 1} precisa de "nome" e "tipoData".`);
  });
  const horarios = b.agenda ? horariosDoDia(b.agenda) : [];
  if (!horarios.length || horarios.some((h) => !HORA.test(h))) erro('"agenda" inválida (ex.: ["08:00"] ou { "de": "08:00", "ate": "18:00", "aCadaMin": 60 }).');
  if (b.tipo === TipoBase.REMOCAO && !b.baseMestra?.arquivo) erro('informe "baseMestra.arquivo".');
  if (b.tipo === TipoBase.REMOCAO && b.baseMestra?.arquivo && !fs.existsSync(b.baseMestra.arquivo)) {
    erro(`base mestra não encontrada: ${b.baseMestra.arquivo}`);
  }
  const semSkill = (b.equipes || []).filter((e) => !e.skillHash && !e.idSkill).map((e) => e.nome);
  if (modo === 'argus' && semSkill.length) erro(`BASES_MODO=argus, mas sem "idSkill" (ou "skillHash"): ${semSkill.join(', ')}.`);
  p.push(...problemasDasCopias(nome, b.equipes || []));
  return p;
}

/** Equipes-cópia precisam de pelo menos uma equipe na divisão e de uma origem válida. */
function problemasDasCopias(nome, equipes) {
  const divididas = equipes.filter((e) => !e.copiaDe);
  const copias = equipes.filter((e) => e.copiaDe);
  if (!copias.length) return [];
  if (!divididas.length) return [`bases.json › ${nome}: todas as equipes são cópia; pelo menos uma precisa entrar na divisão.`];
  const nomes = new Set(divididas.map((e) => normalizarNome(e.nome)));
  return copias
    .filter((e) => normalizarNome(e.copiaDe) !== 'RODIZIO' && !nomes.has(normalizarNome(e.copiaDe)))
    .map((e) => `bases.json › ${nome}: ${e.nome} copia "${e.copiaDe}", que não é uma equipe da divisão (use o nome de uma equipe ou "rodizio").`);
}

/**
 * Valida as bases ligadas e o acesso ao Vanguard.
 * @returns {string[]} problemas fatais
 */
function validarBases(cfgBases) {
  const ligadas = Object.entries(cfgBases.bases).filter(([, b]) => b.ativo);
  if (!ligadas.length) return [];
  const fatais = ligadas.flatMap(([nome, b]) => problemasDaBase(nome, b, cfgBases));
  if (!['arquivos', 'argus'].includes(cfgBases.modo)) fatais.push(`BASES_MODO inválido: "${cfgBases.modo}" (use arquivos ou argus).`);
  const v = cfgBases.vanguard;
  if (!v.usuario || !v.senha) fatais.push('Bases ligadas exigem VANGUARD_USUARIO e VANGUARD_SENHA (login do robô).');
  return fatais;
}

module.exports = { carregarBases, validarBases, problemasDaBase };

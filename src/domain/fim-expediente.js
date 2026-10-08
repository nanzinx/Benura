'use strict';
/**
 * Fim de expediente limpo — regras puras.
 *
 * Depois do HORARIO_FIM (+ margem), quem continua logado na Argus provavelmente
 * esqueceu de deslogar: ligações podem cair para ninguém e o relatório de
 * entrada/saída fica errado. Quem está EM ATENDIMENTO não é deslogado (derrubaria
 * a ligação do cliente): só aparece no relatório.
 */

const { Classe } = require('./rodizio');

/** Situação de cada operador ainda logado. */
const Situacao = Object.freeze({
  DESLOGAR: 'DESLOGAR', // logado e fora de atendimento
  EM_ATENDIMENTO: 'EM_ATENDIMENTO', // logado e falando com cliente: não mexer
});

/** "18:00" + 10 min → "18:10" (limitado a 23:59). */
function horarioComMargem(hora, margemMin) {
  const [h, m] = hora.split(':').map(Number);
  const total = Math.min(h * 60 + m + margemMin, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** A rotina roda uma vez por dia, a partir do horário-alvo. */
const deveExecutar = ({ hora, data, horarioAlvo, ultimaExecucao }) => hora >= horarioAlvo && ultimaExecucao !== data;

/**
 * Operadores humanos que devem ser verificados: ativos, com ramal, fora da
 * lista de exceção (plantão) e que não sejam robôs.
 * @param {Array<{ ramal, nome, ativo, tipo }>} usuarios - modelo do DiretorioOperadores
 */
function operadoresParaVerificar(usuarios, { ignorarRamais = [], ramaisRobos = [] }) {
  const fora = new Set([...ignorarRamais, ...ramaisRobos].map(String));
  return usuarios.filter((u) => u.tipo === 2 && u.ativo && u.ramal && !fora.has(String(u.ramal)));
}

/**
 * Quem ficou logado e o que fazer com cada um.
 * @param {Array<{ ramal, nome, classe }>} verificados - classe de domain/rodizio
 * @returns {Array<{ ramal, nome, classe, situacao }>}
 */
function quemFicouLogado(verificados) {
  return verificados
    .filter((v) => v.classe !== Classe.OFFLINE && v.classe !== Classe.ERRO)
    .map((v) => ({ ...v, situacao: v.classe === Classe.ATENDIMENTO ? Situacao.EM_ATENDIMENTO : Situacao.DESLOGAR }));
}

module.exports = { Situacao, horarioComMargem, deveExecutar, operadoresParaVerificar, quemFicouLogado };

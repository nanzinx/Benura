'use strict';
/**
 * [NOVO] Contas operacionais de supervisores: o supervisor tem um usuário administrativo e,
 * às vezes, um ramal de operador para atender (ex.: "Ariel Souza da Conceicao", cujo
 * supervisor na Argus é a própria "Ariel Conceicao"). Essas contas não ficam na URA:
 * o rodízio não as sobe e devolve ao Ativo quem estiver lá (fora de ligação). Só a
 * supervisão, à mão pelo painel, põe uma delas na URA.
 *
 * Quem é: automático pelo nome (primeiro e último nome iguais aos de um supervisor da
 * Argus), mais CONTAS_SUPERVISORES_RAMAIS, menos CONTAS_SUPERVISORES_EXCETO.
 */

const { normalizarNome } = require('../utils/texto');

const LIGACOES = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E']);
const partes = (nome) => normalizarNome(nome).split(/[^A-Z0-9]+/).filter((p) => p && !LIGACOES.has(p));

/** O operador e o supervisor são a mesma pessoa? (a Argus costuma abreviar o nome do supervisor) */
function mesmaPessoa(nomeOperador, nomeSupervisor) {
  const o = partes(nomeOperador);
  const s = partes(nomeSupervisor);
  if (o.length < 2 || s.length < 2) return false;
  return o[0] === s[0] && o.at(-1) === s.at(-1) && s.every((p) => o.includes(p));
}

class ContasDeSupervisores {
  /**
   * @param {object} deps
   * @param {{ contaDeSupervisor(ramal: string): object|null }} [deps.diretorio]
   * @param {{ automatico?: boolean, ramais?: string[], exceto?: string[] }} deps.cfg
   */
  constructor({ diretorio = null, cfg = {}, logger }) {
    this.diretorio = diretorio;
    this.automatico = cfg.automatico !== false;
    this.ramais = new Set((cfg.ramais || []).map(String));
    this.exceto = new Set((cfg.exceto || []).map(String));
    this.log = logger;
  }

  /** O ramal é a conta operacional de um supervisor? Diretório fora do ar: não trava ninguém. */
  eh(ramal) {
    const r = String(ramal);
    if (this.exceto.has(r)) return false;
    if (this.ramais.has(r)) return true;
    if (!this.automatico || !this.diretorio) return false;
    try {
      return Boolean(this.diretorio.contaDeSupervisor(r));
    } catch {
      return false;
    }
  }

  /** Para o /health: as contas achadas agora. */
  lista() {
    let achadas = [];
    try {
      if (this.automatico && this.diretorio) achadas = this.diretorio.contasDeSupervisores();
    } catch { /* diretório ainda não carregou */ }
    const ramais = new Set([...achadas.map((c) => c.ramal), ...this.ramais]);
    return [...ramais].filter((r) => !this.exceto.has(r)).sort();
  }
}

module.exports = { mesmaPessoa, ContasDeSupervisores };

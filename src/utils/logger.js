'use strict';
/**
 * Logger simples com timestamp ISO, níveis e escopo (módulo de origem).
 * Mantido sem dependências para facilitar o deploy.
 */

/**
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.debug]
 * @param {string} [opcoes.escopo]
 * @param {boolean} [opcoes.tudoNoStderr] - Envia todos os níveis para o stderr,
 *        deixando o stdout livre para a saída de ferramentas de linha de comando.
 */
function criarLogger({ debug = false, escopo = '', tudoNoStderr = false } = {}) {
  const prefixo = escopo ? `[${escopo}]` : '';
  const ts = () => new Date().toISOString();
  const out = tudoNoStderr ? console.error : console.log;

  return {
    info: (...a) => out(ts(), '[INFO]', prefixo, ...a),
    aviso: (...a) => console.warn(ts(), '[AVISO]', prefixo, ...a),
    erro: (...a) => console.error(ts(), '[ERRO]', prefixo, ...a),
    debug: (...a) => { if (debug) out(ts(), '[DEBUG]', prefixo, ...a); },
    /** Cria um logger filho com outro escopo, herdando as opções. */
    filho: (novoEscopo) => criarLogger({ debug, escopo: novoEscopo, tudoNoStderr }),
  };
}

/** Logger silencioso, útil em testes. */
const loggerNulo = {
  info() {}, aviso() {}, erro() {}, debug() {},
  filho() { return loggerNulo; },
};

module.exports = { criarLogger, loggerNulo };

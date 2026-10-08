'use strict';
/**
 * Logger simples com timestamp ISO, níveis e escopo (módulo de origem).
 * Mantido sem dependências para facilitar o deploy.
 */

function criarLogger({ debug = false, escopo = '' } = {}) {
  const prefixo = escopo ? `[${escopo}]` : '';
  const ts = () => new Date().toISOString();

  return {
    info: (...a) => console.log(ts(), '[INFO]', prefixo, ...a),
    aviso: (...a) => console.warn(ts(), '[AVISO]', prefixo, ...a),
    erro: (...a) => console.error(ts(), '[ERRO]', prefixo, ...a),
    debug: (...a) => { if (debug) console.log(ts(), '[DEBUG]', prefixo, ...a); },
    /** Cria um logger filho com outro escopo, herdando o nível de debug. */
    filho: (novoEscopo) => criarLogger({ debug, escopo: novoEscopo }),
  };
}

/** Logger silencioso, útil em testes. */
const loggerNulo = {
  info() {}, aviso() {}, erro() {}, debug() {},
  filho() { return loggerNulo; },
};

module.exports = { criarLogger, loggerNulo };

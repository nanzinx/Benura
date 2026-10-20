'use strict';
/**
 * Segredo local (HMAC dos perfis, assinatura das sessões do painel...): o valor
 * informado no .env ou um arquivo criado na primeira vez, só no PC do BenURA.
 * Nunca vai para o git.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** @returns {string} */
function obterSegredo({ segredo, arquivoSegredo }) {
  if (segredo) return segredo;
  try {
    return fs.readFileSync(arquivoSegredo, 'utf8').trim();
  } catch {
    const novo = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(arquivoSegredo), { recursive: true });
    fs.writeFileSync(arquivoSegredo, `${novo}\n`, { mode: 0o600 });
    return novo;
  }
}

module.exports = { obterSegredo };

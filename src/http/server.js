'use strict';
/**
 * Servidor HTTP (módulo nativo `http`) com tabela de rotas, leitura de corpo
 * com limite de tamanho, autenticação por token e tratamento de erros.
 */

const http = require('http');
const crypto = require('crypto');

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

/** Comparação de token em tempo constante. */
function tokenValido(recebido, esperado) {
  if (!recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extrairToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return req.headers['x-webhook-token'] || null;
}

function lerCorpoJson(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', (chunk) => {
      tamanho += chunk.length;
      if (tamanho > limiteBytes) {
        reject(new ErroHttp(413, 'Corpo da requisição muito grande'));
        req.destroy();
        return;
      }
      partes.push(chunk);
    });
    req.on('end', () => {
      const texto = Buffer.concat(partes).toString('utf8');
      if (!texto) return resolve(null);
      try { resolve(JSON.parse(texto)); } catch { reject(new ErroHttp(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./controllers').criarControllers>} deps.controllers
 * @param {{ tokenAdmin: string, limiteCorpoBytes: number }} deps.cfg
 * @param {object} deps.logger
 * @returns {http.Server}
 */
function criarServidor({ controllers, cfg, logger }) {
  // [método, caminho, handler, protegida?]
  const rotas = [
    ['GET', '/health', controllers.health, false],
    ['GET', '/status', controllers.status, false],
    ['POST', '/recarregar', controllers.recarregar, true],
    ['POST', '/webhook/venda', controllers.webhookVenda, true],
  ];

  return http.createServer(async (req, res) => {
    const responder = (status, corpo) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(corpo, null, 2));
    };

    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const rota = rotas.find(([m, p]) => m === req.method && p === pathname);
      if (!rota) throw new ErroHttp(404, 'Rota não encontrada');

      const [, , handler, protegida] = rota;
      if (protegida && cfg.tokenAdmin && !tokenValido(extrairToken(req), cfg.tokenAdmin)) {
        throw new ErroHttp(401, 'Token inválido ou ausente');
      }

      const corpo = req.method === 'POST' ? await lerCorpoJson(req, cfg.limiteCorpoBytes) : null;
      const { status, corpo: resposta } = await handler({ req, corpo });
      responder(status, resposta);
    } catch (e) {
      if (e instanceof ErroHttp) return responder(e.status, { erro: e.message });
      logger.erro(`Erro não tratado em ${req.method} ${req.url}:`, e);
      responder(500, { erro: 'Erro interno' });
    }
  });
}

module.exports = { criarServidor, ErroHttp };

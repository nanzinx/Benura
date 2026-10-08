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

async function lerCorpoJson(req, limiteBytes) {
  const partes = [];
  let tamanho = 0;
  for await (const chunk of req) {
    tamanho += chunk.length;
    if (tamanho > limiteBytes) {
      req.destroy();
      throw new ErroHttp(413, 'Corpo da requisição muito grande');
    }
    partes.push(chunk);
  }

  const texto = Buffer.concat(partes).toString('utf8');
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    throw new ErroHttp(400, 'JSON inválido');
  }
}

function responder(res, status, corpo) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo, null, 2));
}

function encontrarRota(rotas, req) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const rota = rotas.find((r) => r.metodo === req.method && r.caminho === pathname);
  if (!rota) throw new ErroHttp(404, 'Rota não encontrada');
  return rota;
}

function autorizar(rota, req, tokenAdmin) {
  if (!rota.protegida || !tokenAdmin) return;
  if (!tokenValido(extrairToken(req), tokenAdmin)) throw new ErroHttp(401, 'Token inválido ou ausente');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./controllers').criarControllers>} deps.controllers
 * @param {{ tokenAdmin: string, limiteCorpoBytes: number }} deps.cfg
 * @param {object} deps.logger
 * @returns {http.Server}
 */
function criarServidor({ controllers, cfg, logger }) {
  const rotas = [
    { metodo: 'GET', caminho: '/health', handler: controllers.health },
    { metodo: 'GET', caminho: '/status', handler: controllers.status },
    { metodo: 'POST', caminho: '/recarregar', handler: controllers.recarregar, protegida: true },
    { metodo: 'POST', caminho: '/webhook/venda', handler: controllers.webhookVenda, protegida: true },
  ];

  /** Roteia, autoriza, lê o corpo e chama o controlador. Lança ErroHttp. */
  async function atender(req) {
    const rota = encontrarRota(rotas, req);
    autorizar(rota, req, cfg.tokenAdmin);
    const corpo = req.method === 'POST' ? await lerCorpoJson(req, cfg.limiteCorpoBytes) : null;
    return rota.handler({ req, corpo });
  }

  function responderErro(req, res, e) {
    if (e instanceof ErroHttp) return responder(res, e.status, { erro: e.message });
    logger.erro(`Erro não tratado em ${req.method} ${req.url}:`, e);
    return responder(res, 500, { erro: 'Erro interno' });
  }

  return http.createServer(async (req, res) => {
    try {
      const { status, corpo } = await atender(req);
      responder(res, status, corpo);
    } catch (e) {
      responderErro(req, res, e);
    }
  });
}

module.exports = { criarServidor, ErroHttp };

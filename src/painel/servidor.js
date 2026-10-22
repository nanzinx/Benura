'use strict';
/**
 * Servidor HTTP do painel (módulo nativo `http`).
 *
 *   GET  /                  a página (publico/, o build do painel-web/: React + TypeScript + Tailwind)
 *   GET  /health            para o PM2/atualizador (sem dados)
 *   POST /api/entrar        { senha } → cookie de sessão
 *   POST /api/sair
 *   GET  /api/sessao        200 com sessão, 401 sem
 *   GET  /api/visao         saúde dos serviços + rodízio + alertas (a cada 5 s)
 *   GET  /api/dia           linha do tempo, callbacks e avisos do dia (logs)
 *   POST /api/automacao/desligar | religar   botão "Desligar automação" (automacao.js)
 *   POST /api/simulacao     { ligada } — botão "Modo simulação" (DRY_RUN)
 *   *    /api/rodizio/...   comandos da lista ACOES (servicos.js), levados com o token
 *   *    /api/roteador/...
 *
 * Tudo em /api, menos entrar, exige sessão. Escrita exige também o cabeçalho
 * X-Painel: 1 e a mesma origem (um site de fora não consegue mandar).
 *
 * Com a página no Cloudflare Pages, a Function functions/api repassa o /api para
 * cá pelo túnel, com o segredo PAINEL_PROXY_SEGREDO: pelo túnel, sem ele, nada passa.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACOES } = require('./servicos');
const { tokenRecusadoRecentemente, segundosDoDia } = require('../domain/painel');

/** A página (build do painel-web/, já no git): servida pelo nome exato, sem varrer pastas. */
const PUBLICO = path.join(__dirname, 'publico');
const TIPOS = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
});
const SEGURANCA = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
});
const LIMITE_PADRAO_BYTES = 64 * 1024;
/** O ciclo da URA roda a cada poucos segundos: sem ciclo há mais que isso, a Argus não está respondendo. */
const CICLO_PARADO_MS = 90_000;

class ErroPainel extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

const LOCAL = /^(127\.|::1$|::ffff:127\.)/;

/** Chegou pelo túnel da Cloudflare? (o cloudflared roda neste PC: pedido do localhost com CF-Connecting-IP) */
const viaTunel = (req) => Boolean(req.headers['cf-connecting-ip']) && LOCAL.test(String(req.socket.remoteAddress || ''));

/** Comparação em tempo constante (o segredo do proxy não vaza pelo tempo de resposta). */
function iguais(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** Veio pela Function do Cloudflare Pages (functions/api), com o segredo combinado? */
const pelaFunction = (req, segredo) => Boolean(segredo) && viaTunel(req) && iguais(req.headers['x-benura-proxy'] ?? '', segredo);

/**
 * Endereço de quem pediu. Pela Function do Pages, vale o X-Benura-Cliente-IP que ela
 * repassa (o CF-Connecting-IP seria o da própria Cloudflare); pelo túnel direto, o
 * CF-Connecting-IP; de outro PC da rede, os cabeçalhos são ignorados (senão daria
 * para fugir do bloqueio de senha errada).
 */
function enderecoDoPedido(req, segredoProxy) {
  const direto = String(req.socket.remoteAddress || '?');
  if (pelaFunction(req, segredoProxy) && req.headers['x-benura-cliente-ip']) return String(req.headers['x-benura-cliente-ip']);
  return viaTunel(req) ? String(req.headers['cf-connecting-ip']) : direto;
}
/** Chegou por HTTPS (túnel da Cloudflare)? Então o cookie vai com Secure. */
const viaHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /https/.test(String(req.headers['cf-visitor'] || ''));

async function lerCorpo(req, limiteBytes) {
  const partes = [];
  let tamanho = 0;
  for await (const pedaco of req) {
    tamanho += pedaco.length;
    if (tamanho > limiteBytes) {
      req.destroy();
      throw new ErroPainel(413, 'Conteúdo grande demais');
    }
    partes.push(pedaco);
  }
  return Buffer.concat(partes).toString('utf8');
}

/**
 * Pedido de escrita vindo da própria página (não de outro site). Pelo Cloudflare Pages
 * a página é de outro endereço (PAINEL_ORIGENS_PERMITIDAS) que o deste servidor.
 */
function conferirOrigemDoPedido(req, origensPermitidas = []) {
  if (req.headers['x-painel'] !== '1') throw new ErroPainel(403, 'Pedido sem o cabeçalho do painel');
  const origem = req.headers.origin;
  if (!origem) return;
  if (origensPermitidas.includes(origem)) return;
  let host = null;
  try {
    host = new URL(origem).host;
  } catch { /* "null" ou lixo: não é a página */ }
  if (host !== req.headers.host) throw new ErroPainel(403, 'Origem não permitida');
}

/**
 * @param {object} deps
 * @param {import('./sessoes').Sessoes} deps.sessoes
 * @param {import('./servicos').Servicos} deps.servicos
 * @param {import('./dados-do-dia').DadosDoDia} deps.dados
 * @param {import('./automacao').ControleAutomacao} deps.automacao
 * @param {{ fuso: string, origensPermitidas?: string[], proxySegredo?: string }} deps.cfg
 *        origensPermitidas: endereço da página no Cloudflare Pages; proxySegredo: o da Function
 * @param {object} deps.logger
 * @returns {http.Server}
 */
function criarServidorDoPainel({ sessoes, servicos, dados, automacao, cfg, logger }) {
  const estaticos = Object.fromEntries(fs.readdirSync(PUBLICO).filter((nome) => TIPOS[path.extname(nome)]).map((nome) => [
    nome === 'index.html' ? '/' : `/${nome}`, { tipo: TIPOS[path.extname(nome)], conteudo: fs.readFileSync(path.join(PUBLICO, nome)) },
  ]));
  const segredoProxy = cfg.proxySegredo || '';
  const enderecoDe = (req) => enderecoDoPedido(req, segredoProxy);
  const conferirOrigem = (req) => conferirOrigemDoPedido(req, cfg.origensPermitidas ?? []);

  async function entrar(req) {
    conferirOrigem(req);
    let senha = '';
    try {
      senha = JSON.parse(await lerCorpo(req, 4096) || '{}').senha;
    } catch {
      throw new ErroPainel(400, 'JSON inválido');
    }
    if (!sessoes.configurada) throw new ErroPainel(503, 'A senha do painel ainda não foi configurada: coloque PAINEL_SENHA no .env do BenURA e reinicie o benura-painel.');
    const endereco = enderecoDe(req);
    const r = sessoes.entrar(typeof senha === 'string' ? senha : '', endereco, { seguro: viaHttps(req) });
    if (!r.ok) {
      logger.aviso(`Painel: senha errada (${endereco})${r.bloqueado ? ' — bloqueado por 10 min' : ''}.`);
      throw new ErroPainel(r.bloqueado ? 429 : 401, r.bloqueado ? 'Muitas tentativas. Espere 10 minutos.' : 'Senha incorreta');
    }
    logger.info(`Painel: entrada da supervisão (${endereco}).`);
    return { status: 200, corpo: { ok: true }, cookie: r.cookie };
  }

  async function visao() {
    const [saude, alertas] = await Promise.all([servicos.saude(), servicos.chamar('rodizio', '/alertas')]);
    const { avisos } = dados.atualizar();
    const rodizio = saude.rodizio.dados;
    const agora = new Date();
    const cicloMs = rodizio?.lastLoopUra ? agora - new Date(rodizio.lastLoopUra) : null;
    const horaLocal = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.fuso, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(agora);
    const argus = {
      tokenRecusado: tokenRecusadoRecentemente(avisos, segundosDoDia(horaLocal)),
      cicloUraHaSeg: cicloMs == null ? null : Math.round(cicloMs / 1000),
      respondendo: saude.rodizio.online && cicloMs != null && cicloMs < CICLO_PARADO_MS,
    };
    return {
      status: 200,
      corpo: { agora: agora.toISOString(), servicos: saude, argus, alertas: alertas.status === 200 ? alertas.corpo : null, automacao: automacao.estado() },
    };
  }

  async function encaminhar(req, acao) {
    if (acao.metodo !== 'GET') conferirOrigem(req);
    const corpo = acao.metodo === 'POST' ? await lerCorpo(req, acao.limiteBytes ?? LIMITE_PADRAO_BYTES) : undefined;
    const r = await servicos.chamar(acao.servico, acao.destino, { metodo: acao.metodo, corpo: corpo || undefined });
    if (acao.nome) {
      const resultado = r.status >= 200 && r.status < 300 ? 'ok' : `falhou: ${r.corpo?.erro ?? `HTTP ${r.status}`}`;
      logger.aviso(`Painel: supervisão pediu para ${acao.nome} (${enderecoDe(req)}) — ${resultado}.`);
    }
    if (r.status === 0) return { status: 502, corpo: r.corpo };
    return { status: r.status, corpo: r.corpo };
  }

  async function atender(req) {
    const { pathname } = new URL(req.url, 'http://localhost');
    // Com a página no Pages, pelo túnel só entra a Function (segunda trava, além do Cloudflare Access).
    if (segredoProxy && viaTunel(req) && !pelaFunction(req, segredoProxy)) throw new ErroPainel(403, 'Acesso só pelo painel');
    const estatico = req.method === 'GET' && estaticos[pathname];
    if (estatico) return { status: 200, bruto: estatico };
    if (req.method === 'GET' && pathname === '/health') return { status: 200, corpo: { status: 'ok', uptime: Math.round(process.uptime()), senhaConfigurada: sessoes.configurada } };
    if (req.method === 'POST' && pathname === '/api/entrar') return entrar(req);
    if (!pathname.startsWith('/api/')) throw new ErroPainel(404, 'Página não encontrada');

    if (!sessoes.validar(req)) throw new ErroPainel(401, 'Entre com a senha da supervisão');
    if (req.method === 'POST' && pathname === '/api/sair') {
      conferirOrigem(req);
      return { status: 200, corpo: { ok: true }, cookie: sessoes.sair(req, { seguro: viaHttps(req) }) };
    }
    if (req.method === 'GET' && pathname === '/api/sessao') return { status: 200, corpo: { ok: true } };
    if (req.method === 'GET' && pathname === '/api/visao') return visao();
    if (req.method === 'GET' && pathname === '/api/dia') return { status: 200, corpo: dados.resumo() };
    if (req.method === 'POST' && pathname === '/api/simulacao') {
      conferirOrigem(req);
      let ligada;
      try {
        ligada = JSON.parse(await lerCorpo(req, 1024) || '{}').ligada;
      } catch {
        throw new ErroPainel(400, 'JSON inválido');
      }
      if (typeof ligada !== 'boolean') throw new ErroPainel(400, 'Envie { "ligada": true | false }');
      const r = automacao.definirSimulacao(ligada, enderecoDe(req));
      if (!r.iniciado) throw new ErroPainel(409, r.motivo);
      return { status: 202, corpo: automacao.estado() };
    }
    if (req.method === 'POST' && (pathname === '/api/automacao/desligar' || pathname === '/api/automacao/religar')) {
      conferirOrigem(req);
      const desligar = pathname.endsWith('/desligar');
      const r = desligar ? automacao.desligar(enderecoDe(req)) : automacao.religar(enderecoDe(req));
      if (!r.iniciado) throw new ErroPainel(409, r.motivo);
      return { status: 202, corpo: automacao.estado() };
    }
    const acao = ACOES.find((a) => a.metodo === req.method && a.caminho === pathname);
    if (!acao) throw new ErroPainel(404, 'Comando não encontrado');
    return encaminhar(req, acao);
  }

  function responder(res, { status, corpo, bruto, cookie }) {
    const headers = { ...SEGURANCA, ...(cookie ? { 'Set-Cookie': cookie } : {}) };
    if (bruto) {
      res.writeHead(status, { ...headers, 'Content-Type': bruto.tipo });
      return res.end(bruto.conteudo);
    }
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(corpo ?? null));
  }

  return http.createServer(async (req, res) => {
    try {
      responder(res, await atender(req));
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof ErroPainel) return responder(res, { status: e.status, corpo: { erro: e.message } });
      logger.erro(`Painel: erro em ${req.method} ${req.url}:`, e);
      return responder(res, { status: 500, corpo: { erro: 'Erro interno do painel' } });
    }
  });
}

module.exports = { criarServidorDoPainel };

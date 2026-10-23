'use strict';
/**
 * Servidor HTTP do painel (módulo nativo `http`).
 *
 *   GET  /                  a página (publico/, o build do painel-web/: React + TypeScript + Tailwind)
 *   GET  /health            para o PM2/atualizador (sem dados)
 *   GET  /api/entrada       [NOVO] { emergencia, configurada }: a tela de entrada pede e-mail ou só a senha
 *   POST /api/entrar        { email, senha } → cookie de sessão ({ senha }: emergência, sem usuários)
 *   POST /api/sair
 *   GET  /api/sessao        200 com { usuario: { nome, email, papel } }, 401 sem
 *   POST /api/minha-senha   [NOVO] { atual, nova }
 *   *    /api/usuarios      [NOVO] só administrador: listar, criar, mudar (papel, ativo), redefinir senha
 *   GET  /api/visao         saúde dos serviços + rodízio + alertas (a cada 5 s)
 *   GET  /api/dia           linha do tempo, callbacks e avisos do dia (logs)
 *   POST /api/automacao/desligar | religar   botão "Desligar automação" (automacao.js)
 *   POST /api/simulacao     { ligada } — botão "Modo simulação" (DRY_RUN)
 *   *    /api/rodizio/...   comandos da lista ACOES (servicos.js), levados com o token
 *   PUT  /api/ura/status                      [NOVO] status da URA (manual/automático)
 *   GET  /api/metricas/hoje                   [NOVO] leads derivados e transbordos do dia
 *   POST /api/operadores/transferir-ura-ativo [NOVO] "Alocar Todos no Ativo"
 *   *    /api/roteador/...
 *
 * Tudo em /api, menos entrar, exige sessão. Escrita exige também o cabeçalho
 * X-Painel: 1 e a mesma origem (um site de fora não consegue mandar).
 *
 * [NOVO] Papéis (usuarios.js): visualização só lê; supervisor opera o dia (os
 * comandos da lista ACOES); administrador também desliga a automação, liga o
 * modo simulação e cuida dos usuários. Acima do papel: 403.
 *
 * Com a página no Cloudflare Pages, a Function functions/api repassa o /api para
 * cá pelo túnel, com o segredo PAINEL_PROXY_SEGREDO: pelo túnel, sem ele, nada passa.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ACOES } = require('./servicos');
const { ErroUsuarios, NOMES_PAPEIS, podeFazer } = require('./usuarios');
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

/** Cabeçalhos que só um proxy põe: o cloudflared (CF-Connecting-IP) e o Tailscale Funnel (X-Forwarded-*). */
const CABECALHOS_DE_PROXY = ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-proto', 'tailscale-funnel-request'];

/**
 * Chegou por um túnel? (o cloudflared ou o Tailscale rodam neste PC: pedido do localhost
 * com cabeçalho de proxy). O navegador do próprio servidor não manda nenhum deles.
 */
const viaTunel = (req) => LOCAL.test(String(req.socket.remoteAddress || '')) && CABECALHOS_DE_PROXY.some((h) => req.headers[h]);

/** Comparação em tempo constante (o segredo do proxy não vaza pelo tempo de resposta). */
function iguais(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * Veio pela Function do Cloudflare Pages (functions/api), com o segredo combinado?
 * Ela sempre chega por um túnel que roda neste PC, então pelo localhost.
 */
const pelaFunction = (req, segredo) => Boolean(segredo) && LOCAL.test(String(req.socket.remoteAddress || ''))
  && iguais(req.headers['x-benura-proxy'] ?? '', segredo);

/**
 * Endereço de quem pediu (o bloqueio de senha errada conta por ele). Pela Function do
 * Pages, vale o X-Benura-Cliente-IP que ela repassa (o do túnel seria o da própria
 * Cloudflare); pelo túnel direto, o CF-Connecting-IP ou o X-Forwarded-For; de outro
 * PC da rede, os cabeçalhos são ignorados (senão daria para fugir do bloqueio).
 */
function enderecoDoPedido(req, segredoProxy) {
  const direto = String(req.socket.remoteAddress || '?');
  if (pelaFunction(req, segredoProxy) && req.headers['x-benura-cliente-ip']) return String(req.headers['x-benura-cliente-ip']);
  if (!viaTunel(req)) return direto;
  const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(req.headers['cf-connecting-ip'] || encaminhado || direto);
}

/**
 * Quem pediu, para o log e o "por" dos serviços: [NOVO] quem entrou no painel e o IP
 * (ex.: "Ana <ana@empresa.com> (200.1.2.3)"). Pela Function, o e-mail do Cloudflare
 * Access também, se for outro. Sem usuário (emergência), o e-mail do Access e o IP,
 * ou só o IP.
 */
function quemPediuDoPedido(req, segredoProxy, usuario = null) {
  const endereco = enderecoDoPedido(req, segredoProxy);
  const acesso = pelaFunction(req, segredoProxy) ? String(req.headers['x-benura-cliente-email'] || '').trim() : '';
  if (usuario && !usuario.emergencia) {
    const outro = acesso && acesso.toLowerCase() !== usuario.email ? ` [Access: ${acesso}]` : '';
    return `${usuario.nome} <${usuario.email}>${outro} (${endereco})`;
  }
  return acesso ? `${acesso} (${endereco})` : endereco;
}

/** Chegou por HTTPS (túnel ou a página no Pages, que é sempre https)? Então o cookie vai com Secure. */
const viaHttps = (req, segredoProxy) => pelaFunction(req, segredoProxy)
  || req.headers['x-forwarded-proto'] === 'https' || /https/.test(String(req.headers['cf-visitor'] || ''));

/** Corpo JSON (objeto) ou erro 400. */
function lerJson(texto) {
  if (!texto) return {};
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    throw new ErroPainel(400, 'JSON inválido');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ErroPainel(400, 'Envie um objeto JSON');
  return json;
}

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
  const quemPediu = (req, usuario) => quemPediuDoPedido(req, segredoProxy, usuario);
  const { usuarios } = sessoes;

  /** [NOVO] O papel de quem pediu alcança o mínimo? Senão, 403. */
  function exigir(sessao, minimo) {
    if (podeFazer(sessao.usuario.papel, minimo)) return;
    throw new ErroPainel(403, `Seu acesso (${NOMES_PAPEIS[sessao.usuario.papel]}) não permite isso: precisa ser ${NOMES_PAPEIS[minimo]}.`);
  }

  async function lerObjeto(req, limiteBytes = 4096) {
    return lerJson(await lerCorpo(req, limiteBytes));
  }
  const seguro = (req) => viaHttps(req, segredoProxy);
  const conferirOrigem = (req) => conferirOrigemDoPedido(req, cfg.origensPermitidas ?? []);

  async function entrar(req) {
    conferirOrigem(req);
    const { email, senha } = await lerObjeto(req);
    if (!sessoes.configurada) {
      throw new ErroPainel(503, 'Nenhum usuário criado ainda: no servidor do BenURA, rode "npm run usuarios -- criar" (ou coloque PAINEL_SENHA no .env e reinicie o benura-painel para entrar e criar pelo painel).');
    }
    const comEmail = typeof email === 'string' && email.trim() !== '';
    if (!comEmail && !sessoes.emergencia) throw new ErroPainel(400, 'Informe o e-mail');
    const r = await sessoes.entrar({ email: comEmail ? email : undefined, senha: typeof senha === 'string' ? senha : '' }, enderecoDe(req), { seguro: seguro(req) });
    if (!r.ok) {
      const quem = comEmail && /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email.trim()) ? ` para ${email.trim().toLowerCase()}` : '';
      logger.aviso(`Painel: senha errada${quem} (${quemPediu(req)})${r.bloqueado ? ' — bloqueado por 10 min' : ''}.`);
      throw new ErroPainel(r.bloqueado ? 429 : 401, r.bloqueado ? 'Muitas tentativas. Espere 10 minutos.' : comEmail ? 'E-mail ou senha incorretos' : 'Senha incorreta');
    }
    logger.info(r.usuario.emergencia
      ? `Painel: entrada com a senha do painel, sem usuários criados (${quemPediu(req)}).`
      : `Painel: entrada de ${quemPediu(req, r.usuario)} — ${NOMES_PAPEIS[r.usuario.papel]}.`);
    return { status: 200, corpo: { ok: true }, cookie: r.cookie };
  }

  /** O que a página precisa saber de quem entrou (nunca o hash, a versão ou o id da sessão). */
  const quemEntrou = ({ usuario }) => ({
    usuario: { nome: usuario.nome, email: usuario.email, papel: usuario.papel, senhaProvisoria: Boolean(usuario.senhaProvisoria) },
    emergencia: Boolean(usuario.emergencia),
  });

  /** [NOVO] Rotas de usuários: só administrador. */
  async function rotaDeUsuarios(req, pathname, sessao) {
    exigir(sessao, 'administrador');
    const por = quemPediu(req, sessao.usuario);
    if (req.method === 'GET' && pathname === '/api/usuarios') return { status: 200, corpo: { usuarios: usuarios.listar() } };
    conferirOrigem(req);
    const corpo = await lerObjeto(req);
    if (req.method === 'POST' && pathname === '/api/usuarios') {
      const { email, nome, papel, senha } = corpo;
      const r = await usuarios.criar({ email, nome, papel, senha: senha || undefined }, por);
      return { status: 201, corpo: { usuario: r.usuario, senhaProvisoria: r.senha } };
    }
    if (req.method === 'PUT' && pathname === '/api/usuarios') {
      const { id, nome, papel, ativo } = corpo;
      if (id === sessao.usuario.id && (ativo === false || (papel && papel !== sessao.usuario.papel))) {
        throw new ErroPainel(409, 'Você não pode desativar nem mudar o próprio papel: peça a outro administrador.');
      }
      return { status: 200, corpo: { usuario: usuarios.atualizar(String(id ?? ''), { nome, papel, ativo }, por) } };
    }
    if (req.method === 'POST' && pathname === '/api/usuarios/senha') {
      const id = String(corpo.id ?? '');
      if (id === sessao.usuario.id) throw new ErroPainel(409, 'Para a sua senha, use "Trocar minha senha".');
      return { status: 200, corpo: { senhaProvisoria: await usuarios.definirSenha(id, null, por) } };
    }
    throw new ErroPainel(404, 'Comando não encontrado');
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

  async function encaminhar(req, acao, sessao) {
    exigir(sessao, acao.papel ?? (acao.metodo === 'GET' ? 'visualizacao' : 'supervisor'));
    if (acao.metodo !== 'GET') conferirOrigem(req);
    const quem = quemPediu(req, sessao.usuario);
    let corpo = ['POST', 'PUT'].includes(acao.metodo) ? await lerCorpo(req, acao.limiteBytes ?? LIMITE_PADRAO_BYTES) : undefined;
    if (acao.comQuem) corpo = JSON.stringify({ ...lerJson(corpo), por: quem });
    const r = await servicos.chamar(acao.servico, acao.destino, { metodo: acao.metodo, corpo: corpo || undefined, ...(acao.timeoutMs ? { timeoutMs: acao.timeoutMs } : {}) });
    if (acao.nome) {
      const resultado = r.status >= 200 && r.status < 300 ? 'ok' : `falhou: ${r.corpo?.erro ?? `HTTP ${r.status}`}`;
      logger.aviso(`Painel: supervisão pediu para ${acao.nome} (${quem}) — ${resultado}.`);
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
    if (req.method === 'GET' && pathname === '/api/entrada') return { status: 200, corpo: { emergencia: sessoes.emergencia, configurada: sessoes.configurada } };
    if (!pathname.startsWith('/api/')) throw new ErroPainel(404, 'Página não encontrada');

    const sessao = sessoes.validar(req);
    if (!sessao) throw new ErroPainel(401, 'Entre com seu e-mail e senha');
    if (req.method === 'POST' && pathname === '/api/sair') {
      conferirOrigem(req);
      return { status: 200, corpo: { ok: true }, cookie: sessoes.sair(req, { seguro: seguro(req) }) };
    }
    if (req.method === 'GET' && pathname === '/api/sessao') return { status: 200, corpo: { ok: true, ...quemEntrou(sessao) } };
    if (req.method === 'POST' && pathname === '/api/minha-senha') {
      conferirOrigem(req);
      if (sessao.usuario.emergencia) throw new ErroPainel(409, 'Com a senha do painel não há conta: crie seu usuário em Serviços → Usuários.');
      const { atual, nova } = await lerObjeto(req);
      await usuarios.trocarMinhaSenha(sessao.usuario.id, atual, nova);
      // A versão mudou: a sessão atual sai junto; entra de novo com a nova senha.
      const r = await sessoes.entrar({ email: sessao.usuario.email, senha: nova }, enderecoDe(req), { seguro: seguro(req) });
      return { status: 200, corpo: { ok: true }, ...(r.ok ? { cookie: r.cookie } : {}) };
    }
    if (pathname === '/api/usuarios' || pathname === '/api/usuarios/senha') return rotaDeUsuarios(req, pathname, sessao);
    if (req.method === 'GET' && pathname === '/api/visao') return visao();
    if (req.method === 'GET' && pathname === '/api/dia') return { status: 200, corpo: dados.resumo() };
    if (req.method === 'POST' && pathname === '/api/simulacao') {
      exigir(sessao, 'administrador');
      conferirOrigem(req);
      let ligada;
      try {
        ligada = JSON.parse(await lerCorpo(req, 1024) || '{}').ligada;
      } catch {
        throw new ErroPainel(400, 'JSON inválido');
      }
      if (typeof ligada !== 'boolean') throw new ErroPainel(400, 'Envie { "ligada": true | false }');
      const r = automacao.definirSimulacao(ligada, quemPediu(req, sessao.usuario));
      if (!r.iniciado) throw new ErroPainel(409, r.motivo);
      return { status: 202, corpo: automacao.estado() };
    }
    if (req.method === 'POST' && (pathname === '/api/automacao/desligar' || pathname === '/api/automacao/religar')) {
      exigir(sessao, 'administrador');
      conferirOrigem(req);
      const desligar = pathname.endsWith('/desligar');
      const quem = quemPediu(req, sessao.usuario);
      const r = desligar ? automacao.desligar(quem) : automacao.religar(quem);
      if (!r.iniciado) throw new ErroPainel(409, r.motivo);
      return { status: 202, corpo: automacao.estado() };
    }
    const acao = ACOES.find((a) => a.metodo === req.method && a.caminho === pathname);
    if (!acao) throw new ErroPainel(404, 'Comando não encontrado');
    return encaminhar(req, acao, sessao);
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
      if (e instanceof ErroPainel || e instanceof ErroUsuarios) return responder(res, { status: e.status, corpo: { erro: e.message } });
      logger.erro(`Painel: erro em ${req.method} ${req.url}:`, e);
      return responder(res, { status: 500, corpo: { erro: 'Erro interno do painel' } });
    }
  });
}

module.exports = { criarServidorDoPainel };

'use strict';
/**
 * Login do painel: [NOVO] e-mail e senha de cada pessoa (usuarios.js), com o
 * papel dela, e uma sessão num cookie assinado (HMAC com o segredo local),
 * HttpOnly e SameSite=Strict. Sair invalida a sessão; reiniciar o painel mantém
 * as sessões válidas até vencerem (PAINEL_SESSAO_HORAS). Trocar a senha, o papel
 * ou desativar alguém derruba as sessões dessa pessoa (a `versao` dela muda).
 *
 * Acesso de emergência: enquanto não houver nenhum usuário, a PAINEL_SENHA entra
 * (sem e-mail) como administrador, para criar o primeiro. Depois, não vale mais.
 *
 * Tentativas erradas: no máximo MAX_ERROS por endereço e por e-mail a cada
 * JANELA_ERROS_MS (com a Cloudflare na frente, o endereço é o CF-Connecting-IP).
 */

const crypto = require('crypto');

const COOKIE = 'benura_sessao';
const MAX_ERROS = 5;
const JANELA_ERROS_MS = 10 * 60_000;
/** Quem entrou com a PAINEL_SENHA (só enquanto não há usuários). */
const EMERGENCIA = Object.freeze({ id: 'emergencia', email: '', nome: 'Senha do painel', papel: 'administrador', emergencia: true });

const base64url = (b) => Buffer.from(b).toString('base64url');
const hmac = (segredo, texto) => crypto.createHmac('sha256', segredo).update(texto).digest('base64url');
const resumoDaSenha = (senha) => crypto.createHash('sha256').update(String(senha)).digest('hex').slice(0, 16);

/** Compara em tempo constante (hash dos dois lados: mesmo tamanho). */
function iguais(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Cookies do cabeçalho. @returns {Record<string, string>} */
function lerCookies(cabecalho = '') {
  return Object.fromEntries(String(cabecalho).split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v !== undefined)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

class Sessoes {
  /**
   * @param {object} deps
   * @param {string} deps.senha - PAINEL_SENHA (só emergência)
   * @param {string} deps.segredo
   * @param {number} deps.horas
   * @param {import('./usuarios').Usuarios} deps.usuarios
   * @param {() => number} [deps.agora]
   */
  constructor({ senha, segredo, horas, usuarios, agora = Date.now }) {
    Object.assign(this, { senha, chave: segredo, duracaoMs: horas * 3_600_000, usuarios, agora });
    this.encerradas = new Map(); // id → expira
    this.erros = new Map(); // endereço ou e-mail → [instantes]
  }

  /** A PAINEL_SENHA vale agora? (configurada e nenhum usuário criado) */
  get emergencia() {
    return String(this.senha || '').length >= 8 && this.usuarios.vazia;
  }

  /** Alguém consegue entrar? (há usuários, ou a senha de emergência) */
  get configurada() {
    return !this.usuarios.vazia || this.emergencia;
  }

  /**
   * @param {{ email?: string, senha?: string }} pedido - sem e-mail: a senha de emergência
   * @returns {Promise<{ ok: true, cookie: string, usuario: object } | { ok: false, bloqueado: boolean }>}
   */
  async entrar({ email, senha }, endereco, { seguro = false } = {}) {
    const agora = this.agora();
    const chaves = [`ip:${endereco}`, ...(email ? [`email:${String(email).trim().toLowerCase()}`] : [])];
    const recentes = chaves.map((c) => (this.erros.get(c) || []).filter((t) => agora - t < JANELA_ERROS_MS));
    if (recentes.some((r) => r.length >= MAX_ERROS)) return { ok: false, bloqueado: true };

    let usuario = null;
    if (email) usuario = await this.usuarios.autenticar(email, senha ?? '');
    else if (this.emergencia && iguais(senha ?? '', this.senha)) usuario = EMERGENCIA;
    if (!usuario) {
      chaves.forEach((c, i) => this.erros.set(c, [...recentes[i], agora]));
      return { ok: false, bloqueado: recentes.some((r) => r.length + 1 >= MAX_ERROS) };
    }
    chaves.forEach((c) => this.erros.delete(c));
    const dados = usuario.emergencia ? { u: EMERGENCIA.id, s: resumoDaSenha(this.senha) } : { u: usuario.id, v: usuario.versao };
    const corpo = base64url(JSON.stringify({ id: crypto.randomBytes(12).toString('hex'), ...dados, exp: agora + this.duracaoMs }));
    return { ok: true, usuario, cookie: this.cookie(`${corpo}.${hmac(this.chave, corpo)}`, this.duracaoMs / 1000, seguro) };
  }

  /** @returns {{ id: string, exp: number, usuario: object }|null} a sessão do pedido, se válida */
  validar(req) {
    const valor = lerCookies(req.headers.cookie)[COOKIE];
    const [corpo, assinatura] = String(valor || '').split('.');
    if (!corpo || !assinatura || !iguais(assinatura, hmac(this.chave, corpo))) return null;
    let sessao;
    try {
      sessao = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!(sessao.exp > this.agora()) || this.encerradas.has(sessao.id)) return null;
    if (sessao.u === EMERGENCIA.id) {
      // Trocar a PAINEL_SENHA ou criar o primeiro usuário derruba o acesso de emergência.
      return this.emergencia && sessao.s === resumoDaSenha(this.senha) ? { ...sessao, usuario: EMERGENCIA } : null;
    }
    const usuario = this.usuarios.buscar(sessao.u);
    if (!usuario || !usuario.ativo || usuario.versao !== sessao.v) return null;
    return { ...sessao, usuario };
  }

  /** @returns {string} cookie que apaga a sessão no navegador */
  sair(req, { seguro = false } = {}) {
    const sessao = this.validar(req);
    const agora = this.agora();
    for (const [id, exp] of this.encerradas) if (exp <= agora) this.encerradas.delete(id);
    if (sessao) this.encerradas.set(sessao.id, sessao.exp);
    return this.cookie('', 0, seguro);
  }

  cookie(valor, maxAgeSeg, seguro) {
    return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeSeg)}${seguro ? '; Secure' : ''}`;
  }
}

module.exports = { Sessoes, lerCookies, MAX_ERROS, EMERGENCIA };

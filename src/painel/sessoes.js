'use strict';
/**
 * Login do painel: uma senha da supervisão (PAINEL_SENHA) e uma sessão num
 * cookie assinado (HMAC com o segredo local), HttpOnly e SameSite=Strict.
 * Sair invalida a sessão; reiniciar o painel mantém as sessões válidas até
 * vencerem (PAINEL_SESSAO_HORAS). Trocar a senha ou o segredo derruba todas.
 *
 * Tentativas erradas: no máximo MAX_ERROS por endereço a cada JANELA_ERROS_MS
 * (com a Cloudflare na frente, o endereço é o CF-Connecting-IP).
 */

const crypto = require('crypto');

const COOKIE = 'benura_sessao';
const MAX_ERROS = 5;
const JANELA_ERROS_MS = 10 * 60_000;

const base64url = (b) => Buffer.from(b).toString('base64url');
const hmac = (segredo, texto) => crypto.createHmac('sha256', segredo).update(texto).digest('base64url');

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
   * @param {string} deps.senha
   * @param {string} deps.segredo
   * @param {number} deps.horas
   * @param {() => number} [deps.agora]
   */
  constructor({ senha, segredo, horas, agora = Date.now }) {
    // A senha entra na assinatura: trocá-la derruba as sessões abertas.
    Object.assign(this, { senha, chave: `${segredo}:${crypto.createHash('sha256').update(senha).digest('hex')}`, duracaoMs: horas * 3_600_000, agora });
    this.encerradas = new Map(); // id → expira
    this.erros = new Map(); // endereço → [instantes]
  }

  /** Sem PAINEL_SENHA (ou curta demais), ninguém entra. */
  get configurada() {
    return String(this.senha || '').length >= 8;
  }

  /** @returns {{ ok: true, cookie: string } | { ok: false, bloqueado: boolean }} */
  entrar(senha, endereco, { seguro = false } = {}) {
    const agora = this.agora();
    if (!this.configurada) return { ok: false, bloqueado: false };
    const recentes = (this.erros.get(endereco) || []).filter((t) => agora - t < JANELA_ERROS_MS);
    if (recentes.length >= MAX_ERROS) return { ok: false, bloqueado: true };
    if (!iguais(senha ?? '', this.senha)) {
      this.erros.set(endereco, [...recentes, agora]);
      return { ok: false, bloqueado: recentes.length + 1 >= MAX_ERROS };
    }
    this.erros.delete(endereco);
    const corpo = base64url(JSON.stringify({ id: crypto.randomBytes(12).toString('hex'), exp: agora + this.duracaoMs }));
    return { ok: true, cookie: this.cookie(`${corpo}.${hmac(this.chave, corpo)}`, this.duracaoMs / 1000, seguro) };
  }

  /** @returns {{ id: string, exp: number }|null} a sessão do pedido, se válida */
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
    return sessao;
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

module.exports = { Sessoes, lerCookies, MAX_ERROS };

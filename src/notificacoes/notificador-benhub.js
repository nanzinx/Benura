'use strict';
/**
 * Notificador do BenHub (chat interno da empresa): posta cada aviso num grupo.
 *
 *   POST {url}/api/internal-chat/{chatId}/messages
 *   Authorization: Bearer <token>
 *   { "content": "...", "content_type": "text", "reply_to_id": null }
 *
 * O token do BenHub vale ~24 h. O robô entra com um usuário próprio
 * (BENHUB_EMAIL/BENHUB_SENHA) e renova o token sozinho quando ele vence ou
 * quando o BenHub responde 401/403.
 *
 * O aviso SEMPRE fica também no log (NotificadorLog). Se o BenHub falhar, a
 * falha é logada e a rotina segue: aviso nunca derruba automação.
 */

const { requisitar, HttpError } = require('../utils/http-client');

const MARGEM_EXPIRACAO_MS = 5 * 60_000;
const ICONE = { info: '🔔', aviso: '⚠️', erro: '🚨' };

/** Expiração (ms) de um JWT, lida do payload; null se não der para ler. */
function expiracaoDoJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Texto da mensagem no chat. */
const formatar = ({ titulo, texto, nivel = 'info' }) => `${ICONE[nivel] || ICONE.info} BenURA · ${titulo}\n${texto}`;

/** Token na resposta do login (aceita os formatos mais comuns). */
const tokenDaResposta = (r) => r?.token || r?.accessToken || r?.access_token || r?.data?.token || null;

class NotificadorBenHub {
  /**
   * @param {object} deps
   * @param {{ url: string, chatId: string, email?: string, senha?: string, token?: string,
   *           caminhoLogin: string, campoUsuario: string, campoSenha: string, timeoutMs: number }} deps.cfg
   * @param {{ notificar(aviso: object): Promise<void> }} deps.reserva - o NotificadorLog
   * @param {object} deps.logger
   */
  constructor({ cfg, reserva, logger }) {
    Object.assign(this, { cfg, reserva, log: logger });
    this.token = cfg.token || null;
    this.base = cfg.url.replace(/\/+$/, '');
  }

  async notificar(aviso) {
    await this.reserva.notificar(aviso);
    try {
      await this.enviar(formatar(aviso));
    } catch (e) {
      this.log.aviso(`BenHub: aviso "${aviso.titulo}" não foi enviado (${e.message}). Ficou só no log.`);
    }
  }

  /** Envia; se o BenHub recusar o token, entra de novo e tenta mais uma vez. */
  async enviar(content) {
    try {
      return await this.postar(content, await this.obterToken());
    } catch (e) {
      if (!this.deveEntrarDeNovo(e)) throw e;
      this.token = null;
      return this.postar(content, await this.obterToken());
    }
  }

  /** Token recusado (401/403) e há credenciais para entrar de novo. */
  deveEntrarDeNovo(e) {
    return e instanceof HttpError && [401, 403].includes(e.status) && this.podeEntrar();
  }

  postar(content, token) {
    return requisitar(`${this.base}/api/internal-chat/${encodeURIComponent(this.cfg.chatId)}/messages`, {
      metodo: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      corpo: { content, content_type: 'text', reply_to_id: null },
      timeoutMs: this.cfg.timeoutMs,
    });
  }

  podeEntrar() {
    return Boolean(this.cfg.email && this.cfg.senha);
  }

  /** Token válido (com 5 min de folga); se não houver, faz login. */
  async obterToken() {
    const exp = this.token && expiracaoDoJwt(this.token);
    const valido = this.token && (exp === null || exp - Date.now() > MARGEM_EXPIRACAO_MS);
    if (valido) return this.token;
    if (!this.podeEntrar()) throw new Error('token do BenHub vencido e sem BENHUB_EMAIL/BENHUB_SENHA para renovar');
    this.token = await this.entrar();
    return this.token;
  }

  async entrar() {
    const resposta = await requisitar(`${this.base}${this.cfg.caminhoLogin}`, {
      metodo: 'POST',
      corpo: { [this.cfg.campoUsuario]: this.cfg.email, [this.cfg.campoSenha]: this.cfg.senha },
      timeoutMs: this.cfg.timeoutMs,
    });
    const token = tokenDaResposta(resposta);
    if (!token) throw new Error(`login do BenHub (${this.cfg.caminhoLogin}) não devolveu token`);
    this.log.info('BenHub: login do robô ok.');
    return token;
  }
}

module.exports = { NotificadorBenHub, formatar, expiracaoDoJwt };

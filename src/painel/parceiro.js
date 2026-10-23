'use strict';
/**
 * [NOVO] O outro PC (servidor ou reserva), pela rede da empresa.
 *
 * Os dois painéis se conhecem (TRAVA_PARCEIRO_URL) e combinam um segredo
 * (TRAVA_SEGREDO_LOCAL). Cada um serve GET /api/interno/estado e copia do outro:
 *  - os usuários, a cada TRAVA_COPIAR_MS, quando os do outro são mais novos (o
 *    mesmo e-mail e senha nos dois; o Usuarios relê o arquivo quando ele muda);
 *  - o estado do dia (modo dos robôs, status da URA, retenção no Ativo, travas
 *    manuais), logo antes de pegar a trava, se o outro esteve com ela depois deste.
 *    Assim quem assume começa de onde o outro parou.
 * Outro PC fora do ar: segue com o que tem e mostra no painel.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lerJson } = require('../utils/arquivo-json');
const { lerPosse } = require('../utils/posse');

const mtime = (arquivo) => {
  try {
    return fs.statSync(arquivo).mtimeMs;
  } catch {
    return 0;
  }
};

/** Atômico, com .bak (como os outros arquivos de estado). */
function escrever(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, arquivo);
  fs.copyFileSync(arquivo, `${arquivo}.bak`);
}

const resumoDe = (dados) => crypto.createHash('sha256').update(JSON.stringify(dados ?? null)).digest('hex');

class Parceiro {
  /**
   * @param {object} deps
   * @param {object} deps.cfg - cfg.trava
   * @param {{ usuarios: string, posse: string, dia: Record<string, string> }} deps.arquivos
   * @param {typeof fetch} [deps.fetch]
   * @param {object} deps.logger
   */
  constructor({ cfg, arquivos, fetch: http = globalThis.fetch, logger, agora = Date.now }) {
    Object.assign(this, { cfg, arquivos, http, log: logger, agora });
    this.ultimo = null; // { pc, agindo, ..., lidoEm }
    this.erro = null;
    this.copiadoEm = null;
  }

  get ativo() {
    return Boolean(this.cfg.parceiroUrl && this.cfg.segredoLocal);
  }

  /** O pedido veio do outro PC, com o segredo? (comparação em tempo constante) */
  autorizado(req) {
    if (!this.cfg.segredoLocal) return false;
    const a = crypto.createHash('sha256').update(String(req.headers['x-benura-interno'] ?? '')).digest();
    const b = crypto.createHash('sha256').update(this.cfg.segredoLocal).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** O que este PC entrega ao outro (GET /api/interno/estado). */
  servir({ agindo }) {
    const u = lerJson(this.arquivos.usuarios).dados;
    return {
      pc: this.cfg.nomePc,
      agindo,
      ultimaPosse: lerPosse(this.arquivos.posse).ultimaPosse,
      usuarios: u ? { dados: u, alteradoEm: mtime(this.arquivos.usuarios) } : null,
      dia: Object.fromEntries(Object.entries(this.arquivos.dia).map(([nome, arquivo]) => [nome, lerJson(arquivo).dados ?? null])),
    };
  }

  async buscar() {
    try {
      const r = await this.http(`${this.cfg.parceiroUrl}/api/interno/estado`, { headers: { 'X-Benura-Interno': this.cfg.segredoLocal }, signal: AbortSignal.timeout(5000) });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      const dados = await r.json();
      this.ultimo = { ...dados, lidoEm: this.agora() };
      this.erro = null;
      return dados;
    } catch (e) {
      this.erro = `o outro PC (${this.cfg.parceiroUrl}) não respondeu: ${e.name === 'TimeoutError' ? 'tempo esgotado' : e.message}`;
      return null;
    }
  }

  /** Copia os usuários do outro PC, se os dele forem mais novos. */
  async copiarUsuarios() {
    if (!this.ativo) return false;
    const outro = await this.buscar();
    const u = outro?.usuarios;
    if (!u?.dados || !Array.isArray(u.dados.usuarios)) return false;
    const local = lerJson(this.arquivos.usuarios).dados;
    if (resumoDe(local) === resumoDe(u.dados) || u.alteradoEm <= mtime(this.arquivos.usuarios)) return false;
    escrever(this.arquivos.usuarios, u.dados);
    this.copiadoEm = this.agora();
    this.log.info(`Dois PCs: usuários copiados do PC ${outro.pc} (${u.dados.usuarios.length}).`);
    return true;
  }

  /** Antes de pegar a trava: o estado do dia do outro, se ele esteve com a trava depois deste PC. */
  async copiarDia() {
    if (!this.ativo) return false;
    const outro = await this.buscar();
    if (!outro?.dia) return false;
    const minha = lerPosse(this.arquivos.posse).ultimaPosse;
    if (!outro.ultimaPosse || (minha && new Date(outro.ultimaPosse) <= new Date(minha))) return false;
    for (const [nome, dados] of Object.entries(outro.dia)) {
      if (this.arquivos.dia[nome] && dados && typeof dados === 'object') escrever(this.arquivos.dia[nome], dados);
    }
    this.log.aviso(`Dois PCs: estado do dia copiado do PC ${outro.pc} (esteve com a trava por último): modo dos robôs, status da URA, retenção e travas manuais.`);
    return true;
  }

  iniciar() {
    if (!this.ativo) return { parar: () => {} };
    const volta = () => this.copiarUsuarios().catch((e) => this.log.erro(`Dois PCs: ${e.message}`));
    void volta();
    const timer = setInterval(volta, this.cfg.copiarMs);
    timer.unref?.();
    return { parar: () => clearInterval(timer) };
  }

  resumo() {
    if (!this.ativo) return { ativo: false };
    const u = this.ultimo;
    return {
      ativo: true,
      url: this.cfg.parceiroUrl,
      pc: u?.pc ?? null,
      agindo: u?.agindo ?? null,
      respondeu: !this.erro && Boolean(u),
      lidoHaSeg: u ? Math.round((this.agora() - u.lidoEm) / 1000) : null,
      usuariosCopiadosEm: this.copiadoEm ? new Date(this.copiadoEm).toISOString() : null,
      erro: this.erro,
    };
  }
}

module.exports = { Parceiro };

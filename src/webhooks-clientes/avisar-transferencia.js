'use strict';
/**
 * [NOVO] Avisa os clientes do webhook a cada operador transferido entre URA e Ativo.
 *
 * Corpo, sempre e só: { "codigo": <idUsuario na Argus>, "nome": "...", "mensagem": "..." }.
 * Cabeçalho X-BenURA-Assinatura: sha256=<HMAC-SHA256 do corpo com o segredo do cliente>.
 * Não bloqueia quem transferiu: quem chama não espera (falha vai para o log, sem a URL).
 */

const crypto = require('crypto');
const { requisitar: requisitarHttp, comRetry } = require('../utils/http-client');

const MENSAGENS = Object.freeze({ paraAtivo: 'Transferido da URA para o Ativo', paraUra: 'Transferido do Ativo para a URA' });

class AvisoTransferencias {
  /**
   * @param {object} deps
   * @param {{ paraEnviar(): Array<{ id, nome, url, segredo }> }} deps.assinaturas
   * @param {{ atualizar(): Promise, operadorPorRamal(ramal): { idUsuario, nome }|null }} [deps.diretorio]
   */
  constructor({ assinaturas, diretorio = null, logger, requisitar = requisitarHttp, timeoutMs = 5000, tentativas = 2, baseMs = 500 }) {
    Object.assign(this, { assinaturas, diretorio, log: logger, requisitar, timeoutMs, tentativas, baseMs });
    /** id → { ultimoEnvio, ultimoErro } */
    this.estado = new Map();
    this.avisouSemDiretorio = false;
  }

  /** Quem foi transferido: o código e o nome do diretório da Argus. */
  async quem(ramal) {
    try {
      await this.diretorio?.atualizar();
      const op = this.diretorio?.operadorPorRamal(ramal);
      if (op) return { codigo: op.idUsuario ?? null, nome: op.nome ?? `Ramal ${ramal}` };
    } catch (e) {
      if (!this.avisouSemDiretorio) this.log.aviso(`Webhook de transferências: diretório da Argus indisponível (${e.message}); o aviso vai sem o código.`);
      this.avisouSemDiretorio = true;
    }
    return { codigo: null, nome: `Ramal ${ramal}` };
  }

  /** @param {{ ramal: string, paraUra: boolean }} t @returns {Promise<void>} nunca lança */
  async avisar({ ramal, paraUra }) {
    const clientes = this.assinaturas.paraEnviar();
    if (!clientes.length) return;
    const { codigo, nome } = await this.quem(String(ramal));
    await this.enviarParaTodos(clientes, { codigo, nome, mensagem: paraUra ? MENSAGENS.paraUra : MENSAGENS.paraAtivo });
  }

  /** Mensagem de teste para um cliente (painel). @returns {Promise<{ ok: boolean, erro?: string }>} */
  async testar(id) {
    const cliente = this.assinaturas.paraEnviar().find((c) => c.id === id);
    if (!cliente) return { ok: false, erro: 'Cliente não encontrado.' };
    return this.enviar(cliente, { codigo: 0, nome: 'Teste da BenURA', mensagem: 'Mensagem de teste do webhook de transferências' });
  }

  async enviarParaTodos(clientes, corpo) {
    await Promise.all(clientes.map((c) => this.enviar(c, corpo)));
  }

  async enviar(cliente, corpo) {
    const texto = JSON.stringify(corpo);
    const assinatura = crypto.createHmac('sha256', cliente.segredo || '').update(texto).digest('hex');
    const headers = { 'X-BenURA-Assinatura': `sha256=${assinatura}` };
    try {
      await comRetry(() => this.requisitar(cliente.url, { metodo: 'POST', headers, corpo, timeoutMs: this.timeoutMs }), { tentativas: this.tentativas, baseMs: this.baseMs });
      this.estado.set(cliente.id, { ...this.estado.get(cliente.id), ultimoEnvio: new Date().toISOString(), ultimoErro: null });
      return { ok: true };
    } catch (e) {
      const erro = e.timeout ? 'não respondeu a tempo' : e.status ? `HTTP ${e.status}` : 'sem conexão';
      this.estado.set(cliente.id, { ...this.estado.get(cliente.id), ultimoErro: `${new Date().toISOString()} ${erro}` });
      this.log.aviso(`Webhook de transferências: o aviso para ${cliente.nome ?? cliente.id} não chegou (${erro}).`);
      return { ok: false, erro };
    }
  }

  /** Para o painel: último envio e último erro de cada cliente. */
  situacao() {
    return Object.fromEntries(this.estado);
  }
}

module.exports = { AvisoTransferencias, MENSAGENS };

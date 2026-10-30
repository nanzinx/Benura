'use strict';
/**
 * [NOVO] Clientes cadastrados no webhook de transferências (WEBHOOKS_CLIENTES_FILE).
 *
 * O cliente se cadastra por API no rodízio (POST /webhooks/clientes) e recebe um segredo,
 * que assina cada envio (X-BenURA-Assinatura). O roteador também transfere gente, então
 * lê o mesmo arquivo: relê só quando ele muda no disco.
 */

const crypto = require('crypto');
const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { ArquivoJsonObservado } = require('../utils/arquivo-json');

/** https sempre; http só no próprio PC (testes e integrações locais). */
function conferirUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    throw new Error('URL inválida: envie { "url": "https://..." }.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Use uma URL https (http só para localhost).');
  return u.toString();
}

class Assinaturas {
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.log = logger;
    this.repositorio = new ArquivoDeEstado({ arquivo, logger, padrao: { clientes: [] } });
    this.observado = new ArquivoJsonObservado(arquivo);
    this.clientes = [];
  }

  /** Relê se o arquivo mudou (o outro processo pode ter cadastrado alguém). */
  atualizar() {
    const r = this.observado.verificar();
    if (r.estado === 'atualizado') this.clientes = Array.isArray(r.dados?.clientes) ? r.dados.clientes : [];
    if (r.estado === 'ausente') this.clientes = [];
    return this.clientes;
  }

  /** Para o envio (com o segredo). */
  paraEnviar() {
    return this.atualizar();
  }

  /** Para a API e o painel: sem o segredo. */
  listar() {
    return this.atualizar().map(({ segredo, ...resto }) => resto);
  }

  /** @returns {Promise<{ id: string, nome: string|null, url: string, criadoEm: string, segredo: string }>} */
  async cadastrar({ url, nome = null }) {
    const cliente = {
      id: crypto.randomBytes(6).toString('hex'),
      nome: nome ? String(nome).slice(0, 80) : null,
      url: conferirUrl(url),
      criadoEm: new Date().toISOString(),
      segredo: crypto.randomBytes(32).toString('hex'),
    };
    await this.gravar([...this.atualizar(), cliente]);
    this.log.info(`Webhook de transferências: cliente ${cliente.nome ?? cliente.id} cadastrado (${new URL(cliente.url).host}).`);
    return cliente;
  }

  /** @returns {Promise<boolean>} false se não existia */
  async remover(id) {
    const antes = this.atualizar();
    const depois = antes.filter((c) => c.id !== id);
    if (depois.length === antes.length) return false;
    await this.gravar(depois);
    this.log.info(`Webhook de transferências: cliente ${id} removido.`);
    return true;
  }

  async gravar(clientes) {
    this.repositorio.salvar({ clientes });
    await this.repositorio.aguardar();
    this.clientes = clientes;
    this.observado.verificar(); // já sabe do que gravou
  }
}

module.exports = { Assinaturas, conferirUrl };

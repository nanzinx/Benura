'use strict';
/**
 * Perfis de clientes (chave = HMAC do telefone; veja domain/perfis-clientes.js).
 *
 * Duas fontes, somadas na consulta:
 *  - histórico (PERFIS_HISTORICO_FILE): montado por `npm run perfis:montar`, só
 *    leitura aqui; relido sozinho quando o arquivo muda. Cobre os dias antes de `ate`;
 *  - ao vivo (PERFIS_FILE): cada ligação que o vigia de callbacks lê do relatório,
 *    a partir do dia `ate` do histórico (o que já está no histórico não conta de novo).
 * Guarda PERFIS_DIAS dias; quem não tem mais nenhum dia some.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { ArquivoJsonObservado } = require('../utils/arquivo-json');
const { dataLocal } = require('../utils/datas');
const {
  Resultado, telefoneDaLigacao, classificarLigacao, chaveDoCliente, mascarar, somar, totais, motivosDeRisco, podar,
} = require('../domain/perfis-clientes');
const { textoDaHora } = require('../domain/diagnostico-callbacks');

/** Ligações já contadas ficam lembradas por isso (o vigia relê a mesma janela a cada minuto). */
const LEMBRAR_MS = 30 * 60_000;
const SALVAR_A_CADA_MS = 60_000;

/**
 * Segredo do HMAC: PERFIS_SEGREDO ou um arquivo local, criado na primeira vez.
 * Sem ele não dá para voltar da chave ao telefone. Nunca vai para o git.
 */
function obterSegredo({ segredo, arquivoSegredo }) {
  if (segredo) return segredo;
  try {
    return fs.readFileSync(arquivoSegredo, 'utf8').trim();
  } catch {
    const novo = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(arquivoSegredo), { recursive: true });
    fs.writeFileSync(arquivoSegredo, `${novo}\n`, { mode: 0o600 });
    return novo;
  }
}

/** Dia (AAAA-MM-DD) da ligação pela hora do relatório; sem hora, hoje. */
function diaDaLigacao(ligacao, fuso, agora) {
  const m = /(\d{4})-(\d{2})-(\d{2})|(\d{2})\/(\d{2})\/(\d{4})/.exec(String(textoDaHora(ligacao) ?? ''));
  if (!m) return dataLocal(fuso, new Date(agora));
  return m[1] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[6]}-${m[5]}-${m[4]}`;
}

class PerfisClientes {
  /**
   * @param {object} deps
   * @param {{ arquivo: string, arquivoHistorico: string, arquivoSegredo: string, segredo?: string, dias: number,
   *           minCallbacks: number, minAtendeu: number, fuso: string }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ cfg, logger }) {
    Object.assign(this, { cfg, log: logger });
    this.repositorio = new ArquivoDeEstado({ arquivo: cfg.arquivo, logger });
    this.historicoArquivo = new ArquivoJsonObservado(cfg.arquivoHistorico);
    this.historico = { ate: '', perfis: {} };
    this.perfis = {};
    /** idLigacao → quando foi contada */
    this.contadas = new Map();
    this.mudou = false;
    this.ultimoSalvo = 0;
  }

  carregar() {
    this.segredo = obterSegredo(this.cfg);
    this.perfis = this.repositorio.carregar()?.perfis || {};
    this.relerHistorico();
    return this;
  }

  /** Relê o histórico se o arquivo mudou (perfis:montar rodou de novo). */
  relerHistorico() {
    const lido = this.historicoArquivo.verificar();
    if (lido.estado !== 'atualizado' || !lido.dados) return;
    this.historico = { ate: lido.dados.ate || '', perfis: lido.dados.perfis || {} };
    // O que o histórico já cobre não conta duas vezes.
    podar(this.perfis, this.historico.ate);
    this.log.info(`Perfis de clientes: histórico carregado (${Object.keys(this.historico.perfis).length} cliente(s), até ${this.historico.ate}).`);
  }

  desde(agora = Date.now()) {
    return dataLocal(this.cfg.fuso, new Date(agora - this.cfg.dias * 86_400_000));
  }

  /**
   * Conta uma ligação do relatório (só as finais: atendeu ou callback). Sem dados de cliente guardados.
   * @returns {boolean} true se contou
   */
  registrarLigacao(ligacao, agora = Date.now()) {
    const tipo = classificarLigacao(ligacao);
    if (tipo !== Resultado.ATENDEU && tipo !== Resultado.CALLBACK) return false;
    const id = ligacao.idLigacao != null ? String(ligacao.idLigacao) : null;
    if (!id || this.contadas.has(id)) return false;
    const telefone = telefoneDaLigacao(ligacao);
    if (!telefone) return false;
    const dia = diaDaLigacao(ligacao, this.cfg.fuso, agora);
    if (dia < this.historico.ate) return false;

    this.contadas.set(id, agora);
    const chave = chaveDoCliente(telefone, this.segredo);
    this.perfis[chave] = somar(this.perfis[chave], { mascara: mascarar(telefone), dia, tipo });
    this.mudou = true;
    return true;
  }

  /** Perfil do telefone (histórico + ao vivo) e por que é de risco. @returns {object|null} */
  consultar(telefoneBruto, agora = Date.now()) {
    const telefone = telefoneDaLigacao({ telefone: telefoneBruto });
    if (!telefone) return null;
    const chave = chaveDoCliente(telefone, this.segredo);
    return this.resumir(chave, agora) || { mascara: mascarar(telefone), atendeu: 0, callbacks: 0, motivos: [] };
  }

  resumir(chave, agora = Date.now()) {
    const vivo = this.perfis[chave];
    const antigo = this.historico.perfis[chave];
    if (!vivo && !antigo) return null;
    const desde = this.desde(agora);
    const a = totais(antigo, desde);
    const b = totais(vivo, desde);
    const soma = { atendeu: a.atendeu + b.atendeu, callbacks: a.callbacks + b.callbacks };
    const ultimoDia = [a.ultimoDia, b.ultimoDia].filter(Boolean).sort().pop() || null;
    return { mascara: (vivo || antigo).mascara, ...soma, ultimoDia, motivos: motivosDeRisco(soma, this.cfg) };
  }

  /** Os clientes de risco, mais callbacks primeiro. */
  maisArriscados(limite = 20, agora = Date.now()) {
    const chaves = new Set([...Object.keys(this.historico.perfis), ...Object.keys(this.perfis)]);
    return [...chaves].map((c) => this.resumir(c, agora)).filter((r) => r && r.motivos.length)
      .sort((x, y) => y.callbacks - x.callbacks || y.atendeu - x.atendeu).slice(0, limite);
  }

  /** Grava (no máximo a cada minuto), esquece ligações antigas e dias fora da janela. */
  manter(agora = Date.now()) {
    this.relerHistorico();
    for (const [id, quando] of this.contadas) if (agora - quando > LEMBRAR_MS) this.contadas.delete(id);
    if (!this.mudou || agora - this.ultimoSalvo < SALVAR_A_CADA_MS) return;
    this.salvar(agora);
  }

  /** Grava agora (também no desligamento do BenURA). @returns {Promise<void>} */
  salvar(agora = Date.now()) {
    podar(this.perfis, this.desde(agora));
    this.mudou = false;
    this.ultimoSalvo = agora;
    this.repositorio.salvar({ perfis: this.perfis });
    return this.repositorio.aguardar();
  }

  resumo(agora = Date.now()) {
    return {
      clientes: new Set([...Object.keys(this.historico.perfis), ...Object.keys(this.perfis)]).size,
      historicoAte: this.historico.ate || null,
      risco: this.maisArriscados(Infinity, agora).length,
    };
  }
}

module.exports = { PerfisClientes, obterSegredo, diaDaLigacao };

'use strict';
/**
 * Persistência de estado em JSON resistente a quedas.
 *
 *  - Escrita atômica: grava num .tmp e renomeia; mantém cópia .bak.
 *  - Escritas serializadas: chamadas concorrentes nunca se intercalam e
 *    pedidos em rajada são agrupados (só a versão mais recente é gravada).
 *  - Leitura com recuperação: se o arquivo principal estiver ilegível, usa o .bak.
 */

const fs = require('fs');
const { lerJson } = require('./arquivo-json');

/**
 * Lê o arquivo de estado, recorrendo ao .bak se preciso.
 * @returns {{ dados: *, origem: 'principal'|'backup'|null, erro?: Error }}
 */
function lerComBackup(caminho) {
  const principal = lerJson(caminho);
  if (!principal.erro) return { dados: principal.dados, origem: 'principal' };

  const backup = lerJson(`${caminho}.bak`);
  if (!backup.erro) return { dados: backup.dados, origem: 'backup', erro: principal.erro };

  const ausente = principal.erro.code === 'ENOENT';
  return { dados: null, origem: null, erro: ausente ? undefined : principal.erro };
}

class GravadorJsonAtomico {
  /**
   * @param {string} caminho
   * @param {object} logger
   */
  constructor(caminho, logger) {
    this.caminho = caminho;
    this.log = logger;
    this.fila = Promise.resolve();
    this.pendente = null; // conteúdo mais recente ainda não gravado
  }

  /**
   * Agenda a gravação de um snapshot. Nunca rejeita: falhas são logadas.
   * @returns {Promise<void>} resolve quando este snapshot (ou um mais novo) foi gravado
   */
  salvar(dados) {
    const jaHaviaPendente = this.pendente !== null;
    this.pendente = JSON.stringify(dados, null, 2);
    if (!jaHaviaPendente) this.fila = this.fila.then(() => this.gravarPendente());
    return this.fila;
  }

  async gravarPendente() {
    const conteudo = this.pendente;
    this.pendente = null;
    const tmp = `${this.caminho}.tmp`;
    try {
      await fs.promises.writeFile(tmp, conteudo);
      await fs.promises.rename(tmp, this.caminho);
      await fs.promises.copyFile(this.caminho, `${this.caminho}.bak`);
    } catch (e) {
      this.log.erro(`Falha ao salvar ${this.caminho}: ${e.message}`);
    }
  }

  /** Aguarda as gravações pendentes (usado no desligamento). */
  aguardar() {
    return this.fila;
  }
}

/**
 * Estado simples em JSON (objeto), com leitura tolerante e gravação atômica.
 * Para estados pequenos de serviços (ex.: retornos pendentes, última execução de rotinas).
 */
class ArquivoDeEstado {
  constructor({ arquivo, logger, padrao = {} }) {
    this.arquivo = arquivo;
    this.log = logger;
    this.padrao = padrao;
    this.gravador = new GravadorJsonAtomico(arquivo, logger);
  }

  /** @returns {object} estado salvo, ou o padrão. Nunca lança. */
  carregar() {
    const { dados, origem, erro } = lerComBackup(this.arquivo);
    if (erro) this.log.aviso(`Não foi possível ler ${this.arquivo}: ${erro.message}`);
    const valido = origem && dados && typeof dados === 'object' && !Array.isArray(dados);
    return valido ? dados : structuredClone(this.padrao);
  }

  salvar(estado) {
    return this.gravador.salvar(estado);
  }

  aguardar() {
    return this.gravador.aguardar();
  }
}

module.exports = { lerComBackup, GravadorJsonAtomico, ArquivoDeEstado };

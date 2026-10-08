'use strict';
/**
 * Trilha de auditoria em JSON Lines (um evento JSON por linha, só acrescenta).
 *
 * Fácil de ler com `tail`, `grep` ou importar numa planilha. Falhas de escrita
 * são logadas e nunca interrompem o fluxo principal.
 */

const fs = require('fs');
const os = require('os');

class AuditoriaRepository {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.log = logger;
  }

  /**
   * Registra um evento.
   * @param {string} acao - Ex.: "cadastro.planejar", "cadastro.conferir"
   * @param {object} dados
   */
  async registrar(acao, dados) {
    const evento = {
      em: new Date().toISOString(),
      acao,
      executadoPor: usuarioDoSistema(),
      ...dados,
    };
    try {
      await fs.promises.appendFile(this.arquivo, `${JSON.stringify(evento)}\n`);
    } catch (e) {
      this.log.erro(`Falha ao gravar auditoria em ${this.arquivo}: ${e.message}`);
    }
    return evento;
  }
}

function usuarioDoSistema() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || 'desconhecido';
  }
}

module.exports = { AuditoriaRepository };

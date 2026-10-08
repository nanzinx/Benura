'use strict';
/**
 * Cliente da API de comandos da discadora Argus.
 *
 * Todos os comandos são `POST {base}/{comando}` com header `Token-Signature`.
 * A Argus sinaliza erro de negócio com `codStatus !== 1` mesmo em HTTP 200,
 * por isso esse caso também vira exceção (`ArgusError`).
 */

const { requisitar, comRetry, HttpError } = require('../../utils/http-client');

class ArgusError extends Error {
  constructor(mensagem, { comando, resposta, cause } = {}) {
    super(mensagem, cause ? { cause } : undefined);
    this.name = 'ArgusError';
    this.comando = comando;
    this.resposta = resposta;
  }
}

class ArgusClient {
  /**
   * @param {object} cfg - Seção `argus` da configuração
   * @param {object} logger
   */
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
  }

  /**
   * Executa um comando na Argus.
   * @returns {Promise<object>} Resposta com codStatus === 1
   * @throws {ArgusError}
   */
  async comando(nome, corpo = {}) {
    let resposta;
    try {
      resposta = await comRetry(
        () => requisitar(`${this.cfg.baseUrl}/${nome}`, {
          metodo: 'POST',
          headers: { 'Token-Signature': this.cfg.token },
          corpo,
          timeoutMs: this.cfg.timeoutMs,
        }),
        {
          tentativas: this.cfg.tentativas,
          aoFalhar: (e, n) => this.log.debug(`${nome}: tentativa ${n} falhou (${e.message})`),
        },
      );
    } catch (e) {
      const detalhe = e instanceof HttpError && e.corpo?.descStatus ? ` — ${e.corpo.descStatus}` : '';
      throw new ArgusError(`Argus /${nome} falhou: ${e.message}${detalhe}`, { comando: nome, cause: e });
    }

    if (!resposta || resposta.codStatus !== 1) {
      throw new ArgusError(
        `Argus /${nome} recusou o comando: ${resposta?.descStatus || 'codStatus ' + resposta?.codStatus}`,
        { comando: nome, resposta },
      );
    }
    return resposta;
  }

  /** @returns {Promise<Array<{ idGrupoUsuario: number, ramaisOperadores?: Array }>>} */
  async listarGrupos() {
    const r = await this.comando('listargrupos');
    if (!Array.isArray(r.grupos)) {
      throw new ArgusError('Argus /listargrupos retornou sem a lista "grupos"', { comando: 'listargrupos', resposta: r });
    }
    return r.grupos;
  }

  /** @returns {Promise<object>} */
  transferirOperador(ramal, grupoDestinoId) {
    return this.comando('transferiroperadorgrupo', {
      idGrupoUsuarioDestino: grupoDestinoId,
      ramaisOperadores: [ramal],
    });
  }
}

module.exports = { ArgusClient, ArgusError };

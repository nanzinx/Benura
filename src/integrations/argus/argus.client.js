'use strict';
/**
 * Cliente da API de comandos da discadora Argus (doc-api-argus.pdf).
 *
 * Todos os comandos são `POST {base}/{comando}` com header `Token-Signature`.
 * A Argus sinaliza erro de negócio com `codStatus < 1` mesmo em HTTP 200,
 * por isso esse caso também vira exceção (`ArgusError`).
 *
 * Respostas HTTP documentadas: 200 / 400 Bad Request / 403 Forbidden / 500.
 * 403 significa token inválido ou sem permissão — não é limite de requisições,
 * então não é re-tentado e vira `ArgusAutenticacaoError`.
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

/** Token ausente, inválido ou sem permissão para o comando (HTTP 403). */
class ArgusAutenticacaoError extends ArgusError {
  constructor(comando, cause) {
    super(`Argus recusou o token em /${comando} (HTTP 403). Verifique ARGUS_TOKEN em Configurações → Desenvolvedor → Acesso API.`,
      { comando, cause });
    this.name = 'ArgusAutenticacaoError';
  }
}

/** Tipos de usuário em /listarusuarios. */
const TipoUsuario = Object.freeze({ ADMINISTRATIVO: 1, OPERADOR: 2 });

/** Tipos de grupo em /listargrupos. */
const TipoGrupo = Object.freeze({ OPERACIONAL: 1, VIRTUAL_DTMF: 2, VIRTUAL_FLASH: 3 });

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
   * @throws {ArgusAutenticacaoError|ArgusError}
   */
  async comando(nome, corpo = {}, { timeoutMs = this.cfg.timeoutMs } = {}) {
    let resposta;
    try {
      resposta = await comRetry(
        () => requisitar(`${this.cfg.baseUrl}/${nome}`, {
          metodo: 'POST',
          headers: { 'Token-Signature': this.cfg.token },
          corpo,
          timeoutMs,
        }),
        {
          tentativas: this.cfg.tentativas,
          aoFalhar: (e, n) => this.log.debug(`${nome}: tentativa ${n} falhou (${e.message})`),
        },
      );
    } catch (e) {
      if (e instanceof HttpError && e.status === 403) throw new ArgusAutenticacaoError(nome, e);
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

  /**
   * Grupos operacionais e virtuais ativos.
   * @param {{ idTipoGrupo?: number }} [filtro]
   * @returns {Promise<Array<{ idCampanha, campanhaDesc, idGrupoUsuario, grupoUsuarioDesc, idTipoGrupo, ramaisOperadores }>>}
   */
  async listarGrupos(filtro = {}) {
    const r = await this.comando('listargrupos', filtro);
    if (!Array.isArray(r.grupos)) {
      throw new ArgusError('Argus /listargrupos retornou sem a lista "grupos"', { comando: 'listargrupos', resposta: r });
    }
    return r.grupos;
  }

  /**
   * Usuários (administrativos e/ou operadores), com campanhas, grupo e supervisor.
   * Sem filtros, retorna todos — ativos e inativos.
   *
   * @param {{ idCampanha?: number, ativo?: 'true'|'false', idTipoUsuario?: number }} [filtro]
   * @returns {Promise<Array<object>>}
   */
  async listarUsuarios(filtro = {}) {
    // Lista completa pode ser grande: dá mais folga de timeout.
    const r = await this.comando('listarusuarios', filtro, { timeoutMs: Math.max(this.cfg.timeoutMs, 15_000) });
    if (!Array.isArray(r.usuarios)) {
      throw new ArgusError('Argus /listarusuarios retornou sem a lista "usuarios"', { comando: 'listarusuarios', resposta: r });
    }
    return r.usuarios;
  }

  /** @returns {Promise<Array<{ idCampanha, campanhaDesc, ativo }>>} */
  async listarCampanhas(filtro = {}) {
    const r = await this.comando('listarcampanhas', filtro);
    return Array.isArray(r.campanhas) ? r.campanhas : [];
  }

  /**
   * Transfere um operador de grupo.
   *
   * A Argus pode responder codStatus 1 no geral e ainda assim falhar para o
   * operador (ex.: não vinculado à campanha do grupo destino). Por isso o
   * resultado individual em `operadores[]` / `qtdeTransferidos` é conferido.
   *
   * @throws {ArgusError} se o operador não foi transferido
   */
  async transferirOperador(ramal, grupoDestinoId) {
    const comando = 'transferiroperadorgrupo';
    const r = await this.comando(comando, {
      idGrupoUsuarioDestino: grupoDestinoId,
      ramaisOperadores: [String(ramal)],
    });

    const individual = Array.isArray(r.operadores)
      ? r.operadores.find((o) => String(o.ramal) === String(ramal))
      : null;
    const falhou = (individual && individual.codStatus !== 1)
      || (r.qtdeTransferidos !== undefined && r.qtdeTransferidos < 1);

    if (falhou) {
      const motivo = individual?.descStatus || r.descStatus || 'operador não transferido';
      throw new ArgusError(`Argus não transferiu o ramal ${ramal}: ${motivo}`, { comando, resposta: r });
    }
    return r;
  }
}

module.exports = { ArgusClient, ArgusError, ArgusAutenticacaoError, TipoUsuario, TipoGrupo };

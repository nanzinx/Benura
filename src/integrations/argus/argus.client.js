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

const { requisitar, comRetry, HttpError, ehRetentavel } = require('../../utils/http-client');

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

/**
 * A Argus pediu para desacelerar (HTTP 429). Enquanto durar a pausa, os
 * comandos falham na hora, sem rede — exceto os de emergência.
 */
class ArgusLimiteError extends ArgusError {
  constructor(comando, ateMs) {
    super(`Argus em pausa por limite de requisições até ${new Date(ateMs).toISOString()} (/${comando} não enviado).`, { comando });
    this.name = 'ArgusLimiteError';
  }
}

/** Comandos de emergência: seguem mesmo durante a pausa de limite (derrubar robôs evita fila na URA). */
const PERMITIDOS_NA_PAUSA = new Set(['deslogaroperador']);

/** 429 não é re-tentado na hora: vira pausa global. */
const retentavelNaArgus = (e) => ehRetentavel(e) && e.status !== 429;

/** Tipos de usuário em /listarusuarios. */
const TipoUsuario = Object.freeze({ ADMINISTRATIVO: 1, OPERADOR: 2 });

/** Tipos de grupo em /listargrupos. */
const TipoGrupo = Object.freeze({ OPERACIONAL: 1, VIRTUAL_DTMF: 2, VIRTUAL_FLASH: 3 });

/** Resposta com codStatus diferente de 1. */
const recusa = (comando, resposta) => new ArgusError(
  `Argus /${comando} recusou o comando: ${resposta?.descStatus || 'codStatus ' + resposta?.codStatus}`,
  { comando, resposta },
);

/** Converte uma falha HTTP no erro de domínio da Argus. */
function traduzirErro(comando, e) {
  if (e instanceof HttpError && e.status === 403) return new ArgusAutenticacaoError(comando, e);
  const detalhe = e instanceof HttpError && e.corpo?.descStatus ? ` — ${e.corpo.descStatus}` : '';
  return new ArgusError(`Argus /${comando} falhou: ${e.message}${detalhe}`, { comando, cause: e });
}

class ArgusClient {
  /**
   * @param {object} cfg - Seção `argus` da configuração
   * @param {object} logger
   */
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.pausaAte = 0;
  }

  /**
   * Executa um comando na Argus.
   * @param {string} nome
   * @param {object} [corpo]
   * @param {{ timeoutMs?: number, tentativas?: number }} [opcoes]
   * @returns {Promise<object>} Resposta com codStatus === 1
   * @throws {ArgusAutenticacaoError|ArgusLimiteError|ArgusError}
   */
  async comando(nome, corpo = {}, opcoes = {}) {
    const resposta = await this.enviar(nome, corpo, opcoes);
    if (resposta?.codStatus === 1) return resposta;
    throw recusa(nome, resposta);
  }

  /** POST com retry; erros de transporte viram ArgusError/ArgusAutenticacaoError/ArgusLimiteError. */
  async enviar(nome, corpo, { timeoutMs = this.cfg.timeoutMs, tentativas = this.cfg.tentativas, url } = {}) {
    this.exigirForaDaPausa(nome);
    const requisicao = () => requisitar(url || `${this.cfg.baseUrl}/${nome}`, {
      metodo: 'POST',
      headers: { 'Token-Signature': this.cfg.token },
      corpo,
      timeoutMs,
    });
    try {
      return await comRetry(requisicao, {
        tentativas,
        retentavel: retentavelNaArgus,
        aoFalhar: (e, n) => this.log.debug(`${nome}: tentativa ${n} falhou (${e.message})`),
      });
    } catch (e) {
      throw this.traduzirFalha(nome, e);
    }
  }

  exigirForaDaPausa(nome) {
    if (Date.now() >= this.pausaAte || PERMITIDOS_NA_PAUSA.has(nome)) return;
    throw new ArgusLimiteError(nome, this.pausaAte);
  }

  traduzirFalha(nome, e) {
    if (!(e instanceof HttpError) || e.status !== 429) return traduzirErro(nome, e);
    this.pausaAte = Date.now() + (this.cfg.pausaLimiteMs ?? 5000);
    this.log.aviso(`Argus pediu para desacelerar (HTTP 429). Pausa global até ${new Date(this.pausaAte).toISOString()}.`);
    return new ArgusLimiteError(nome, this.pausaAte);
  }

  // ───────────────────────────── Mailing ─────────────────────────────

  /** URL de um comando de mailing: {base}/apiargus/{hashSkill}/{comando}. */
  urlMailing(hashSkill, comando) {
    if (!hashSkill) throw new ArgusError(`hashSkill ausente para /${comando}`, { comando });
    return `${this.cfg.baseMailing}/${encodeURIComponent(hashSkill)}/${comando}`;
  }

  /**
   * Inclui um lead unitário numa skill (doc 2.4). Só `telefone1` é obrigatório.
   * @returns {Promise<{ nrLead: number, idLote: number }>}
   */
  async incluirLead(hashSkill, lead) {
    const resposta = await this.enviar('novo', lead, { url: this.urlMailing(hashSkill, 'novo'), tentativas: 1 });
    if (resposta?.codStatus === 1) return resposta;
    throw recusa('novo', resposta);
  }

  /**
   * Exclui leads de uma skill (doc 2.5) por nrLead, codCliente ou telefone.
   * Esta rota responde { items, count } sem codStatus no topo.
   * @returns {Promise<{ excluidos: number, items: object[] }>}
   */
  async excluirLead(hashSkill, filtro) {
    const resposta = await this.enviar('excluir', filtro, { url: this.urlMailing(hashSkill, 'excluir') });
    const items = Array.isArray(resposta?.items) ? resposta.items : [];
    return { excluidos: resposta?.count ?? items.filter((i) => i.codStatus === 1).length, items };
  }

  // ───────────────────────────── Operadores ─────────────────────────────

  /**
   * Status de um operador.
   * @returns {Promise<object|null>} statusOperador, ou null se não está logado
   * @throws {ArgusError} quando a Argus não respondeu ou respondeu codStatus -1
   */
  async statusOperador(ramal) {
    const resposta = await this.enviar('statusoperador', { ramal: String(ramal) }, { timeoutMs: 2000, tentativas: 1 });
    if (resposta?.codStatus === 1 && resposta.statusOperador) return resposta.statusOperador;
    if (resposta?.codStatus === -1) throw recusa('statusoperador', resposta);
    return null; // demais códigos: operador não logado
  }

  /** Desconecta um operador ou operador virtual. Emergencial: segue mesmo durante a pausa de limite. */
  deslogarOperador(ramal) {
    return this.comando('deslogaroperador', { ramal: String(ramal) }, { timeoutMs: 1500, tentativas: 1 });
  }

  /** Aciona todos os operadores virtuais ativos de um grupo. */
  logarOperadoresVirtuais(idGrupoUsuario) {
    return this.comando('logaroperadorvirtual', { idGrupoUsuario }, { timeoutMs: 2000 });
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

    if (!falhou) return r;

    const motivo = individual?.descStatus || r.descStatus || 'operador não transferido';
    throw new ArgusError(`Argus não transferiu o ramal ${ramal}: ${motivo}`, { comando, resposta: r });
  }
}

module.exports = {
  ArgusClient, ArgusError, ArgusAutenticacaoError, ArgusLimiteError, TipoUsuario, TipoGrupo,
};

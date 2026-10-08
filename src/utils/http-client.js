'use strict';
/**
 * Cliente HTTP baseado no fetch nativo (Node 18+), com timeout, retry com
 * backoff exponencial e erros tipados.
 *
 * Diferente da versão anterior, falhas lançam `HttpError` em vez de retornar
 * objetos "ok: false" — quem chama decide como tratar via try/catch.
 */

class HttpError extends Error {
  /**
   * @param {string} mensagem
   * @param {object} detalhes
   * @param {number} [detalhes.status] - Status HTTP (0 = falha de rede/timeout)
   * @param {string} [detalhes.url]
   * @param {*} [detalhes.corpo] - Corpo da resposta, se houver
   * @param {boolean} [detalhes.timeout]
   */
  constructor(mensagem, { status = 0, url = '', corpo = null, timeout = false, cause } = {}) {
    super(mensagem, cause ? { cause } : undefined);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.corpo = corpo;
    this.timeout = timeout;
  }

  /** Erros de rede, timeout, 429 e 5xx valem uma nova tentativa; 4xx não. */
  get retentavel() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Monta as opções do fetch; o corpo só vai em métodos que o aceitam. */
function montarInit({ metodo, headers, corpo, timeoutMs }) {
  const init = {
    method: metodo,
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (corpo === undefined || metodo === 'GET') return init;

  init.headers['Content-Type'] = 'application/json';
  init.body = JSON.stringify(corpo);
  return init;
}

/** Converte a exceção do fetch (rede/timeout) em HttpError. */
function erroDeRede(e, url, timeoutMs) {
  const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
  const mensagem = timeout ? `Timeout após ${timeoutMs}ms` : `Falha de rede: ${e.message}`;
  return new HttpError(mensagem, { url, timeout, cause: e });
}

/** fetch que converte falhas de rede/timeout em HttpError. */
async function buscar(url, init, timeoutMs) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw erroDeRede(e, url, timeoutMs);
  }
}

/** Corpo da resposta: JSON quando possível, senão texto; vazio vira null. */
function interpretarCorpo(texto) {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/**
 * Faz uma única requisição HTTP e devolve o corpo já parseado (JSON ou texto).
 *
 * @param {string} url
 * @param {object} [opcoes]
 * @param {string} [opcoes.metodo='GET']
 * @param {object} [opcoes.headers]
 * @param {*} [opcoes.corpo] - Serializado como JSON
 * @param {number} [opcoes.timeoutMs=5000]
 * @returns {Promise<*>}
 * @throws {HttpError}
 */
async function requisitar(url, { metodo = 'GET', headers = {}, corpo, timeoutMs = 5000 } = {}) {
  const res = await buscar(url, montarInit({ metodo, headers, corpo, timeoutMs }), timeoutMs);
  const dados = interpretarCorpo(await res.text());

  if (!res.ok) throw new HttpError(`HTTP ${res.status} em ${metodo} ${url}`, { status: res.status, url, corpo: dados });
  return dados;
}

/** Executa `fn` e devolve o resultado ou o erro, sem lançar. */
async function capturar(fn) {
  try {
    return { ok: true, valor: await fn() };
  } catch (erro) {
    return { ok: false, erro };
  }
}

/** Erros de rede, timeout, 429 e 5xx valem nova tentativa; erros que não são HTTP também. */
const ehRetentavel = (erro) => !(erro instanceof HttpError) || erro.retentavel;

/**
 * Executa `fn` com retry e backoff exponencial (base * 2^n, com jitter).
 * Só tenta de novo quando o erro é retentável.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opcoes]
 * @param {number} [opcoes.tentativas=3]
 * @param {number} [opcoes.baseMs=500]
 * @param {(erro: Error, tentativa: number) => void} [opcoes.aoFalhar]
 * @param {(erro: Error) => boolean} [opcoes.retentavel] - Decide se o erro vale nova tentativa
 * @returns {Promise<T>}
 */
async function comRetry(fn, { tentativas = 3, baseMs = 500, aoFalhar, retentavel = ehRetentavel } = {}) {
  for (let tentativa = 1; ; tentativa++) {
    const r = await capturar(fn);
    if (r.ok) return r.valor;
    if (tentativa >= tentativas || !retentavel(r.erro)) throw r.erro;

    aoFalhar?.(r.erro, tentativa);
    await esperar(baseMs * 2 ** (tentativa - 1) + Math.floor(Math.random() * 100));
  }
}

module.exports = { HttpError, requisitar, comRetry, esperar, ehRetentavel };

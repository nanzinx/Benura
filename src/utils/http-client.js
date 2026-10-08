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
  const init = {
    method: metodo,
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (corpo !== undefined && metodo !== 'GET') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(corpo);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    throw new HttpError(timeout ? `Timeout após ${timeoutMs}ms` : `Falha de rede: ${e.message}`, {
      url, timeout, cause: e,
    });
  }

  const texto = await res.text();
  let dados = texto;
  if (texto) {
    try { dados = JSON.parse(texto); } catch { /* resposta não-JSON: mantém texto */ }
  } else {
    dados = null;
  }

  if (!res.ok) {
    throw new HttpError(`HTTP ${res.status} em ${metodo} ${url}`, { status: res.status, url, corpo: dados });
  }
  return dados;
}

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
 * @returns {Promise<T>}
 */
async function comRetry(fn, { tentativas = 3, baseMs = 500, aoFalhar } = {}) {
  let ultimoErro;
  for (let i = 1; i <= tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErro = e;
      const podeRetentar = !(e instanceof HttpError) || e.retentavel;
      if (!podeRetentar || i === tentativas) break;
      aoFalhar?.(e, i);
      await esperar(baseMs * 2 ** (i - 1) + Math.floor(Math.random() * 100));
    }
  }
  throw ultimoErro;
}

module.exports = { HttpError, requisitar, comRetry, esperar };

'use strict';
/**
 * Conversa do painel com os serviços do BenURA (roteador, rodízio, rotinas e
 * atualizador), pelo localhost. Leva o WEBHOOK_TOKEN: o navegador nunca o vê.
 *
 * Só passam os comandos da lista ACOES (nada de webhook da Argus ou rota nova
 * sem passar por aqui).
 */

/** Comandos do painel → serviço e rota. Os de escrita ficam no log do painel. */
const ACOES = Object.freeze([
  { metodo: 'POST', caminho: '/api/rodizio/panico', servico: 'rodizio', destino: '/panico', nome: 'ligar o pânico' },
  { metodo: 'DELETE', caminho: '/api/rodizio/panico', servico: 'rodizio', destino: '/panico', nome: 'desligar o pânico' },
  { metodo: 'POST', caminho: '/api/rodizio/ura/passiva', servico: 'rodizio', destino: '/ura/passiva', nome: 'ligar a URA passiva hoje' },
  { metodo: 'DELETE', caminho: '/api/rodizio/ura/passiva', servico: 'rodizio', destino: '/ura/passiva', nome: 'desligar a URA passiva' },
  { metodo: 'POST', caminho: '/api/rodizio/ura/cheia', servico: 'rodizio', destino: '/ura/cheia', nome: 'ligar a URA cheia' },
  { metodo: 'DELETE', caminho: '/api/rodizio/ura/cheia', servico: 'rodizio', destino: '/ura/cheia', nome: 'desligar a URA cheia' },
  { metodo: 'POST', caminho: '/api/rodizio/risco/desligar', servico: 'rodizio', destino: '/risco/desligar', nome: 'ligar "desligar robôs com cliente de risco"' },
  { metodo: 'DELETE', caminho: '/api/rodizio/risco/desligar', servico: 'rodizio', destino: '/risco/desligar', nome: 'desligar "desligar robôs com cliente de risco"' },
  { metodo: 'GET', caminho: '/api/rodizio/perfis/risco', servico: 'rodizio', destino: '/perfis/risco' },
  { metodo: 'GET', caminho: '/api/roteador/status', servico: 'roteador', destino: '/status' },
  { metodo: 'POST', caminho: '/api/roteador/manual', servico: 'roteador', destino: '/manual', nome: 'colar a esteira', limiteBytes: 10 * 1024 * 1024 },
  { metodo: 'DELETE', caminho: '/api/roteador/manual', servico: 'roteador', destino: '/manual', nome: 'apagar as esteiras coladas' },
  { metodo: 'POST', caminho: '/api/roteador/recarregar', servico: 'roteador', destino: '/recarregar', nome: 'recarregar as vendas' },
]);

const NOMES = Object.freeze({ roteador: 'Roteador de vendas', rodizio: 'Rodízio e robôs', rotinas: 'Rotinas do dia', atualizador: 'Atualizador automático' });

class Servicos {
  /**
   * @param {object} deps
   * @param {{ servicos: Record<string, string>, timeoutMs: number }} deps.cfg
   * @param {string} deps.token - WEBHOOK_TOKEN
   * @param {typeof fetch} [deps.fetch]
   */
  constructor({ cfg, token, fetch: buscar = globalThis.fetch }) {
    Object.assign(this, { cfg, token, buscar });
  }

  /**
   * @param {string} servico
   * @param {string} caminho
   * @param {{ metodo?: string, corpo?: string, timeoutMs?: number }} [opcoes] - corpo já em JSON
   * @returns {Promise<{ status: number, corpo: any, ms: number }>} status 0 = fora do ar
   */
  async chamar(servico, caminho, { metodo = 'GET', corpo, timeoutMs = this.cfg.timeoutMs } = {}) {
    const inicio = Date.now();
    const headers = { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(corpo ? { 'Content-Type': 'application/json' } : {}) };
    try {
      const resposta = await this.buscar(`${this.cfg.servicos[servico]}${caminho}`, {
        method: metodo, headers, body: corpo, signal: AbortSignal.timeout(timeoutMs),
      });
      const texto = await resposta.text();
      let json;
      try {
        json = texto ? JSON.parse(texto) : null;
      } catch {
        json = { erro: `Resposta inesperada do ${NOMES[servico]} (HTTP ${resposta.status})` };
      }
      return { status: resposta.status, corpo: json, ms: Date.now() - inicio };
    } catch (e) {
      const motivo = e.name === 'TimeoutError' ? 'não respondeu a tempo' : 'fora do ar';
      return { status: 0, corpo: { erro: `${NOMES[servico]} ${motivo}` }, ms: Date.now() - inicio };
    }
  }

  /** /health de todos, em paralelo. @returns {Promise<Record<string, { nome, online, ms, dados }>>} */
  async saude() {
    const nomes = Object.keys(this.cfg.servicos);
    const respostas = await Promise.all(nomes.map((s) => this.chamar(s, '/health')));
    return Object.fromEntries(nomes.map((s, i) => {
      const r = respostas[i];
      return [s, { nome: NOMES[s] ?? s, online: r.status >= 200 && r.status < 300, ms: r.ms, dados: r.status === 200 ? r.corpo : null }];
    }));
  }
}

module.exports = { Servicos, ACOES, NOMES };

'use strict';
/**
 * Conversa do painel com os serviços do BenURA (roteador, rodízio, rotinas e
 * atualizador), pelo localhost. Leva o WEBHOOK_TOKEN: o navegador nunca o vê.
 *
 * Só passam os comandos da lista ACOES (nada de webhook da Argus ou rota nova
 * sem passar por aqui).
 */

/**
 * Comandos do painel → serviço e rota. Os de escrita ficam no log do painel.
 * comQuem: o painel põe no corpo quem pediu (`por`: e-mail do Access e IP), para o log do serviço.
 */
// [NOVO] servico 'robos': o benura-robos; com ROBOS_SERVICO_PROPRIO=false (sem ele na config), vai ao rodízio.
const ACOES = Object.freeze([
  { metodo: 'POST', caminho: '/api/rodizio/panico', servico: 'robos', destino: '/panico', nome: 'ligar o pânico' },
  { metodo: 'DELETE', caminho: '/api/rodizio/panico', servico: 'robos', destino: '/panico', nome: 'desligar o pânico' },
  // [NOVO] status da URA (manual ou automático), métricas do dia e "Alocar Todos no Ativo"
  { metodo: 'PUT', caminho: '/api/ura/status', servico: 'rodizio', destino: '/ura/status', nome: 'mudar o status da URA', comQuem: true, limiteBytes: 1024 },
  { metodo: 'GET', caminho: '/api/metricas/hoje', servico: 'rodizio', destino: '/metricas/hoje' },
  // [NOVO] relatório de 7 e 30 dias, com as sugestões de ajuste (só leitura)
  { metodo: 'GET', caminho: '/api/relatorio/semana', servico: 'rodizio', destino: '/relatorio/periodo?dias=7' },
  { metodo: 'GET', caminho: '/api/relatorio/mes', servico: 'rodizio', destino: '/relatorio/periodo?dias=30' },
  // [NOVO] modo dos robôs: automático, só pânico ou desligados
  { metodo: 'PUT', caminho: '/api/robos/modo', servico: 'robos', destino: '/robos/modo', nome: 'mudar o modo dos robôs', comQuem: true, limiteBytes: 1024 },
  // [NOVO] seleção manual de grupo de robôs e transferência de robôs entre grupos
  { metodo: 'PUT', caminho: '/api/robos/grupo', servico: 'robos', destino: '/robos/grupo', nome: 'mudar o grupo dos robôs', comQuem: true, limiteBytes: 1024 },
  { metodo: 'POST', caminho: '/api/robos/transferir-grupo', servico: 'robos', destino: '/robos/transferir-grupo', nome: 'transferir robôs de grupo', comQuem: true, limiteBytes: 1024, timeoutMs: 30_000 },
  {
    metodo: 'POST', caminho: '/api/operadores/transferir-ura-ativo', servico: 'rodizio', destino: '/operadores/transferir-ura-ativo',
    nome: 'alocar todos da URA no Ativo', comQuem: true, limiteBytes: 1024, timeoutMs: 60_000,
  },
  {
    metodo: 'POST', caminho: '/api/operadores/retomar-rodizio', servico: 'rodizio', destino: '/operadores/retomar-rodizio',
    nome: 'retomar o rodízio da URA', comQuem: true, limiteBytes: 1024, timeoutMs: 60_000,
  },
  // [NOVO] ações por atendente na aba Receptivo (ramal no corpo); a lista de pausas é só leitura
  { metodo: 'POST', caminho: '/api/operadores/pausas', servico: 'rodizio', destino: '/operadores/pausas', limiteBytes: 1024, timeoutMs: 15_000 },
  ...[
    ['pausar', 'pausar um atendente'],
    ['sair-pausa', 'tirar um atendente da pausa'],
    ['ficar-disponivel', 'deixar um atendente disponível'],
    ['deslogar', 'deslogar um atendente'],
    ['mover', 'mudar um atendente de grupo (Ativo/URA)'],
    ['liberar', 'liberar um atendente para o rodízio'],
  ].map(([rota, nome]) => ({
    metodo: 'POST', caminho: `/api/operadores/${rota}`, servico: 'rodizio', destino: `/operadores/${rota}`,
    nome, comQuem: true, limiteBytes: 1024, timeoutMs: 15_000,
  })),
  { metodo: 'POST', caminho: '/api/rodizio/ura/cheia', servico: 'rodizio', destino: '/ura/cheia', nome: 'ligar a URA cheia' },
  { metodo: 'DELETE', caminho: '/api/rodizio/ura/cheia', servico: 'rodizio', destino: '/ura/cheia', nome: 'desligar a URA cheia' },
  { metodo: 'POST', caminho: '/api/rodizio/risco/desligar', servico: 'robos', destino: '/risco/desligar', nome: 'ligar "desligar robôs com cliente de risco"' },
  { metodo: 'DELETE', caminho: '/api/rodizio/risco/desligar', servico: 'robos', destino: '/risco/desligar', nome: 'desligar "desligar robôs com cliente de risco"' },
  { metodo: 'GET', caminho: '/api/rodizio/perfis/risco', servico: 'robos', destino: '/perfis/risco' },
  // [NOVO] webhook de transferências para clientes (só administrador; o cliente também se cadastra por API)
  { metodo: 'GET', caminho: '/api/webhooks/clientes', servico: 'rodizio', destino: '/webhooks/clientes', papel: 'administrador' },
  { metodo: 'POST', caminho: '/api/webhooks/clientes', servico: 'rodizio', destino: '/webhooks/clientes', nome: 'cadastrar um cliente do webhook', papel: 'administrador', limiteBytes: 2048 },
  { metodo: 'POST', caminho: '/api/webhooks/clientes/testar', servico: 'rodizio', destino: '/webhooks/clientes/testar', nome: 'testar o webhook de um cliente', papel: 'administrador', limiteBytes: 1024, timeoutMs: 15_000 },
  { metodo: 'POST', caminho: '/api/webhooks/clientes/remover', servico: 'rodizio', destino: '/webhooks/clientes/remover', nome: 'remover um cliente do webhook', papel: 'administrador', limiteBytes: 1024 },
  { metodo: 'GET', caminho: '/api/roteador/status', servico: 'roteador', destino: '/status' },
  { metodo: 'POST', caminho: '/api/roteador/manual', servico: 'roteador', destino: '/manual', nome: 'colar a esteira', limiteBytes: 10 * 1024 * 1024 },
  { metodo: 'DELETE', caminho: '/api/roteador/manual', servico: 'roteador', destino: '/manual', nome: 'apagar as esteiras coladas' },
  { metodo: 'POST', caminho: '/api/roteador/recarregar', servico: 'roteador', destino: '/recarregar', nome: 'recarregar as vendas' },
]);

const NOMES = Object.freeze({
  roteador: 'Roteador de vendas', rodizio: 'Rodízio e robôs', robos: 'Robôs da URA', rotinas: 'Rotinas do dia', atualizador: 'Atualizador automático',
});

/** [NOVO] Do /health do benura-robos, o que a tela lê no do rodízio (assim ela não muda). */
const CAMPOS_DOS_ROBOS = ['robos', 'panico', 'ajusteRobos', 'ultimoLivreSaindo', 'gruposRobos', 'gruposRobosDisponiveis', 'grupoRobos'];

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
  /** [NOVO] O benura-robos está na config (ROBOS_SERVICO_PROPRIO=true)? */
  robosSeparados() {
    return Boolean(this.cfg.servicos.robos);
  }

  /** [NOVO] Nome de cada serviço para a tela: com os robôs separados, o rodízio é o "de pessoas". */
  nome(servico) {
    if (servico === 'rodizio' && this.robosSeparados()) return 'Rodízio de pessoas';
    return NOMES[servico] ?? servico;
  }

  async chamar(pedido, caminho, { metodo = 'GET', corpo, timeoutMs = this.cfg.timeoutMs } = {}) {
    const servico = pedido === 'robos' && !this.robosSeparados() ? 'rodizio' : pedido;
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
        json = { erro: `Resposta inesperada do ${this.nome(servico)} (HTTP ${resposta.status})` };
      }
      return { status: resposta.status, corpo: json, ms: Date.now() - inicio };
    } catch (e) {
      const motivo = e.name === 'TimeoutError' ? 'não respondeu a tempo' : 'fora do ar';
      // [NOVO] o que fazer: o log do serviço no PM2 diz por que ele caiu
      return { status: 0, corpo: { erro: `${this.nome(servico)} ${motivo}. No PC do BenURA: npx pm2 logs benura-${servico}` }, ms: Date.now() - inicio };
    }
  }

  /** /health de todos, em paralelo. @returns {Promise<Record<string, { nome, online, ms, dados }>>} */
  async saude() {
    const nomes = Object.keys(this.cfg.servicos);
    const respostas = await Promise.all(nomes.map((s) => this.chamar(s, '/health')));
    const saude = Object.fromEntries(nomes.map((s, i) => {
      const r = respostas[i];
      return [s, { nome: this.nome(s), online: r.status >= 200 && r.status < 300, ms: r.ms, dados: r.status === 200 ? r.corpo : null }];
    }));
    juntarRobosNoRodizio(saude);
    return saude;
  }
}

/**
 * [NOVO] A tela (e os alertas) leem os robôs no /health do rodízio: com o benura-robos no ar, valem os
 * dele (o rodízio de pessoas só tem o espelho da última resposta).
 */
function juntarRobosNoRodizio(saude) {
  const robos = saude.robos?.online && saude.robos.dados?.papel === 'robos' ? saude.robos.dados : null;
  const rodizio = saude.rodizio?.dados;
  if (!robos || !rodizio) return;
  for (const campo of CAMPOS_DOS_ROBOS) if (robos[campo] !== undefined) rodizio[campo] = robos[campo];
}

module.exports = { Servicos, ACOES, NOMES };

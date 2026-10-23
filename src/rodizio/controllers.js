'use strict';
/**
 * Rotas HTTP do rodízio: saúde, webhooks da Argus, modo manual dos robôs, pânico e URA cheia.
 *
 * Um único endereço recebe todos os webhooks configurados na Argus e os
 * distribui: início de atendimento → rodízio; encerramento de URA → retorno da fila e,
 * se o cliente desistiu na fila (callback), ajuste dos robôs por livre.
 */

const { interpretarWebhook, interpretarCallback, interpretarEncerramentoUra } = require('../domain/rodizio');
const { PAGINA_URA } = require('./pagina-ura');
const { AcaoRecusada } = require('./acoes-operador');

/**
 * @param {object} deps
 * @param {import('./rodizio.service').RodizioService} deps.rodizio
 * @param {import('../retorno-fila/retorno-fila.service').RetornoFilaService} [deps.retornoFila]
 * @param {{ ultimoCicloUra(): number, ultimoCicloAtivo(): number }} deps.ciclos
 * @param {import('./acoes-operador').AcoesOperador} [deps.acoes] - [NOVO] ações por atendente (aba Receptivo)
 * @param {object} deps.logger
 */
function criarRotasDoRodizio({ rodizio, retornoFila, risco = null, acoes = null, ciclos, logger }) {
  async function health() {
    return {
      status: 200,
      corpo: {
        // Campos do script original (monitoramentos existentes continuam funcionando)
        lastLoopUra: ciclos.ultimoCicloUra(),
        lastLoopAtivo: ciclos.ultimoCicloAtivo(),
        uptime: process.uptime(),
        ...rodizio.resumo(),
      },
    };
  }

  /** Início de atendimento de um operador → rodízio (URA e robôs). */
  function encaminharAoRodizio(corpo) {
    const evento = interpretarWebhook(corpo);
    if (evento) rodizio.registrarAtendimento(evento.ramal);
  }

  /** Cliente desistiu da fila (callback) → ajuste dos robôs por livre. */
  function encaminharCallback(corpo) {
    const callback = interpretarCallback(corpo);
    if (callback) rodizio.registrarCallback(callback);
  }

  /** [NOVO] Ligação da URA terminou (webhooks 4 e 5) → leads derivados e transbordos do dia. */
  function encaminharEncerramento(corpo) {
    const encerramento = interpretarEncerramentoUra(corpo);
    if (encerramento) rodizio.registrarEncerramentoUra(encerramento);
  }

  /** Encerramento de URA → retorno da fila. Não bloqueia a resposta à Argus. */
  function encaminharAoRetorno(corpo) {
    if (!retornoFila) return;
    retornoFila.processar(corpo).catch((e) => logger.erro(`Retorno da fila falhou: ${e.message}`));
  }

  async function webhook({ corpo }) {
    logger.debug(`Webhook recebido (tipo ${corpo?.idTipoWebhook ?? '?'}).`);
    rodizio.registrarWebhookRecebido();
    encaminharAoRodizio(corpo);
    encaminharCallback(corpo);
    encaminharEncerramento(corpo);
    encaminharAoRetorno(corpo);
    return { status: 200, corpo: { ok: true } };
  }

  /** POST /robos/manual { minutos } — a supervisão assume os robôs pelo painel. */
  async function robosManual({ corpo }) {
    const minutos = Number(corpo?.minutos ?? 30);
    if (!(minutos > 0 && minutos <= 600)) return { status: 400, corpo: { erro: 'minutos deve estar entre 1 e 600' } };
    const ate = rodizio.assumirRobosManualmente(minutos);
    return { status: 200, corpo: { manualAte: new Date(ate).toISOString() } };
  }

  /** POST /robos/automatico — o BenURA volta a comandar os robôs. */
  async function robosAutomatico() {
    rodizio.devolverRobosAoBenura();
    return { status: 200, corpo: { manualAte: null } };
  }

  /** POST /robos/por-livre { valor } — a supervisão ajusta os robôs por livre na hora. */
  async function robosPorLivre({ corpo }) {
    const valor = Number(corpo?.valor);
    if (!Number.isFinite(valor) || valor < 1 || valor > 100) return { status: 400, corpo: { erro: 'valor deve ser um número entre 1 e 100' } };
    return { status: 200, corpo: rodizio.definirRobosPorLivre(valor) };
  }

  /** GET /ura — página para ligar/desligar a URA cheia e ajustar os robôs por livre. */
  async function paginaUra() {
    return { status: 200, html: PAGINA_URA };
  }

  /** POST /ura/cheia — quem atender no Ativo sobe, sem olhar elegíveis (a regra do ocioso continua valendo). */
  async function ligarUraCheia() {
    try {
      return { status: 200, corpo: rodizio.ligarUraCheia() };
    } catch (e) {
      return { status: 409, corpo: { erro: e.message } };
    }
  }

  /** DELETE /ura/cheia — o rodízio volta ao normal. */
  async function desligarUraCheia() {
    return { status: 200, corpo: rodizio.desligarUraCheia() };
  }

  /** POST /panico — liga a regra de pânico (com 1 livre ou menos, desliga os robôs). */
  async function ligarPanico() {
    return { status: 200, corpo: rodizio.definirPanico(true) };
  }

  /** DELETE /panico — desliga a regra de pânico (o BenURA não mexe nos robôs). */
  async function desligarPanico() {
    return { status: 200, corpo: rodizio.definirPanico(false) };
  }

  /** POST /ura/passiva — URA passiva hoje: com 1 fixo livre, os robôs seguem até ele atender. */
  async function ligarUraPassiva() {
    return { status: 200, corpo: rodizio.definirUraPassiva(true) };
  }

  /** DELETE /ura/passiva — 1 fixo livre volta a desligar os robôs parados na hora. */
  async function desligarUraPassiva() {
    return { status: 200, corpo: rodizio.definirUraPassiva(false) };
  }

  /** [NOVO] PUT /ura/status { status, modo, por? } — fixa o status da URA (manual) ou volta ao termômetro (automatico). */
  async function definirStatusUra({ corpo }) {
    try {
      return { status: 200, corpo: rodizio.definirStatusUra({ status: corpo?.status, modo: corpo?.modo }, quem(corpo)) };
    } catch (e) {
      return { status: 400, corpo: { erro: e.message } };
    }
  }

  /** [NOVO] GET /metricas/hoje — leads derivados e transbordos do dia (webhooks 4 e 5 da Argus). */
  async function metricasHoje() {
    return { status: 200, corpo: rodizio.metricasHoje() };
  }

  /** [NOVO] POST /operadores/transferir-ura-ativo { por? } — humanos da URA, menos os fixos, para o Ativo. */
  async function transferirUraAtivo({ corpo }) {
    return { status: 200, corpo: await rodizio.transferirUraParaAtivo(quem(corpo)) };
  }

  /** [NOVO] POST /operadores/retomar-rodizio { por? } — fim do "todos no Ativo": quem vendeu volta para a URA na hora. */
  async function retomarRodizio({ corpo }) {
    return { status: 200, corpo: await rodizio.retomarRodizio(quem(corpo)) };
  }

  /**
   * [NOVO] Ações por atendente (aba Receptivo): pausar, sair da pausa, ficar disponível,
   * deslogar, mover Ativo ↔ URA (com trava) e liberar a trava. Ramal no corpo.
   * Pedido inválido → 400; recusa da Argus ou mover que não deu → 409; Argus fora → 502.
   */
  const acao = (fn) => async ({ corpo }) => {
    if (!acoes) return { status: 404, corpo: { erro: 'ações por atendente indisponíveis' } };
    try {
      return { status: 200, corpo: await fn(corpo || {}) };
    } catch (e) {
      if (e instanceof AcaoRecusada) return { status: e.status, corpo: { erro: e.message } };
      logger.erro(`Ação por atendente falhou: ${e.message}`);
      return { status: 502, corpo: { erro: `a Argus não respondeu: ${e.message}` } };
    }
  };
  const pausasDisponiveis = acao(async (c) => ({ pausas: await acoes.pausasDisponiveis(c.ramal) }));
  const pausar = acao((c) => acoes.pausar(c.ramal, c.idPausa, quem(c)));
  const sairPausa = acao((c) => acoes.sairPausa(c.ramal, quem(c)));
  const ficarDisponivel = acao((c) => acoes.ficarDisponivel(c.ramal, quem(c)));
  const deslogar = acao((c) => acoes.deslogar(c.ramal, quem(c)));
  const mover = acao((c) => acoes.mover(c.ramal, c.para, quem(c)));
  const liberar = acao((c) => acoes.liberar(c.ramal, quem(c)));

  /** [NOVO] PUT /robos/modo { modo: automatico|panico|desligados } — o modo dos robôs, escolhido no painel. */
  async function definirModoRobos({ corpo }) {
    try {
      return { status: 200, corpo: rodizio.definirModoRobos(corpo?.modo, quem(corpo)) };
    } catch (e) {
      return { status: 400, corpo: { erro: e.message } };
    }
  }

  /** Quem pediu (o painel manda o e-mail/IP da supervisão); só texto curto, vai para o log. */
  const quem = (corpo) => (typeof corpo?.por === 'string' ? corpo.por.slice(0, 120) : null);

  /** POST /automacao/encerrar-robos { derrubar? } — o painel está desligando a automação. */
  async function encerrarRobos({ corpo }) {
    return { status: 200, corpo: await rodizio.encerrarRobosParaDesligar({ derrubar: corpo?.derrubar === true }) };
  }

  /** GET /alertas — clientes de risco falando com um robô agora (telefone mascarado). */
  async function alertas() {
    if (!risco) return { status: 200, corpo: { ativo: false, alertas: [] } };
    return {
      status: 200,
      corpo: { ativo: true, alertas: risco.vigia.listar(), desligaRobos: risco.desligaRobos.resumo(), perfis: risco.perfis.resumo() },
    };
  }

  /** GET /perfis/risco — os clientes de risco (mais callbacks primeiro), telefone mascarado. */
  async function perfisDeRisco() {
    return { status: 200, corpo: { clientes: risco ? risco.perfis.maisArriscados(20) : [] } };
  }

  /** POST/DELETE /risco/desligar — desligar (ou não) os robôs quando um cliente de risco estiver em ligação. */
  const definirDesligaRobos = (ligado) => async () => {
    if (!risco) return { status: 404, corpo: { erro: 'perfis de clientes desligados (PERFIS_ATIVO=0)' } };
    const mudou = risco.desligaRobos.definir(ligado);
    return { status: 200, corpo: { ...risco.desligaRobos.resumo(), mudou } };
  };

  return [
    { metodo: 'GET', caminho: '/health', handler: health },
    { metodo: 'GET', caminho: '/alertas', handler: alertas },
    { metodo: 'GET', caminho: '/perfis/risco', handler: perfisDeRisco },
    { metodo: 'POST', caminho: '/risco/desligar', handler: definirDesligaRobos(true), protegida: true },
    { metodo: 'DELETE', caminho: '/risco/desligar', handler: definirDesligaRobos(false), protegida: true },
    { metodo: 'POST', caminho: '/panico', handler: ligarPanico, protegida: true },
    { metodo: 'POST', caminho: '/automacao/encerrar-robos', handler: encerrarRobos, protegida: true },
    { metodo: 'DELETE', caminho: '/panico', handler: desligarPanico, protegida: true },
    { metodo: 'POST', caminho: '/ura/passiva', handler: ligarUraPassiva, protegida: true },
    { metodo: 'DELETE', caminho: '/ura/passiva', handler: desligarUraPassiva, protegida: true },
    { metodo: 'PUT', caminho: '/ura/status', handler: definirStatusUra, protegida: true },
    { metodo: 'GET', caminho: '/metricas/hoje', handler: metricasHoje },
    { metodo: 'POST', caminho: '/operadores/transferir-ura-ativo', handler: transferirUraAtivo, protegida: true },
    { metodo: 'POST', caminho: '/operadores/retomar-rodizio', handler: retomarRodizio, protegida: true },
    { metodo: 'POST', caminho: '/operadores/pausas', handler: pausasDisponiveis, protegida: true },
    { metodo: 'POST', caminho: '/operadores/pausar', handler: pausar, protegida: true },
    { metodo: 'POST', caminho: '/operadores/sair-pausa', handler: sairPausa, protegida: true },
    { metodo: 'POST', caminho: '/operadores/ficar-disponivel', handler: ficarDisponivel, protegida: true },
    { metodo: 'POST', caminho: '/operadores/deslogar', handler: deslogar, protegida: true },
    { metodo: 'POST', caminho: '/operadores/mover', handler: mover, protegida: true },
    { metodo: 'POST', caminho: '/operadores/liberar', handler: liberar, protegida: true },
    { metodo: 'GET', caminho: '/ura', handler: paginaUra },
    { metodo: 'POST', caminho: '/ura/cheia', handler: ligarUraCheia, protegida: true },
    { metodo: 'DELETE', caminho: '/ura/cheia', handler: desligarUraCheia, protegida: true },
    { metodo: 'POST', caminho: '/webhook', handler: webhook, protegida: true, prefixo: true },
    { metodo: 'POST', caminho: '/robos/manual', handler: robosManual, protegida: true },
    { metodo: 'PUT', caminho: '/robos/modo', handler: definirModoRobos, protegida: true },
    { metodo: 'POST', caminho: '/robos/automatico', handler: robosAutomatico, protegida: true },
    { metodo: 'POST', caminho: '/robos/por-livre', handler: robosPorLivre, protegida: true },
  ];
}

module.exports = { criarRotasDoRodizio };

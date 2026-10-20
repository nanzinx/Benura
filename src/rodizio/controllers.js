'use strict';
/**
 * Rotas HTTP do rodízio: saúde, webhooks da Argus, modo manual dos robôs, pânico e URA cheia.
 *
 * Um único endereço recebe todos os webhooks configurados na Argus e os
 * distribui: início de atendimento → rodízio; encerramento de URA → retorno da fila e,
 * se o cliente desistiu na fila (callback), ajuste dos robôs por livre.
 */

const { interpretarWebhook, interpretarCallback } = require('../domain/rodizio');
const { PAGINA_URA } = require('./pagina-ura');

/**
 * @param {object} deps
 * @param {import('./rodizio.service').RodizioService} deps.rodizio
 * @param {import('../retorno-fila/retorno-fila.service').RetornoFilaService} [deps.retornoFila]
 * @param {{ ultimoCicloUra(): number, ultimoCicloAtivo(): number }} deps.ciclos
 * @param {object} deps.logger
 */
function criarRotasDoRodizio({ rodizio, retornoFila, risco = null, ciclos, logger }) {
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

  /** POST /ura/cheia — todos do Ativo para a URA (a regra do ocioso continua valendo). */
  async function ligarUraCheia() {
    return { status: 200, corpo: rodizio.ligarUraCheia() };
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
    { metodo: 'DELETE', caminho: '/panico', handler: desligarPanico, protegida: true },
    { metodo: 'GET', caminho: '/ura', handler: paginaUra },
    { metodo: 'POST', caminho: '/ura/cheia', handler: ligarUraCheia, protegida: true },
    { metodo: 'DELETE', caminho: '/ura/cheia', handler: desligarUraCheia, protegida: true },
    { metodo: 'POST', caminho: '/webhook', handler: webhook, protegida: true, prefixo: true },
    { metodo: 'POST', caminho: '/robos/manual', handler: robosManual, protegida: true },
    { metodo: 'POST', caminho: '/robos/automatico', handler: robosAutomatico, protegida: true },
    { metodo: 'POST', caminho: '/robos/por-livre', handler: robosPorLivre, protegida: true },
  ];
}

module.exports = { criarRotasDoRodizio };

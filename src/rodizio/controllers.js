'use strict';
/**
 * Rotas HTTP do rodízio: saúde, webhooks da Argus, modo manual dos robôs e URA cheia.
 *
 * Um único endereço recebe todos os webhooks configurados na Argus e os
 * distribui: início de atendimento → rodízio; encerramento de URA → retorno da fila.
 */

const { interpretarWebhook } = require('../domain/rodizio');
const { PAGINA_URA } = require('./pagina-ura');

/**
 * @param {object} deps
 * @param {import('./rodizio.service').RodizioService} deps.rodizio
 * @param {import('../retorno-fila/retorno-fila.service').RetornoFilaService} [deps.retornoFila]
 * @param {{ ultimoCicloUra(): number, ultimoCicloAtivo(): number }} deps.ciclos
 * @param {object} deps.logger
 */
function criarRotasDoRodizio({ rodizio, retornoFila, ciclos, logger }) {
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

  /** Encerramento de URA → retorno da fila. Não bloqueia a resposta à Argus. */
  function encaminharAoRetorno(corpo) {
    if (!retornoFila) return;
    retornoFila.processar(corpo).catch((e) => logger.erro(`Retorno da fila falhou: ${e.message}`));
  }

  async function webhook({ corpo }) {
    logger.debug(`Webhook recebido (tipo ${corpo?.idTipoWebhook ?? '?'}).`);
    rodizio.registrarWebhookRecebido();
    encaminharAoRodizio(corpo);
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

  /** GET /ura — página para ligar/desligar a URA cheia. */
  async function paginaUra() {
    return { status: 200, html: PAGINA_URA };
  }

  /** POST /ura/cheia — todos do Ativo para a URA; ninguém volta por ocioso. */
  async function ligarUraCheia() {
    return { status: 200, corpo: rodizio.ligarUraCheia() };
  }

  /** DELETE /ura/cheia — o rodízio volta ao normal. */
  async function desligarUraCheia() {
    return { status: 200, corpo: rodizio.desligarUraCheia() };
  }

  return [
    { metodo: 'GET', caminho: '/health', handler: health },
    { metodo: 'GET', caminho: '/ura', handler: paginaUra },
    { metodo: 'POST', caminho: '/ura/cheia', handler: ligarUraCheia, protegida: true },
    { metodo: 'DELETE', caminho: '/ura/cheia', handler: desligarUraCheia, protegida: true },
    { metodo: 'POST', caminho: '/webhook', handler: webhook, protegida: true, prefixo: true },
    { metodo: 'POST', caminho: '/robos/manual', handler: robosManual, protegida: true },
    { metodo: 'POST', caminho: '/robos/automatico', handler: robosAutomatico, protegida: true },
  ];
}

module.exports = { criarRotasDoRodizio };

'use strict';
/**
 * Controladores HTTP: traduzem requisições em chamadas ao RoteamentoService.
 * Não contêm regra de negócio.
 */

const { EsteiraInvalidaError, resumoDaEsteira, formatarDia } = require('../domain/esteira-manual');
const { PAGINA_MANUAL } = require('./pagina-manual');

/** Esteira com cabeçalho errado é erro de quem colou (422), não do servidor. */
function esteiraInvalidaComo422(e) {
  if (e instanceof EsteiraInvalidaError) return { status: 422, corpo: { erro: e.message } };
  throw e;
}

/**
 * @param {object} deps
 * @param {import('../services/roteamento.service').RoteamentoService} deps.roteamento
 * @param {import('../integrations/carrossel/esteira-manual.repository').EsteiraManualRepository} [deps.esteira]
 * @param {{ hoje(): string }} [deps.relogio]
 * @param {number} [deps.metaDiaria]
 * @param {object} deps.logger
 */
function criarControllers({ roteamento, esteira, relogio, metaDiaria, logger }) {
  /** Guarda a esteira e devolve o que ela vai decidir hoje. */
  async function guardarEsteira(texto) {
    const hoje = relogio.hoje();
    const { dias, vendas, ignoradas } = await esteira.colar(texto, hoje);
    const resumo = resumoDaEsteira(esteira.dias(), hoje, metaDiaria);
    logger.info(`Esteira colada: ${vendas} venda(s) de ${dias.map(formatarDia).join(', ')}; dia anterior ${resumo.diaAnterior || 'não encontrado'}.`);
    return { status: 200, corpo: { diasColados: dias.map(formatarDia), vendas, ignoradas, hoje: formatarDia(hoje), metaDiaria, ...resumo } };
  }

  return {
    /** GET /manual — página para colar a esteira quando o Carrossel cai. */
    async paginaManual() {
      return { status: 200, html: PAGINA_MANUAL };
    },

    /** POST /manual — { texto }: esteira colada (CSV com ";" ou tabela com TAB). */
    async colarEsteira({ corpo }) {
      if (typeof corpo?.texto !== 'string') return { status: 400, corpo: { erro: 'Envie { "texto": "<esteira colada>" }' } };
      return guardarEsteira(corpo.texto).catch(esteiraInvalidaComo422);
    },

    /** DELETE /manual — apaga todas as esteiras coladas. */
    async limparEsteira() {
      const apagados = await esteira.limpar();
      logger.info(`Esteiras coladas apagadas (${apagados} dia(s)).`);
      return { status: 200, corpo: { apagados } };
    },

    /** GET /health */
    async health() {
      return {
        status: 200,
        corpo: {
          status: 'ok',
          uptime: Math.round(process.uptime()),
          cargaInicialFeita: roteamento.cargaInicialFeitaHoje(),
          ultimoMonitoramento: roteamento.ultimoMonitoramento,
        },
      };
    },

    /** GET /status */
    async status() {
      return { status: 200, corpo: roteamento.resumo() };
    },

    /** POST /recarregar — executa a carga inicial em segundo plano. */
    async recarregar() {
      logger.info('Recarga manual solicitada via API.');
      roteamento.executarCargaInicial().catch((e) => logger.erro(`Recarga manual falhou: ${e.message}`));
      return { status: 202, corpo: { mensagem: 'Recarga iniciada' } };
    },

    /** POST /webhook/venda — { ramal, valor, vendedor? } */
    async webhookVenda({ corpo }) {
      if (!corpo || typeof corpo !== 'object') {
        return { status: 400, corpo: { erro: 'Corpo JSON obrigatório: { ramal, valor }' } };
      }
      const resultado = await roteamento.registrarVenda(corpo);
      return { status: resultado.aceito ? 200 : 422, corpo: resultado };
    },
  };
}

module.exports = { criarControllers };

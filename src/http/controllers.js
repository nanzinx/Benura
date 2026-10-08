'use strict';
/**
 * Controladores HTTP: traduzem requisições em chamadas ao RoteamentoService.
 * Não contêm regra de negócio.
 */

/**
 * @param {object} deps
 * @param {import('../services/roteamento.service').RoteamentoService} deps.roteamento
 * @param {object} deps.logger
 */
function criarControllers({ roteamento, logger }) {
  return {
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

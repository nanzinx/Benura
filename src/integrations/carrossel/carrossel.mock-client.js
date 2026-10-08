'use strict';
/**
 * Cliente falso do Carrossel para desenvolvimento (USAR_MOCK=1).
 * Mesma interface do CarrosselClient, sem rede.
 */

const VENDEDORES = [
  { id: 1, nome: 'Ana Clara Souza', ramal: '1001', equipe: 'Equipe Alpha', ontem: 72500 },
  { id: 2, nome: 'Carlos Eduardo Lima', ramal: '1002', equipe: 'Equipe Alpha', ontem: 55300 },
  { id: 3, nome: 'Mariana Ferreira Costa', ramal: '1003', equipe: 'Equipe Beta', ontem: 98100 },
  { id: 4, nome: 'Ricardo Mendes', ramal: '1004', equipe: 'Equipe Beta', ontem: 32000 },
  { id: 5, nome: 'Juliana Alves', ramal: '1005', equipe: 'Equipe Alpha', ontem: 15800 },
  { id: 6, nome: 'Fernando Ribeiro', ramal: '1006', equipe: 'Equipe Gamma', ontem: 48900 },
  { id: 7, nome: 'Patrícia Santos', ramal: '1007', equipe: 'Equipe Gamma', ontem: 0 },
  { id: 8, nome: 'Diego Oliveira', ramal: '1008', equipe: 'Equipe Beta', ontem: 50000 },
];

// Vendas simuladas ao longo do dia: { ramal, valor, aposMs }
const VENDAS_SIMULADAS = [
  { ramal: '1004', valor: 12500, aposMs: 2 * 60_000 },
  { ramal: '1005', valor: 3200, aposMs: 5 * 60_000 },
];

class CarrosselMockClient {
  constructor({ obterHoje }, logger) {
    this.obterHoje = obterHoje;
    this.log = logger;
    this.inicio = Date.now();
  }

  async buscarVendasPorData(data) {
    const ehHoje = data === this.obterHoje();
    const decorrido = Date.now() - this.inicio;
    this.log.debug(`[MOCK] buscarVendasPorData(${data})`);

    return {
      success: true,
      data: VENDEDORES.map(({ ontem, ...v }) => ({
        ...v,
        total_vendas: ehHoje
          ? VENDAS_SIMULADAS.filter((s) => s.ramal === v.ramal && decorrido >= s.aposMs)
            .reduce((soma, s) => soma + s.valor, 0)
          : ontem,
      })),
    };
  }
}

module.exports = { CarrosselMockClient };

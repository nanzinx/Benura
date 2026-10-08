'use strict';
/**
 * Cliente falso do Carrossel para desenvolvimento (USAR_MOCK=1).
 * Mesma interface e mesmo formato de resposta do CarrosselClient real,
 * sem rede. Os nomes batem com `vendedores-ramais.example.json`.
 */

const VENDEDORES = [
  { nome: 'ANA CLARA SOUZA', equipe: 'Equipe Alpha', ontem: 72500 },
  { nome: 'CARLOS EDUARDO LIMA', equipe: 'Equipe Alpha', ontem: 55300 },
  { nome: 'MARIANA FERREIRA COSTA', equipe: 'Equipe Beta', ontem: 98100 },
  { nome: 'RICARDO MENDES', equipe: 'Equipe Beta', ontem: 32000 },
  { nome: 'JULIANA ALVES', equipe: 'Equipe Alpha', ontem: 15800 },
  { nome: 'FERNANDO RIBEIRO', equipe: 'Equipe Gamma', ontem: 48900 },
  // Patrícia Santos não vendeu ontem: como no Carrossel real, não aparece na lista.
  { nome: 'DIEGO OLIVEIRA', equipe: 'Equipe Beta', ontem: 50000 },
];

// Vendas simuladas ao longo do dia: { nome, valor, aposMs }
const VENDAS_SIMULADAS = [
  { nome: 'RICARDO MENDES', valor: 12500, aposMs: 2 * 60_000 },
  { nome: 'JULIANA ALVES', valor: 3200, aposMs: 5 * 60_000 },
];

const vendedorCarrossel = (nome, equipe, valor) => ({
  nome,
  performance: [
    { Equipe: 'GERAL', Integrado: 0, vendaGeral: valor, vendaConcluida: valor, vendaPendente: 0 },
    { Equipe: equipe, Integrado: 0, vendaGeral: valor, vendaConcluida: valor, vendaPendente: 0 },
  ],
});

/** Monta uma resposta no formato de GET /ranking/vendedores. */
function montarRanking(decorridoMs) {
  const hoje = VENDEDORES
    .map((v) => {
      const total = VENDAS_SIMULADAS
        .filter((s) => s.nome === v.nome && decorridoMs >= s.aposMs)
        .reduce((soma, s) => soma + s.valor, 0);
      return total > 0 ? vendedorCarrossel(v.nome, v.equipe, total) : null;
    })
    .filter(Boolean);

  return {
    hoje,
    ontem: VENDEDORES.filter((v) => v.ontem > 0).map((v) => vendedorCarrossel(v.nome, v.equipe, v.ontem)),
    semanal: [],
    mensal: [],
    ultimaExtracao: new Date().toLocaleString('pt-BR'),
    diaOntem: null,
  };
}

class CarrosselMockClient {
  constructor(logger) {
    this.log = logger;
    this.inicio = Date.now();
  }

  async buscarRankingVendedores() {
    this.log.debug('[MOCK] buscarRankingVendedores()');
    return montarRanking(Date.now() - this.inicio);
  }
}

module.exports = { CarrosselMockClient, montarRanking };

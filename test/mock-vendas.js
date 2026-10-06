'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MOCK SERVER — Simula tanto a API de Vendas quanto a API Argus
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Este servidor simula:
 *  1. API do Site de Vendas (GET /api/vendedores, GET /api/vendedores/:ramal/vendas-hoje)
 *  2. API da Discadora Argus (POST /apiargus/cmd/transferiroperadorgrupo)
 *
 *  Use para testar o roteador-vendas.js sem precisar das APIs reais.
 *
 *  COMO USAR:
 *    1. Inicie este mock:     node test/mock-vendas.js
 *    2. Em outro terminal:    USAR_MOCK=0 ARGUS_BASE=http://localhost:8081/apiargus/cmd \
 *                             SITE_VENDAS_URL=http://localhost:8081/api \
 *                             DRY_RUN=0 DEBUG=1 node roteador-vendas.js
 *
 *  Porta padrão: 8081
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8081);

// ── Dados mockados de vendedores ──
const vendedoresOntem = [
  { id: 1, nome: 'Ana Clara Souza',         ramal: '1001', equipe: 'Equipe Alpha', total_vendas: 72500.00 },
  { id: 2, nome: 'Carlos Eduardo Lima',     ramal: '1002', equipe: 'Equipe Alpha', total_vendas: 55300.00 },
  { id: 3, nome: 'Mariana Ferreira Costa',  ramal: '1003', equipe: 'Equipe Beta',  total_vendas: 98100.00 },
  { id: 4, nome: 'Ricardo Mendes',          ramal: '1004', equipe: 'Equipe Beta',  total_vendas: 32000.00 },
  { id: 5, nome: 'Juliana Alves',           ramal: '1005', equipe: 'Equipe Alpha', total_vendas: 15800.00 },
  { id: 6, nome: 'Fernando Ribeiro',        ramal: '1006', equipe: 'Equipe Gamma', total_vendas: 48900.00 },
  { id: 7, nome: 'Patrícia Santos',         ramal: '1007', equipe: 'Equipe Gamma', total_vendas: 0 },
  { id: 8, nome: 'Diego Oliveira',          ramal: '1008', equipe: 'Equipe Beta',  total_vendas: 50000.00 },
];

// Simula vendas acontecendo ao longo do dia
const vendasHoje = {};
const inicio = Date.now();

// Ricardo faz uma venda após 2 minutos
setTimeout(() => {
  vendasHoje['1004'] = 12500.00;
  console.log(`[MOCK] 💰 Venda simulada: Ricardo Mendes (1004) → R$ 12.500,00`);
}, 120000);

// Juliana faz uma venda após 5 minutos
setTimeout(() => {
  vendasHoje['1005'] = 3200.00;
  console.log(`[MOCK] 💰 Venda simulada: Juliana Alves (1005) → R$ 3.200,00`);
}, 300000);

// Registro de transferências realizadas (para verificação)
const transferencias = [];

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = '';

  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');

    // ══════════════════════════════════════════════════════════
    // API de Vendas — GET /api/vendedores?data=YYYY-MM-DD
    // ══════════════════════════════════════════════════════════
    if (url.pathname === '/api/vendedores' && req.method === 'GET') {
      const data = url.searchParams.get('data');
      console.log(`[MOCK] GET /api/vendedores?data=${data}`);

      // Retorna vendedores com vendas do dia solicitado
      const hoje = new Date().toISOString().split('T')[0];
      const dados = vendedoresOntem.map(v => ({
        ...v,
        total_vendas: data === hoje ? (vendasHoje[v.ramal] || 0) : v.total_vendas,
      }));

      res.writeHead(200);
      return res.end(JSON.stringify({ success: true, data: dados }));
    }

    // ══════════════════════════════════════════════════════════
    // API de Vendas — GET /api/vendedores/:ramal/vendas-hoje
    // ══════════════════════════════════════════════════════════
    const matchVendasHoje = url.pathname.match(/^\/api\/vendedores\/(\d+)\/vendas-hoje$/);
    if (matchVendasHoje && req.method === 'GET') {
      const ramal = matchVendasHoje[1];
      const total = vendasHoje[ramal] || 0;
      console.log(`[MOCK] GET /api/vendedores/${ramal}/vendas-hoje → R$ ${total}`);

      res.writeHead(200);
      return res.end(JSON.stringify({ total_vendas_hoje: total }));
    }

    // ══════════════════════════════════════════════════════════
    // API Argus — POST /apiargus/cmd/transferiroperadorgrupo
    // ══════════════════════════════════════════════════════════
    if (url.pathname.endsWith('transferiroperadorgrupo') && req.method === 'POST') {
      const dados = body ? JSON.parse(body) : {};
      const destino = dados.idGrupoUsuarioDestino === 2 ? 'URA' : 'ATIVO';
      const ramais = dados.ramaisOperadores || [];

      console.log(`[MOCK] ARGUS: Transferindo ${ramais.join(', ')} → ${destino} (grupo ${dados.idGrupoUsuarioDestino})`);

      transferencias.push({
        timestamp: new Date().toISOString(),
        ramais,
        destino,
        grupoId: dados.idGrupoUsuarioDestino,
      });

      res.writeHead(200);
      return res.end(JSON.stringify({ codStatus: 1, qtdeTransferidos: ramais.length }));
    }

    // ══════════════════════════════════════════════════════════
    // Diagnóstico — GET /transferencias (ver tudo que foi feito)
    // ══════════════════════════════════════════════════════════
    if (url.pathname === '/transferencias' && req.method === 'GET') {
      res.writeHead(200);
      return res.end(JSON.stringify(transferencias, null, 2));
    }

    res.writeHead(404);
    res.end(JSON.stringify({ erro: 'Endpoint não encontrado' }));
  });
}).listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  MOCK SERVER rodando em http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Endpoints disponíveis:');
  console.log(`  GET  /api/vendedores?data=YYYY-MM-DD   (vendas do dia)`);
  console.log(`  GET  /api/vendedores/:ramal/vendas-hoje (vendas hoje)`);
  console.log(`  POST /apiargus/cmd/transferiroperadorgrupo`);
  console.log(`  GET  /transferencias                   (log de ações)`);
  console.log('');
  console.log('  Simulação de vendas:');
  console.log('  • Ricardo (1004) vende R$12.500 em 2 min');
  console.log('  • Juliana (1005) vende R$3.200 em 5 min');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});

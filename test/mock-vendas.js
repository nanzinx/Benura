'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MOCK SERVER — Simula tanto a API de Vendas quanto a API Argus
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Este servidor simula:
 *  1. API do Carrossel (GET /ranking/vendedores)
 *  2. API da Discadora Argus (POST /apiargus/cmd/listargrupos, /listarusuarios, /transferiroperadorgrupo)
 *
 *  Use para testar o roteador-vendas.js sem precisar das APIs reais.
 *
 *  COMO USAR:
 *    1. Inicie este mock:     node test/mock-vendas.js
 *    2. Em outro terminal:    ARGUS_TOKEN=mock ARGUS_BASE=http://localhost:8081/apiargus/cmd \
 *                             CARROSSEL_API_URL=http://localhost:8081 \
 *                             GRUPO_URA_ID=2 GRUPOS_ATIVOS_IDS=1,3 \
 *                             DEBUG=1 node roteador-vendas.js
 *
 *  Porta padrão: 8081
 */

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8081);

// ── API do Carrossel: mesmo formato e dados do cliente mock ──
// Ricardo Mendes vende R$ 12.500 após 2 min; Juliana Alves R$ 3.200 após 5 min.
// Os nomes batem com vendedores-ramais.example.json.
const { montarRanking } = require('../src/integrations/carrossel/carrossel.mock-client');
const inicio = Date.now();

// Registro de transferências realizadas (para verificação)
const transferencias = [];

// ── Argus: mesma simulação do cliente mock (src/integrations/argus/argus.mock-client.js) ──
// Grupos: 1 GABRIEL - COMERCIAL e 3 MAYSA - COMERCIAL (Ativo), 2 URA, 9 TREINAMENTO.
// Use GRUPO_URA_ID=2 GRUPOS_ATIVOS_IDS=1,3 no roteador.
const { criarDadosArgus, gruposDe, transferir } = require('../src/integrations/argus/argus.mock-client');
const argus = criarDadosArgus();

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let body = '';

  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');

    // ══════════════════════════════════════════════════════════
    // API do Carrossel — GET /ranking/vendedores
    // ══════════════════════════════════════════════════════════
    if (url.pathname === '/ranking/vendedores' && req.method === 'GET') {
      console.log('[MOCK] GET /ranking/vendedores');
      res.writeHead(200);
      return res.end(JSON.stringify(montarRanking(Date.now() - inicio)));
    }

    // ══════════════════════════════════════════════════════════
    // API Argus — POST /apiargus/cmd/{listargrupos|listarusuarios|transferiroperadorgrupo}
    // ══════════════════════════════════════════════════════════
    if (url.pathname.endsWith('/listargrupos') && req.method === 'POST') {
      res.writeHead(200);
      return res.end(JSON.stringify({ codStatus: 1, grupos: gruposDe(argus) }));
    }

    if (url.pathname.endsWith('/listarusuarios') && req.method === 'POST') {
      res.writeHead(200);
      return res.end(JSON.stringify({ codStatus: 1, usuarios: argus.usuarios }));
    }

    if (url.pathname.endsWith('/transferiroperadorgrupo') && req.method === 'POST') {
      const dados = body ? JSON.parse(body) : {};
      const resposta = transferir(argus, dados);
      console.log(`[MOCK] ARGUS: ${(dados.ramaisOperadores || []).join(', ')} → grupo ${dados.idGrupoUsuarioDestino}`
        + ` (${resposta.qtdeTransferidos} ok, ${resposta.qtdeFalhas} falha)`);
      transferencias.push({ timestamp: new Date().toISOString(), ...dados, resposta });
      res.writeHead(200);
      return res.end(JSON.stringify(resposta));
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
  console.log(`  GET  /ranking/vendedores               (Carrossel)`);
  console.log(`  POST /apiargus/cmd/listargrupos`);
  console.log(`  POST /apiargus/cmd/listarusuarios`);
  console.log(`  POST /apiargus/cmd/transferiroperadorgrupo`);
  console.log(`  GET  /transferencias                   (log de ações)`);
  console.log('');
  console.log('  Simulação de vendas:');
  console.log('  • Ricardo (1004) vende R$12.500 em 2 min');
  console.log('  • Juliana (1005) vende R$3.200 em 5 min');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});

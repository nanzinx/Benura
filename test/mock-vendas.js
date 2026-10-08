'use strict';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MOCK SERVER — Simula tanto a API de Vendas quanto a API Argus
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  Este servidor simula:
 *  1. API do Carrossel (GET /ranking/vendedores)
 *  2. API da Discadora Argus (POST /apiargus/cmd/listargrupos e /transferiroperadorgrupo)
 *
 *  Use para testar o roteador-vendas.js sem precisar das APIs reais.
 *
 *  COMO USAR:
 *    1. Inicie este mock:     node test/mock-vendas.js
 *    2. Em outro terminal:    ARGUS_TOKEN=mock ARGUS_BASE=http://localhost:8081/apiargus/cmd \
 *                             CARROSSEL_API_URL=http://localhost:8081 \
 *                             VENDEDORES_RAMAIS_FILE=vendedores-ramais.example.json \
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

// Grupos da Argus: 1 = Ativo, 2 = URA, 9 = Treinamento (grupo "externo")
// O ramal 1007 começa em Treinamento para simular um ajuste manual.
const grupos = [
  { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['1001', '1002', '1004', '1005', '1006', '1008'] },
  { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['1003'] },
  { idGrupoUsuario: 9, idTipoGrupo: 1, ramaisOperadores: ['1007'] },
];

function moverRamal(ramal, destinoId) {
  for (const g of grupos) g.ramaisOperadores = g.ramaisOperadores.filter((r) => r !== ramal);
  grupos.find((g) => g.idGrupoUsuario === destinoId)?.ramaisOperadores.push(ramal);
}

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
    // API Argus — POST /apiargus/cmd/listargrupos
    // ══════════════════════════════════════════════════════════
    if (url.pathname.endsWith('listargrupos') && req.method === 'POST') {
      res.writeHead(200);
      return res.end(JSON.stringify({ codStatus: 1, grupos }));
    }

    // ══════════════════════════════════════════════════════════
    // API Argus — POST /apiargus/cmd/transferiroperadorgrupo
    // ══════════════════════════════════════════════════════════
    if (url.pathname.endsWith('transferiroperadorgrupo') && req.method === 'POST') {
      const dados = body ? JSON.parse(body) : {};
      const destino = dados.idGrupoUsuarioDestino === 2 ? 'URA' : 'ATIVO';
      const ramais = dados.ramaisOperadores || [];

      console.log(`[MOCK] ARGUS: Transferindo ${ramais.join(', ')} → ${destino} (grupo ${dados.idGrupoUsuarioDestino})`);

      ramais.forEach((r) => moverRamal(String(r), dados.idGrupoUsuarioDestino));
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
  console.log(`  GET  /ranking/vendedores               (Carrossel)`);
  console.log(`  POST /apiargus/cmd/listargrupos`);
  console.log(`  POST /apiargus/cmd/transferiroperadorgrupo`);
  console.log(`  GET  /transferencias                   (log de ações)`);
  console.log('');
  console.log('  Simulação de vendas:');
  console.log('  • Ricardo (1004) vende R$12.500 em 2 min');
  console.log('  • Juliana (1005) vende R$3.200 em 5 min');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});

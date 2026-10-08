#!/usr/bin/env node
'use strict';
/**
 * AUTOMAÇÃO ARGUS — rodízio Ativo ↔ URA + desligamento instantâneo dos robôs
 *
 *  - Ativo → URA: operador do Ativo que atendeu uma ligação e ficou livre vai para a URA.
 *  - URA → Ativo: após TEMPO_MIN (fora de atendimento) ou se ficar offline, volta ao grupo de origem.
 *  - Robôs: desligados quando nenhum humano da URA pode atender; religados quando alguém fica livre.
 *
 * Toda a lógica vive em src/rodizio/ (regras puras em src/domain/rodizio.js).
 * Configuração: mesmas variáveis do script original — veja .env.example.
 */

const { iniciarRodizio } = require('./src/rodizio/app');

iniciarRodizio().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal ao iniciar o rodízio:', e);
  process.exit(1);
});

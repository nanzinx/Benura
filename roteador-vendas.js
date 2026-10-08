#!/usr/bin/env node
'use strict';
/**
 * ROTEADOR DE VENDAS — Integração API do Carrossel ↔ Discadora Argus
 *
 * Ponto de entrada. Toda a lógica vive em ./src:
 *
 *   src/config/                 Configuração (env/.env) e validação
 *   src/integrations/carrossel/ Cliente, mapper e serviço da API do Carrossel
 *   src/integrations/argus/     Cliente da Argus e DiscadoraService (isola a URA)
 *   src/domain/                 Regras de negócio puras
 *   src/repositories/           Persistência do estado diário
 *   src/services/               Casos de uso (roteamento) e agendador
 *   src/http/                   Rotas e controladores
 *
 * Requisitos: Node.js 18+. Veja .env.example para a configuração.
 */

const { iniciar } = require('./src/app');

iniciar().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal ao iniciar:', e);
  process.exit(1);
});

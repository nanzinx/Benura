#!/usr/bin/env node
'use strict';
/**
 * [NOVO] ROBÔS DA URA — serviço próprio (benura-robos, porta ROBOS_PORT, 3004)
 *
 *  - Liga e desliga os robôs: pânico, modo (automático, só pânico, desligados), ajuste, taxa real,
 *    último livre saindo, cliente de risco e o vigia de callbacks com o raio-x.
 *  - A URA vem do retrato que o benura-rodizio manda a cada ciclo (POST /interno/ura). Sem ele (rodízio
 *    de pessoas parado), lê a URA sozinho, só leitura: ninguém é movido.
 *  - Com ROBOS_SERVICO_PROPRIO=false os robôs ficam no benura-rodizio, e este serviço fica parado.
 *
 * Toda a lógica vive em src/rodizio/ (o mesmo RodizioService, no papel "robos": separacao.js).
 */

const { iniciarRobos } = require('./src/rodizio/app');

iniciarRobos().catch((e) => {
  console.error(new Date().toISOString(), '[ERRO] Falha fatal ao iniciar os robôs:', e);
  process.exit(1);
});

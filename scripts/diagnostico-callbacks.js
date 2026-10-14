#!/usr/bin/env node
'use strict';
/**
 * Diagnóstico de callbacks dos robôs (só leitura: não muda nada na Argus).
 *
 *   npm run diagnostico:callbacks                    o dia de hoje até agora
 *   npm run diagnostico:callbacks -- --minutos 120   só os últimos 120 minutos
 *   npm run diagnostico:callbacks -- --campanha 3    escolhe a campanha (se houver mais de uma)
 *
 * Busca as ligações dos grupos de robôs (GRUPOS_ROBOS_URA_IDS) no relatório de
 * ligações detalhadas da Argus e mostra: os campos do relatório, a contagem por
 * status/resultado e cada callback com hora e robô. Grava o mesmo em
 * logs/diagnostico-callbacks-AAAA-MM-DD.json. Sem dados de cliente.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { resumirLigacoes, minutosDesdeMeiaNoite } = require('../src/domain/diagnostico-callbacks');
const { dataLocal, horaLocal } = require('../src/utils/datas');

/** --nome valor → { nome: valor } */
function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

/** A campanha pedida, ou a única ativa. @throws {Error} se houver mais de uma e nenhuma foi escolhida */
async function escolherCampanha(client, pedida) {
  if (pedida) return Number(pedida);
  const ativas = (await client.listarCampanhas()).filter((c) => c.ativo !== false);
  if (ativas.length === 1) return ativas[0].idCampanha;
  const lista = ativas.map((c) => `${c.idCampanha} (${c.campanhaDesc})`).join(', ');
  throw new Error(`Há ${ativas.length} campanhas ativas: ${lista}. Escolha uma com --campanha <id>.`);
}

/**
 * @param {object} deps
 * @param {ArgusClient} deps.client
 * @param {number[]} deps.gruposRobos
 * @param {number} deps.minutos
 * @param {number|string} [deps.campanha]
 * @returns {Promise<{ idCampanha: number, minutos: number, porGrupo: object }>}
 */
async function diagnosticar({ client, gruposRobos, minutos, campanha }) {
  const idCampanha = await escolherCampanha(client, campanha);
  const porGrupo = {};
  for (const idGrupoUsuario of gruposRobos) {
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario, ultimosMinutos: minutos });
    porGrupo[idGrupoUsuario] = resumirLigacoes(ligacoes);
  }
  return { idCampanha, minutos, porGrupo };
}

function imprimir({ idCampanha, minutos, porGrupo }) {
  console.log(`\nCampanha ${idCampanha} · últimos ${minutos} min\n`);
  for (const [grupo, r] of Object.entries(porGrupo)) {
    console.log(`Grupo de robôs ${grupo}: ${r.total} ligação(ões)`);
    console.log(`  Campos: ${r.campos.join(', ') || '(nenhum)'}`);
    for (const [campo, valores] of Object.entries(r.resultados)) {
      const contagem = Object.entries(valores).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' | ');
      console.log(`  ${campo} → ${contagem}`);
    }
    console.log(`  Callbacks: ${r.callbacks.length}`);
    for (const c of r.callbacks) console.log(`    ${JSON.stringify(c)}`);
    console.log('');
  }
}

async function main() {
  const cfg = carregarConfig();
  const args = lerArgumentos(process.argv.slice(2));
  const client = new ArgusClient(cfg.argus, criarLogger({ debug: cfg.debug, escopo: 'diagnostico' }));
  const minutos = Number(args.minutos) || minutosDesdeMeiaNoite(horaLocal(cfg.agenda.fusoHorario));

  const resultado = await diagnosticar({ client, gruposRobos: cfg.rodizio.gruposRobosIds, minutos, campanha: args.campanha });
  imprimir(resultado);

  const arquivo = path.join(process.cwd(), 'logs', `diagnostico-callbacks-${dataLocal(cfg.agenda.fusoHorario)}.json`);
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  fs.writeFileSync(arquivo, JSON.stringify({ geradoEm: new Date().toISOString(), ...resultado }, null, 2));
  console.log(`Salvo em ${arquivo} (sem dados de cliente). Mande esse arquivo para análise.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Diagnóstico falhou: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { diagnosticar, lerArgumentos };

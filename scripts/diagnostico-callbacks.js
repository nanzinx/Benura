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
 * status/resultado, a linha do tempo de 15 em 15 min (derivou × callback) e
 * cada callback com hora e robô. Mostra também quem está na URA agora e em que
 * grupo cada um está LOGADO na telefonia (só lê o status). [NOVO] Lê também as ligações
 * do grupo da URA (GRUPO_URA_ID, o receptivo) e conta os valores de cada campo, para achar
 * as que vieram de um robô (o "Derivou" da Argus). Grava o mesmo em
 * logs/diagnostico-callbacks-AAAA-MM-DD.json. Sem dados de cliente.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ativarLogsEmArquivo } = require('../src/utils/logs-em-arquivo');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { resumirLigacoes, contarCategorias, minutosDesdeMeiaNoite, conferirUra } = require('../src/domain/diagnostico-callbacks');
const { mapearComLimite } = require('../src/utils/concorrencia');
const { escolherCampanha } = require('../src/integrations/argus/campanha');
const { dataLocal, horaLocal } = require('../src/utils/datas');

/** --nome valor → { nome: valor } */
function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

/**
 * @param {object} deps
 * @param {ArgusClient} deps.client
 * @param {number[]} deps.gruposRobos
 * @param {number} deps.minutos
 * @param {number|string} [deps.campanha]
 * @param {number} [deps.grupoUraId] - para conferir em que grupo quem está na URA está logado
 * @returns {Promise<{ idCampanha: number, minutos: number, porGrupo: object, receptivo: object|null, ura: object[] }>}
 */
async function diagnosticar({ client, gruposRobos, minutos, campanha, grupoUraId }) {
  const idCampanha = await escolherCampanha(client, campanha);
  const porGrupo = {};
  for (const idGrupoUsuario of gruposRobos) {
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario, ultimosMinutos: minutos });
    porGrupo[idGrupoUsuario] = resumirLigacoes(ligacoes);
  }
  let receptivo = null;
  if (grupoUraId) {
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario: grupoUraId, ultimosMinutos: minutos }, { maxPaginas: 200 });
    receptivo = { grupo: grupoUraId, ...resumirLigacoes(ligacoes), callbacks: undefined, categorias: contarCategorias(ligacoes) };
  }
  const ura = grupoUraId ? await quemEstaNaUra(client, grupoUraId) : [];
  return { idCampanha, minutos, porGrupo, receptivo, ura };
}

/** Só leitura: os ramais do grupo da URA e o statusoperador de cada um. */
async function quemEstaNaUra(client, grupoUraId) {
  const grupo = (await client.listarGrupos()).find((g) => g.idGrupoUsuario === grupoUraId);
  const ramais = (grupo?.ramaisOperadores || []).map(String);
  const lidos = await mapearComLimite(ramais, 5, async (ramal) => [ramal, await client.statusOperador(ramal).catch((e) => e)]);
  return conferirUra(ramais, new Map(lidos), grupoUraId);
}

function imprimir({ idCampanha, minutos, porGrupo, receptivo, ura }) {
  console.log(`\nCampanha ${idCampanha} · últimos ${minutos} min\n`);
  for (const [grupo, r] of Object.entries(porGrupo)) {
    console.log(`Grupo de robôs ${grupo}: ${r.total} ligação(ões)`);
    console.log(`  Campos: ${r.campos.join(', ') || '(nenhum)'}`);
    for (const [campo, valores] of Object.entries(r.resultados)) {
      const contagem = Object.entries(valores).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' | ');
      console.log(`  ${campo} → ${contagem}`);
    }
    imprimirLinhaDoTempo(r.linhaDoTempo);
    console.log(`  Callbacks (abandono em fila): ${r.callbacks.length}`);
    for (const c of r.callbacks) console.log(`    ${Object.values(c).join(' | ')}`);
    console.log('');
  }
  imprimirReceptivo(receptivo);
  imprimirUra(ura);
}

/** [NOVO] As ligações do grupo da URA (o receptivo): o "Derivou" da Argus deve estar aqui. */
function imprimirReceptivo(r) {
  if (!r) return;
  console.log(`Grupo da URA (receptivo) ${r.grupo}: ${r.total} ligação(ões)`);
  console.log(`  Campos: ${r.campos.join(', ') || '(nenhum)'}`);
  for (const [campo, valores] of Object.entries(r.categorias)) {
    const contagem = Object.entries(valores).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' | ');
    console.log(`  ${campo} → ${contagem}`);
  }
  console.log('');
}

/** Só ASCII: o console do Windows (PowerShell) mostra ✓/⚠ como quadradinho. */
const SIMBOLO = { ok: 'OK', 'outro grupo': 'ATENCAO: LOGADO EM OUTRO GRUPO', deslogado: 'deslogado', erro: 'sem resposta' };

/** Quem está na URA e em que grupo está logado: ATENCAO = a derivação dos robôs não chega nele. */
function imprimirUra(ura) {
  if (!ura.length) return;
  const logados = ura.filter((u) => u.situacao !== 'deslogado');
  console.log(`Quem está na URA agora: ${logados.length} logado(s) de ${ura.length}`);
  for (const u of logados) {
    const grupo = u.grupoLogado != null ? `logado em ${u.grupo ?? '?'} (${u.grupoLogado})` : '';
    console.log(`  ${u.ramal} | ${u.operador ?? ''} | ${grupo} | ${u.status ?? ''} | ${u.origemDerivacao ?? ''} | ${SIMBOLO[u.situacao]}`);
  }
  const fora = ura.filter((u) => u.situacao === 'outro grupo').length;
  console.log(fora
    ? `  ATENCAO: ${fora} pessoa(s) na URA logada(s) em outro grupo: a derivação dos robôs não chega nelas. Peça para deslogar e logar.\n`
    : '  Todos os logados estão logados no grupo da URA.\n');
}

/** Só as janelas com derivação, callback ou sem agente: é onde está a resposta. */
function imprimirLinhaDoTempo(linhas) {
  const relevantes = linhas.filter((j) => j.callback || j.derivou || j.semAgente);
  if (!relevantes.length) return;
  console.log('  Hora   ligações  derivou  callback  sem agente  abandono na URA');
  const col = (v, n) => String(v).padStart(n);
  for (const j of relevantes) {
    console.log(`  ${j.janela}  ${col(j.total, 8)}  ${col(j.derivou, 7)}  ${col(j.callback, 8)}  ${col(j.semAgente, 10)}  ${col(j.abandonoNaUra, 15)}`);
  }
}

async function main() {
  const cfg = carregarConfig();
  // A saída também fica em logs/AAAA-MM-DD/diagnostico-callbacks.txt (uma seção por execução).
  ativarLogsEmArquivo(cfg, 'diagnostico-callbacks', { cabecalho: 'npm run diagnostico:callbacks' });
  const args = lerArgumentos(process.argv.slice(2));
  const client = new ArgusClient(cfg.argus, criarLogger({ debug: cfg.debug, escopo: 'diagnostico' }));
  const minutos = Number(args.minutos) || minutosDesdeMeiaNoite(horaLocal(cfg.agenda.fusoHorario));

  const resultado = await diagnosticar({
    client, gruposRobos: cfg.rodizio.gruposRobosIds, minutos, campanha: args.campanha, grupoUraId: cfg.argus.grupoUraId,
  });
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

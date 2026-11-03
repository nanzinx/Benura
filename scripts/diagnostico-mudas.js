#!/usr/bin/env node
'use strict';
/**
 * [NOVO] Diagnóstico de ligações derivadas mudas ou que caem no pós-chamada (só leitura: não muda nada).
 *
 *   npm run diagnostico:mudas                         o dia de hoje até agora
 *   npm run diagnostico:mudas -- --minutos 240        só os últimos 240 minutos
 *   npm run diagnostico:mudas -- --ate-seg 10         curta = até 10 s (padrão 15)
 *   npm run diagnostico:mudas -- --janela-seg 30      "perto" = até 30 s antes ou depois (padrão 20)
 *   npm run diagnostico:mudas -- --campanha 3         escolhe a campanha (se houver mais de uma)
 *
 * Busca as ligações do grupo da URA (GRUPO_URA_ID, o receptivo) no relatório de ligações da Argus,
 * separa as curtas (mudas, ou que caíram no pós-chamada) e cruza com o que o BenURA fez no mesmo ramal
 * perto daquela hora, pelos logs de hoje (logs/AAAA-MM-DD/rodizio.txt e robos.txt): troca de grupo,
 * relogin, movido à mão, e as rajadas de robôs. Compara com as ligações normais. Grava o mesmo em
 * logs/diagnostico-mudas-AAAA-MM-DD.json. Sem dados de cliente.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { escolherCampanha } = require('../src/integrations/argus/campanha');
const { minutosDesdeMeiaNoite } = require('../src/domain/diagnostico-callbacks');
const { lerEventosDoLog, cruzar, leitura, parte } = require('../src/domain/diagnostico-mudas');
const { normalizarNome } = require('../src/utils/texto');
const { dataLocal, horaLocal } = require('../src/utils/datas');
const { lerArgumentos } = require('./diagnostico-callbacks');

/** Nome → ramal pelo /listarusuarios (nome repetido com ramais diferentes: sem ramal, para não errar). */
function mapaDeRamais(usuarios) {
  const porNome = new Map();
  for (const u of usuarios) {
    if (!u?.nome || !u.ramal) continue;
    const chave = normalizarNome(u.nome);
    const ramal = String(u.ramal).trim();
    porNome.set(chave, porNome.has(chave) && porNome.get(chave) !== ramal ? null : ramal);
  }
  return (nome) => porNome.get(normalizarNome(nome)) ?? null;
}

/** As linhas de hoje do rodízio e dos robôs (o que não existir fica de fora). */
function linhasDosLogs(pasta, dia) {
  const linhas = [];
  for (const nome of ['rodizio.txt', 'robos.txt']) {
    try {
      linhas.push(...fs.readFileSync(path.join(pasta, dia, nome), 'utf8').split(/\r?\n/));
    } catch { /* ainda não existe */ }
  }
  return linhas;
}

/**
 * @param {object} deps
 * @param {{ ligacoesDetalhadas, listarUsuarios, listarCampanhas }} deps.client
 * @param {number} deps.grupoUraId
 * @param {number} deps.minutos
 * @param {string} deps.pastaLogs
 * @param {string} deps.dia - AAAA-MM-DD (hoje)
 */
async function diagnosticarMudas({ client, grupoUraId, minutos, campanha, pastaLogs, dia, ateSeg = 15, janelaSeg = 20 }) {
  const idCampanha = await escolherCampanha(client, campanha);
  const todas = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario: grupoUraId, ultimosMinutos: minutos }, { maxPaginas: 200 });
  // Os logs são os de hoje: as ligações também
  const ligacoes = todas.filter((l) => String(l.dataHoraLigacao ?? '').startsWith(dia));
  const ramalPorNome = mapaDeRamais(await client.listarUsuarios());
  const eventos = lerEventosDoLog(linhasDosLogs(pastaLogs, dia));
  const r = cruzar({ ligacoes, eventos, ramalPorNome, ateSeg, janelaSeg });
  return { idCampanha, minutos, dia, grupoUra: grupoUraId, eventosNoLog: eventos.length, ...r, leitura: leitura(r) };
}

const NOMES = { paraUra: 'subiu para a URA', paraAtivo: 'voltou ao Ativo', relogin: 'relogado', aMao: 'movido à mão', telefoniaNaUra: 'telefonia trocou para a URA' };

function imprimir(r) {
  console.log(`\nCampanha ${r.idCampanha} · grupo da URA ${r.grupoUra} · ${r.dia}, últimos ${r.minutos} min`);
  console.log(`Curta = até ${r.ateSeg} s · "perto" = até ${r.janelaSeg} s antes ou depois · ${r.eventosNoLog} evento(s) do BenURA no log\n`);
  const linha = (titulo, g) => {
    const tipos = Object.entries(g.porTipo).map(([t, n]) => `${NOMES[t] ?? t}: ${n}`).join(', ');
    console.log(`${titulo}: ${g.total}`);
    console.log(`  com troca de grupo ou relogin do mesmo ramal por perto: ${parte(g.comEventoDoRamal, g.total)}${tipos ? ` (${tipos})` : ''}`);
    console.log(`  numa rajada de robôs ligados de uma vez: ${parte(g.naRajada, g.total)}`);
    if (g.semRamal) console.log(`  sem ramal identificado (nome repetido ou fora da Argus): ${g.semRamal}`);
  };
  linha('Ligações curtas (mudas ou pós-chamada)', r.curtas);
  linha('Ligações normais (base de comparação)', r.normais);
  const resultados = Object.entries(r.resultadosDasCurtas).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n}`).join(' | ');
  if (resultados) console.log(`\nResultado das curtas na Argus: ${resultados}`);
  const comEvento = r.lista.filter((l) => l.eventos.length);
  if (comEvento.length) {
    console.log('\nCurtas com algo do BenURA por perto:');
    for (const l of comEvento.slice(0, 40)) {
      const ev = l.eventos.map((e) => `${NOMES[e.tipo] ?? e.tipo}${e.robos ? ` (+${e.robos})` : ''} ${e.difSeg >= 0 ? '+' : ''}${e.difSeg} s`).join('; ');
      console.log(`  ${l.hora} | ramal ${l.ramal ?? '?'} | ${l.tempoSegundos} s | ${l.resultado} | ${ev}`);
    }
    if (comEvento.length > 40) console.log(`  … e mais ${comEvento.length - 40} (no arquivo).`);
  }
  console.log(`\n${r.leitura}\n`);
}

async function main() {
  const cfg = carregarConfig();
  const args = lerArgumentos(process.argv.slice(2));
  const client = new ArgusClient(cfg.argus, criarLogger({ debug: cfg.debug, escopo: 'diagnostico' }));
  const dia = dataLocal(cfg.agenda.fusoHorario);
  const resultado = await diagnosticarMudas({
    client,
    grupoUraId: cfg.argus.grupoUraId,
    minutos: Number(args.minutos) || minutosDesdeMeiaNoite(horaLocal(cfg.agenda.fusoHorario)),
    campanha: args.campanha,
    pastaLogs: cfg.logs.pasta,
    dia,
    ateSeg: Number(args['ate-seg']) || 15,
    janelaSeg: Number(args['janela-seg']) || 20,
  });
  imprimir(resultado);
  const arquivo = path.join(process.cwd(), 'logs', `diagnostico-mudas-${dia}.json`);
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

module.exports = { diagnosticarMudas, mapaDeRamais };

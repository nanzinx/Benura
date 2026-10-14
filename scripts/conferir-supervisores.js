#!/usr/bin/env node
'use strict';
/**
 * Confere para qual grupo do Ativo a equipe de cada supervisor volta
 * (só leitura: não muda nada na Argus).
 *
 *   npm run conferir:supervisores
 *
 * Mostra cada supervisor com equipe na URA ou no Ativo, o grupo que o BenURA
 * encontra e por qual regra (arquivo, pela equipe, pelo nome do grupo), quem
 * ficou sem grupo, os operadores sem supervisor na Argus e os nomes de
 * OPERADORES_FIXOS_URA e EQUIPES_FIXAS_URA que não batem com a Argus. Grava
 * supervisores-grupos.sugerido.json com todos os supervisores: quem falta vem
 * com null. Preencha os números, confira e renomeie para supervisores-grupos.json
 * (o BenURA relê o arquivo sozinho).
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { DiretorioOperadores } = require('../src/integrations/argus/diretorio-operadores.service');
const { resolverFixos } = require('../src/integrations/argus/fixos');

const ORIGEM = { excecao: 'arquivo', inferido: 'pela equipe', nome: 'pelo nome do grupo' };

/** { "NOME DO SUPERVISOR": idGrupo | null } — fixa também quem hoje é achado pela equipe ou pelo nome. */
const montarSugestao = (supervisores) => Object.fromEntries(supervisores.map((s) => [s.nome, s.idGrupo]));

/** Fixos e equipes fixas do .env: quantos ramais cada um rendeu e quem não bate com a Argus. */
function imprimirFixos(diretorio, regras) {
  if (!regras.fixosUra.length && !regras.equipesFixasUra.length) return;
  const { ramais, faltando } = resolverFixos(diretorio, regras);
  console.log(`\nFixos na URA (OPERADORES_FIXOS_URA e EQUIPES_FIXAS_URA): ${ramais.size} ramal(is)`);
  for (const f of faltando) console.log(`  ATENCAO  ${f.onde}: "${f.item}" ${f.motivo}`);
  if (!faltando.length) console.log('  Todos os nomes batem com a Argus.');
}

function imprimir({ supervisores, semSupervisor, gruposAtivos }) {
  console.log('\nGrupos do Ativo (GRUPOS_ATIVOS_IDS):');
  for (const g of gruposAtivos) console.log(`  ${String(g.idGrupo).padStart(5)}  ${g.nome ?? '(não veio da Argus)'}`);

  const faltam = supervisores.filter((s) => s.idGrupo == null);
  console.log(`\nSupervisores com equipe na URA ou no Ativo: ${supervisores.length} (${faltam.length} sem grupo)`);
  for (const s of supervisores) {
    const grupo = s.idGrupo != null ? `${s.idGrupo} ${s.grupo ?? ''} (${ORIGEM[s.origem]})` : 'SEM GRUPO: preencher no arquivo';
    const aviso = s.cadastrado ? '' : ' | ATENCAO: supervisor não está entre os usuários da Argus';
    console.log(`  ${s.idGrupo != null ? 'OK   ' : 'FALTA'}  ${s.nome}  ->  ${grupo}  | ${s.operadores} operador(es)${aviso}`);
  }

  if (semSupervisor.length) {
    console.log(`\nOperadores sem supervisor na Argus (${semSupervisor.length}): corrija o cadastro na Argus; o arquivo não resolve.`);
    for (const o of semSupervisor) console.log(`  ${o.ramal}  ${o.nome}`);
  }
}

async function main() {
  const cfg = carregarConfig();
  const log = criarLogger({ debug: cfg.debug, escopo: 'conferir-supervisores' });
  const client = new ArgusClient(cfg.argus, log.filho('argus'));
  const diretorio = new DiretorioOperadores({
    client, cfg: cfg.argus, arquivoSupervisoresGrupos: cfg.arquivoSupervisoresGrupos, logger: log.filho('diretorio'),
  });
  await diretorio.atualizar({ forcar: true });

  const resultado = diretorio.conferirSupervisores();
  imprimir(resultado);
  imprimirFixos(diretorio, cfg.regras);

  const arquivo = path.join(process.cwd(), 'supervisores-grupos.sugerido.json');
  fs.writeFileSync(arquivo, `${JSON.stringify(montarSugestao(resultado.supervisores), null, 2)}\n`);
  console.log(`\nSugestão gravada em ${arquivo}.`);
  console.log('Troque cada null pelo número do grupo (lista acima), confira os demais e renomeie para supervisores-grupos.json.');
  console.log('O "pelo nome do grupo" funciona hoje, mas fixar no arquivo evita surpresa se surgir outro grupo com o mesmo nome.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Conferência falhou: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { montarSugestao };

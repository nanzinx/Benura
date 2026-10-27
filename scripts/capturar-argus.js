#!/usr/bin/env node
'use strict';
/**
 * [NOVO] Captura respostas reais da Argus para os testes (só leitura: não muda nada na Argus).
 *
 *   npm run capturar:argus                  grava em test/fixtures/argus/
 *   npm run capturar:argus -- --ramais 5    quantos da URA ler no statusoperador (padrão 8)
 *   npm run capturar:argus -- --minutos 30  janela das ligações detalhadas (padrão 30)
 *
 * Lê listargrupos, listarpausas, o statusoperador de alguns da URA e uma janela curta do
 * ligacoesdetalhadas (robôs e URA). Tudo passa pela sanitização (src/domain/sanitizar-argus.js):
 * sem cliente, telefone, CPF, e-mail; nomes viram "Operador N" e ramais viram 9000NN.
 * Antes de gravar, confere de novo: se sobrar algo com cara de dado pessoal, NÃO grava.
 * Depois: npm test (test/unit/argus-respostas.test.js roda os parsers nelas) e commit.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { escolherCampanha } = require('../src/integrations/argus/campanha');
const { mapearComLimite } = require('../src/utils/concorrencia');
const { Sanitizador, dadosPessoais } = require('../src/domain/sanitizar-argus');

const PASTA = path.join(__dirname, '..', 'test', 'fixtures', 'argus');

function lerArgumentos(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  return args;
}

/**
 * @returns {Promise<Array<{ arquivo: string, comando: string, resposta: any }>>} já sanitizado
 */
async function capturar({ client, grupoUraId, gruposRobos, ramais = 8, minutos = 30, campanha }) {
  const s = new Sanitizador(); // um só: o mesmo ramal tem o mesmo apelido em todos os arquivos
  const saida = [];
  const grupos = await client.listarGrupos();
  saida.push({ arquivo: 'listargrupos', comando: 'listargrupos', resposta: grupos });
  const naUra = (grupos.find((g) => g.idGrupoUsuario === grupoUraId)?.ramaisOperadores ?? []).slice(0, ramais);
  // As pausas vêm por operador: as do primeiro da URA.
  if (naUra.length) saida.push({ arquivo: 'listarpausas', comando: 'listarpausas', resposta: await client.listarPausas(naUra[0]) });

  const status = await mapearComLimite(naUra, 4, (r) => client.statusOperador(r).catch(() => null));
  saida.push({ arquivo: 'statusoperador', comando: 'statusoperador', resposta: status.filter(Boolean) });

  const idCampanha = await escolherCampanha(client, campanha);
  const robos = gruposRobos[0];
  if (robos) {
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario: robos, ultimosMinutos: minutos }, { maxPaginas: 1 });
    saida.push({ arquivo: 'ligacoesdetalhadas-robos', comando: 'ligacoesdetalhadas', resposta: ligacoes.slice(0, 40) });
  }
  if (grupoUraId) {
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario: grupoUraId, ultimosMinutos: minutos }, { maxPaginas: 1 });
    saida.push({ arquivo: 'ligacoesdetalhadas-ura', comando: 'ligacoesdetalhadas', resposta: ligacoes.slice(0, 40) });
  }
  return saida.map((c) => ({ ...c, resposta: s.limpar(c.resposta) }));
}

/** Grava cada uma (origem "argus"); recusa tudo se sobrar dado pessoal. @returns {string[]} os arquivos */
function gravar(capturas, { pasta = PASTA, agora = new Date() } = {}) {
  const problemas = capturas.flatMap((c) => dadosPessoais(c.resposta).map((p) => `${c.arquivo}: ${p}`));
  if (problemas.length) throw new Error(`Nada gravado: ainda há algo com cara de dado pessoal:\n  ${problemas.join('\n  ')}`);
  fs.mkdirSync(pasta, { recursive: true });
  return capturas.map((c) => {
    const arquivo = path.join(pasta, `${c.arquivo}.json`);
    const conteudo = { origem: 'argus', capturadoEm: agora.toISOString(), nota: 'Captura real (npm run capturar:argus), sem dados pessoais.', comando: c.comando, resposta: c.resposta };
    fs.writeFileSync(arquivo, `${JSON.stringify(conteudo, null, 2)}\n`);
    return arquivo;
  });
}

async function main() {
  const args = lerArgumentos(process.argv.slice(2));
  const cfg = carregarConfig();
  const log = criarLogger({ debug: cfg.debug, escopo: 'capturar-argus' });
  const client = new ArgusClient(cfg.argus, log);
  const capturas = await capturar({
    client, grupoUraId: cfg.argus.grupoUraId, gruposRobos: cfg.rodizio.gruposRobosIds,
    ramais: Number(args.ramais) || 8, minutos: Number(args.minutos) || 30, campanha: args.campanha,
  });
  for (const arquivo of gravar(capturas)) log.info(`Gravado: ${path.relative(process.cwd(), arquivo)}`);
  log.info('Confira com "npm test" e mande os arquivos (ou faça o commit). Nenhum dado pessoal foi gravado.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { capturar, gravar };

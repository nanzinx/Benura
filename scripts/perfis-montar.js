#!/usr/bin/env node
'use strict';
/**
 * Monta o histórico dos perfis de clientes a partir do relatório de ligações
 * detalhadas dos robôs (só leitura na Argus).
 *
 *   npm run perfis:montar                  últimos 6 dias (até ontem; o máximo da Argus)
 *   npm run perfis:montar -- --dias 3      últimos 3 dias
 *   npm run perfis:montar -- --campanha 3  escolhe a campanha (se houver mais de uma)
 *
 * A Argus entrega no máximo 7 dias de ligações por consulta: são 6 dias completos +
 * o de hoje. Pedir mais lê só os 6 (com aviso). Os dias mais antigos se completam
 * com o tempo: o BenURA conta cada ligação ao vivo, até PERFIS_DIAS.
 *
 * Grava PERFIS_HISTORICO_FILE (state-perfis-historico.json) juntando com o histórico
 * anterior: rodar de novo só relê os últimos dias e não perde os mais antigos. O
 * benura-rodizio relê o arquivo sozinho. Pode rodar com o BenURA ligado.
 * O telefone não é gravado: só o HMAC e a versão mascarada.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { ativarLogsEmArquivo } = require('../src/utils/logs-em-arquivo');
const { ArgusClient } = require('../src/integrations/argus/argus.client');
const { escolherCampanha } = require('../src/integrations/argus/campanha');
const { dataLocal } = require('../src/utils/datas');
const { obterSegredo, diaDaLigacao } = require('../src/rodizio/perfis-clientes');
const {
  Resultado, classificarLigacao, telefoneDaLigacao, chaveDoCliente, mascarar, somar, podar, juntarHistorico,
} = require('../src/domain/perfis-clientes');
const { lerJson } = require('../src/utils/arquivo-json');

/** A Argus aceita no máximo 7 dias por consulta de ligações detalhadas: 6 completos + hoje. */
const MAX_DIAS_ARGUS = 6;
const { lerArgumentos } = require('./diagnostico-callbacks');
const { instanteLocal } = require('../src/domain/raio-x-callback');

/**
 * Soma as ligações finais (atendeu/callback) de antes de `ate` nos perfis.
 * @returns {{ lidas: number, contadas: number }}
 */
function contar(perfis, ligacoes, { segredo, ate, fuso, agora }) {
  let contadas = 0;
  for (const l of ligacoes) {
    const tipo = classificarLigacao(l);
    if (tipo !== Resultado.ATENDEU && tipo !== Resultado.CALLBACK) continue;
    const telefone = telefoneDaLigacao(l);
    const dia = diaDaLigacao(l, fuso, agora);
    if (!telefone || dia >= ate) continue;
    const chave = chaveDoCliente(telefone, segredo);
    perfis[chave] = somar(perfis[chave], { mascara: mascarar(telefone), dia, tipo });
    contadas++;
  }
  return { lidas: ligacoes.length, contadas };
}

async function main() {
  const cfg = carregarConfig();
  ativarLogsEmArquivo(cfg, 'perfis-montar', { cabecalho: 'npm run perfis:montar' });
  const args = lerArgumentos(process.argv.slice(2));
  const pedidos = Math.max(1, Number(args.dias) || MAX_DIAS_ARGUS);
  const dias = Math.min(pedidos, MAX_DIAS_ARGUS);
  if (pedidos > dias) {
    console.log(`A Argus entrega no máximo 7 dias de ligações: lendo os últimos ${dias} dias completos (pedido: ${pedidos}). `
      + `Os mais antigos se completam com o BenURA ligado (até PERFIS_DIAS = ${cfg.rodizio.perfis.dias}).`);
  }
  const fuso = cfg.agenda.fusoHorario;
  const p = cfg.rodizio.perfis;
  const client = new ArgusClient(cfg.argus, criarLogger({ debug: cfg.debug, escopo: 'perfis' }));
  const idCampanha = await escolherCampanha(client, args.campanha || cfg.rodizio.idCampanhaRobos || undefined);
  const segredo = obterSegredo(p);
  const agora = Date.now();
  const ate = dataLocal(fuso, new Date(agora)); // hoje fica com o BenURA (ao vivo)
  const inicioDeHoje = instanteLocal(`${ate}T00:00:00`, fuso);
  const desdeDia = dataLocal(fuso, new Date(inicioDeHoje - dias * 86_400_000 + 3_600_000));
  const minutos = dias * 1440 + Math.ceil((agora - inicioDeHoje) / 60_000);

  const perfis = {};
  let lidas = 0;
  let contadas = 0;
  let paginas = 0;
  for (const idGrupoUsuario of cfg.rodizio.gruposRobosIds) {
    console.log(`Grupo de robôs ${idGrupoUsuario}: lendo ${dias} dia(s) de ligações (campanha ${idCampanha})...`);
    await client.ligacoesDetalhadas({ idCampanha, idGrupoUsuario, ultimosMinutos: minutos }, {
      maxPaginas: 100_000,
      aoReceber: (pagina) => {
        const r = contar(perfis, pagina, { segredo, ate, fuso, agora });
        lidas += r.lidas;
        contadas += r.contadas;
        if (++paginas % 10 === 0) console.log(`  ${paginas} página(s), ${lidas} ligação(ões) lida(s)...`);
      },
    });
  }

  const anterior = lerJson(p.arquivoHistorico).dados?.perfis;
  const juntos = podar(juntarHistorico(anterior, perfis, { desde: desdeDia, ate }), dataLocal(fuso, new Date(agora - p.dias * 86_400_000)));
  fs.mkdirSync(path.dirname(p.arquivoHistorico), { recursive: true });
  fs.writeFileSync(p.arquivoHistorico, JSON.stringify({ desde: desdeDia, ate, geradoEm: new Date().toISOString(), dias, perfis: juntos }));
  console.log(`\n${lidas} ligação(ões) lida(s), ${contadas} contada(s) (atendeu ou callback), de ${desdeDia} até ontem.`);
  console.log(`Histórico gravado em ${p.arquivoHistorico}: ${Object.keys(juntos).length} cliente(s)`
    + `${anterior ? ' (junto com o histórico anterior)' : ''}. O benura-rodizio relê sozinho.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Montagem dos perfis falhou: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { contar };

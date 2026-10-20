#!/usr/bin/env node
'use strict';
/**
 * Monta o histórico dos perfis de clientes a partir do relatório de ligações
 * detalhadas dos robôs (só leitura na Argus).
 *
 *   npm run perfis:montar                  últimos 3 dias (até ontem)
 *   npm run perfis:montar -- --dias 7      últimos 7 dias
 *   npm run perfis:montar -- --campanha 3  escolhe a campanha (se houver mais de uma)
 *
 * Grava PERFIS_HISTORICO_FILE (state-perfis-historico.json). O benura-rodizio relê o
 * arquivo sozinho e soma com o que conta ao vivo a partir de hoje. Pode rodar com o
 * BenURA ligado. O telefone não é gravado: só o HMAC e a versão mascarada.
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
  Resultado, classificarLigacao, telefoneDaLigacao, chaveDoCliente, mascarar, somar, podar,
} = require('../src/domain/perfis-clientes');
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
  const dias = Math.max(1, Number(args.dias) || 3);
  const fuso = cfg.agenda.fusoHorario;
  const p = cfg.rodizio.perfis;
  const client = new ArgusClient(cfg.argus, criarLogger({ debug: cfg.debug, escopo: 'perfis' }));
  const idCampanha = await escolherCampanha(client, args.campanha || cfg.rodizio.idCampanhaRobos || undefined);
  const segredo = obterSegredo(p);
  const agora = Date.now();
  const ate = dataLocal(fuso, new Date(agora)); // hoje fica com o BenURA (ao vivo)
  const minutos = dias * 1440 + Math.ceil((agora - instanteLocal(`${ate}T00:00:00`, fuso)) / 60_000);

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

  const desde = dataLocal(fuso, new Date(agora - p.dias * 86_400_000));
  podar(perfis, desde);
  fs.mkdirSync(path.dirname(p.arquivoHistorico), { recursive: true });
  fs.writeFileSync(p.arquivoHistorico, JSON.stringify({ ate, geradoEm: new Date().toISOString(), dias, perfis }));
  console.log(`\n${lidas} ligação(ões) lida(s), ${contadas} contada(s) (atendeu ou callback), ${Object.keys(perfis).length} cliente(s).`);
  console.log(`Histórico gravado em ${p.arquivoHistorico} (até ${ate}, sem o dia de hoje). O benura-rodizio relê sozinho.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Montagem dos perfis falhou: ${e.message}`);
    process.exitCode = 1;
  });
}

module.exports = { contar };

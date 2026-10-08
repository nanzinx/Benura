#!/usr/bin/env node
'use strict';
/**
 * CADASTRO DE OPERADORES — Vanguard → Argus (semiautomático)
 *
 * A API da Argus não cria usuários; este comando prepara e confere o cadastro.
 *
 * USO
 *   1) Gerar a ficha do cadastro:
 *      node cadastrar-operador.js planejar YASMIN.FERREIRA@36241 \
 *           --nome "YASMIN FERREIRA DE JESUS" \
 *           --supervisor "MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO"
 *
 *   2) Cadastrar na Argus (Config. → Usuários Operadores → Novo Usuário Operador)
 *      copiando os dados da ficha.
 *
 *   3) Conferir (e corrigir o grupo, se preciso):
 *      node cadastrar-operador.js conferir YASMIN.FERREIRA@36241 \
 *           --supervisor "MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO" --corrigir
 *
 * OPÇÕES
 *   --nome, --supervisor, --perfil, --status   Dados do funcionário no Vanguard
 *                                              (enquanto a consulta automática
 *                                              via Carrossel não existe)
 *   --corrigir   (conferir) transfere para o grupo certo pela API
 *   --json       saída em JSON (para integrar com outros sistemas)
 *
 * CÓDIGOS DE SAÍDA
 *   0 = pronto / conferido   2 = precisa de atenção humana   1 = erro
 */

const { parseArgs } = require('util');
const { carregarConfig, validarConfig } = require('./src/config');
const { criarLogger } = require('./src/utils/logger');
const { montarArgus } = require('./src/app');
const { FonteFuncionarioManual } = require('./src/integrations/vanguard/fonte-manual');
const { AuditoriaRepository } = require('./src/repositories/auditoria.repository');
const { CadastroOperadorService } = require('./src/services/cadastro-operador.service');
const { StatusPlano, StatusConferencia } = require('./src/domain/cadastro-operador');

const AJUDA = 'Uso: node cadastrar-operador.js <planejar|conferir> LOGIN@AGENCIA '
  + '--nome "..." --supervisor "..." [--perfil "..."] [--corrigir] [--json]';

function lerArgumentos(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      nome: { type: 'string' },
      supervisor: { type: 'string' },
      perfil: { type: 'string' },
      status: { type: 'string' },
      corrigir: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      ajuda: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [comando, login] = positionals;
  return { comando, login, ...values };
}

// ───────────────────────────── Saída para humanos ─────────────────────────────

const linha = (rotulo, valor) => console.log(`  ${rotulo.padEnd(22)} ${valor ?? '—'}`);

function imprimirPlano(p) {
  console.log(`\nCadastro de ${p.loginVanguard} → ${p.status}`);
  if (p.motivo) console.log(`  ${p.motivo}`);
  for (const u of p.existentes || []) {
    console.log(`  • ${u.login} | ${u.nome} | ramal ${u.ramal} | ${u.ativo ? 'ATIVO' : 'INATIVO'} | ${u.tipo} | `
      + `grupo ${u.grupo ?? '—'} | supervisor ${u.supervisor ?? '—'}`);
  }
  if (p.ficha) {
    const { ficha: f } = p;
    console.log('\n  FICHA — Argus › Config. › Usuários Operadores › Novo Usuário Operador');
    linha('Nome', f.nome);
    linha('Login', f.login);
    linha('Ramal Integração', f.ramalIntegracaoSugerido ? `${f.ramalIntegracaoSugerido} (sugestão: próximo livre)` : null);
    linha('Senha', 'padrão do formulário (troca no 1º login)');
    console.log('\n  Vínculo (botão "Vincular Campanha")');
    linha('Campanha', f.vinculo.campanha);
    linha('Grupo Usuário', f.vinculo.grupo && `${f.vinculo.grupo} (id ${f.vinculo.idGrupo}, ${f.vinculo.grupoOrigem})`);
    linha('Principal', 'Sim');
    linha('Perfil', f.vinculo.perfil);
    linha('Supervisor', f.vinculo.supervisor);
  }
  for (const pend of p.pendencias || []) console.log(`  ⚠ PENDÊNCIA: ${pend}`);
  for (const av of p.avisos || []) console.log(`  ⚠ AVISO: ${av}`);
  if (p.status === StatusPlano.PRONTO) {
    console.log(`\n  Depois de cadastrar, rode: node cadastrar-operador.js conferir ${p.loginVanguard} --supervisor "..."`);
  }
  console.log('');
}

function imprimirConferencia(c) {
  console.log(`\nConferência de ${c.loginArgus} → ${c.status}`);
  if (c.motivo) console.log(`  ${c.motivo}`);
  if (c.usuario) {
    const u = c.usuario;
    linha('Na Argus', `${u.nome} | ramal ${u.ramal} | ${u.ativo ? 'ATIVO' : 'INATIVO'} | ${u.tipo}`);
    linha('Grupo atual', u.grupo);
    linha('Supervisor atual', u.supervisor);
  }
  if (c.esperado) {
    linha('Grupo esperado', c.esperado.grupo);
    linha('Supervisor esperado', c.esperado.supervisor);
  }
  for (const d of c.divergencias || []) console.log(`  ✗ ${d.campo}: esperado ${d.esperado}, atual ${d.atual}`);
  for (const a of c.acoes || []) console.log(`  → ${a}`);
  for (const p of c.pendencias || []) console.log(`  ⚠ PENDÊNCIA: ${p}`);
  console.log('');
}

// ───────────────────────────── Execução ─────────────────────────────

async function main(argv) {
  let args;
  try {
    args = lerArgumentos(argv);
  } catch (e) {
    console.error(`${e.message}\n${AJUDA}`);
    return 1;
  }
  if (args.ajuda || !['planejar', 'conferir'].includes(args.comando) || !args.login) {
    console.error(AJUDA);
    return args.ajuda ? 0 : 1;
  }

  const cfg = carregarConfig();
  const log = criarLogger({ debug: cfg.debug, escopo: 'cadastro', tudoNoStderr: true });
  const { fatais } = validarConfig(cfg, { escopo: 'argus' });
  if (fatais.length) {
    fatais.forEach((f) => log.erro(f));
    return 1;
  }

  const { diretorio, discadora } = montarArgus(cfg, log);
  const servico = new CadastroOperadorService({
    fonteFuncionarios: new FonteFuncionarioManual({
      nome: args.nome, supervisor: args.supervisor, perfil: args.perfil, status: args.status,
    }),
    diretorio,
    discadora,
    auditoria: new AuditoriaRepository({ arquivo: cfg.arquivoAuditoria, logger: log }),
    cfg: cfg.argus,
    logger: log,
  });

  if (args.comando === 'planejar') {
    const plano = await servico.planejar(args.login);
    if (args.json) console.log(JSON.stringify(plano, null, 2));
    else imprimirPlano(plano);
    return plano.status === StatusPlano.PRONTO ? 0 : 2;
  }

  const conf = await servico.conferir(args.login, { corrigir: args.corrigir });
  if (args.json) console.log(JSON.stringify(conf, null, 2));
  else imprimirConferencia(conf);
  return [StatusConferencia.OK, StatusConferencia.CORRIGIDO].includes(conf.status) ? 0 : 2;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((codigo) => { process.exitCode = codigo; })
    .catch((e) => {
      console.error(`${new Date().toISOString()} [ERRO] ${e.message}`);
      process.exitCode = 1;
    });
}

module.exports = { main };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { podeFazerDeploy } = require('../../src/domain/janela-deploy');
const { diaDaSemanaLocal } = require('../../src/utils/datas');
const { AtualizadorService, Resultado } = require('../../src/atualizador/atualizador.service');
const { loggerNulo } = require('../../src/utils/logger');

const EXPEDIENTE = { inicio: '08:00', fim: '18:00' };

test('janela: dias úteis só fora do expediente; fim de semana livre', () => {
  const pode = (diaSemana, hora) => podeFazerDeploy({ diaSemana, hora, ...EXPEDIENTE });
  assert.ok(!pode(3, '08:00'), 'quarta 08:00 (início do expediente)');
  assert.ok(!pode(3, '12:00'));
  assert.ok(!pode(3, '18:00'), 'quarta 18:00 (ainda expediente)');
  assert.ok(pode(3, '18:01'));
  assert.ok(pode(3, '07:59'));
  assert.ok(pode(6, '12:00'), 'sábado');
  assert.ok(pode(0, '12:00'), 'domingo');
});

test('diaDaSemanaLocal respeita o fuso', () => {
  const sabadoNoiteSP = new Date('2026-10-11T02:00:00Z'); // 23:00 de sábado em SP, já domingo em UTC
  assert.equal(diaDaSemanaLocal('America/Sao_Paulo', sabadoNoiteSP), 6);
  assert.equal(diaDaSemanaLocal('UTC', sabadoNoiteSP), 0);
});

/**
 * Máquina de produção falsa: responde aos comandos como um git/npm/pm2 de verdade
 * responderiam, a partir de um pequeno estado, e registra o que foi executado.
 */
function montar({
  head = 'aaa1111', remoto = 'bbb2222', alteracoesLocais = '', divergiu = false, lockMudou = false,
  testesPassam = true, reloadOk = true, saudeOk = true, janela = { diaSemana: 6, hora: '12:00' },
} = {}) {
  const estado = { head };
  const comandos = [];
  const eventos = [];
  const ok = (saida = '') => ({ ok: true, codigo: 0, saida });
  const falha = (saida = 'erro') => ({ ok: false, codigo: 1, saida });

  const respostas = [
    [/^git fetch/, () => ok()],
    [/^git rev-parse HEAD$/, () => ok(estado.head)],
    [/^git rev-parse origin\/main$/, () => ok(remoto)],
    [/^git status/, () => ok(alteracoesLocais)],
    [/^git merge-base/, () => (divergiu ? falha('') : ok())],
    [/^git diff --quiet/, () => (lockMudou ? falha('') : ok())],
    [/^git merge --ff-only/, () => { estado.head = remoto; return ok(); }],
    [/^git reset --hard/, (args) => { estado.head = args.at(-1); return ok(); }],
    [/^npm ci/, () => ok()],
    [/^npm test/, () => (testesPassam || estado.head !== remoto ? ok() : falha('1 teste falhou'))],
    [/^npx pm2 startOrReload/, () => (reloadOk ? ok() : falha('pm2 erro'))],
  ];

  const executar = async (cmd, args) => {
    const linha = `${cmd} ${args.join(' ')}`;
    comandos.push(linha);
    const [, responder] = respostas.find(([re]) => re.test(linha)) || [null, () => falha(`inesperado: ${linha}`)];
    return responder(args);
  };

  const servico = new AtualizadorService({
    executar,
    aguardarSaude: async (urls) => ({ ok: saudeOk || estado.head !== remoto, falharam: saudeOk ? [] : urls }),
    relogio: { momento: () => janela },
    cfg: {
      branch: 'main', apps: ['benura-roteador', 'benura-rodizio'],
      healthUrls: ['http://localhost:3001/health'], healthTimeoutMs: 100, expediente: EXPEDIENTE,
    },
    auditoria: { registrar: async (acao, dados) => eventos.push({ acao, ...dados }) },
    logger: loggerNulo,
  });
  return { servico, comandos, eventos, estado, foi: (re) => comandos.some((c) => re.test(c)) };
}

test('fora da janela: não toca em nada', async () => {
  const ctx = montar({ janela: { diaSemana: 2, hora: '10:00' } });
  assert.equal((await ctx.servico.verificar()).resultado, Resultado.FORA_DA_JANELA);
  assert.equal(ctx.comandos.length, 0);
  assert.equal(ctx.eventos.length, 0, 'não polui a auditoria');
});

test('--ignorar-janela atualiza mesmo no expediente', async () => {
  const ctx = montar({ janela: { diaSemana: 2, hora: '10:00' } });
  assert.equal((await ctx.servico.verificar({ ignorarJanela: true })).resultado, Resultado.IMPLANTADO);
});

test('sem mudança na main: nada além do fetch', async () => {
  const ctx = montar({ remoto: 'aaa1111' });
  assert.equal((await ctx.servico.verificar()).resultado, Resultado.SEM_MUDANCA);
  assert.ok(!ctx.foi(/merge --ff-only|pm2/));
});

test('alteração local ou divergência: aborta sem mexer', async () => {
  const local = montar({ alteracoesLocais: ' M src/app.js' });
  const r1 = await local.servico.verificar();
  assert.equal(r1.resultado, Resultado.ABORTADO);
  assert.match(r1.motivo, /alterações locais/);

  const div = montar({ divergiu: true });
  const r2 = await div.servico.verificar();
  assert.equal(r2.resultado, Resultado.ABORTADO);
  assert.match(r2.motivo, /divergiu/);
  assert.ok(!div.foi(/merge --ff-only|reset|pm2/));
  assert.equal(div.eventos[0].acao, 'deploy.abortado');
});

test('sucesso: fast-forward, testes, reload dos dois apps, auditoria', async () => {
  const ctx = montar();
  const r = await ctx.servico.verificar();
  assert.equal(r.resultado, Resultado.IMPLANTADO);
  assert.equal(ctx.estado.head, 'bbb2222');
  assert.ok(!ctx.foi(/^npm ci/), 'package-lock igual: sem npm ci');
  assert.ok(ctx.foi(/pm2 startOrReload ecosystem.config.js --only benura-roteador,benura-rodizio/));
  assert.deepEqual(ctx.eventos.map((e) => e.acao), ['deploy.implantado']);
});

test('package-lock mudou: roda npm ci', async () => {
  const ctx = montar({ lockMudou: true });
  await ctx.servico.verificar();
  assert.ok(ctx.foi(/^npm ci/));
});

test('testes falham: volta ao commit anterior e NÃO recarrega', async () => {
  const ctx = montar({ testesPassam: false });
  const r = await ctx.servico.verificar();
  assert.equal(r.resultado, Resultado.REVERTIDO);
  assert.equal(r.etapa, 'npm test');
  assert.equal(ctx.estado.head, 'aaa1111');
  assert.ok(!ctx.foi(/pm2/), 'serviços continuam na versão antiga, sem reinício');
});

test('serviço não responde no /health: reverte e recarrega a versão anterior', async () => {
  const ctx = montar({ saudeOk: false });
  const r = await ctx.servico.verificar();
  assert.equal(r.resultado, Resultado.REVERTIDO);
  assert.equal(r.etapa, 'health');
  assert.equal(ctx.estado.head, 'aaa1111');
  assert.equal(ctx.comandos.filter((c) => /pm2/.test(c)).length, 2, 'reload da nova e de volta da antiga');
});

test('pm2 falha ao recarregar: reverte', async () => {
  const ctx = montar({ reloadOk: false });
  const r = await ctx.servico.verificar();
  assert.equal(r.resultado, Resultado.REVERTIDO);
  assert.equal(r.etapa, 'pm2 startOrReload');
  assert.equal(ctx.estado.head, 'aaa1111');
});

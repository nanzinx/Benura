'use strict';
/**
 * [NOVO] O executor do atualizador (e do painel) nunca espera resposta: no servidor, o Git for
 * Windows perguntou "Unlink of file ... failed. Should I try again? (y/n)" na faxina automática.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { criarExecutor, argumentosDe } = require('../../src/atualizador/executor');
const { loggerNulo } = require('../../src/utils/logger');

test('executor: o git roda sem a faxina automática (gc) e o resto fica como está', () => {
  assert.deepEqual(argumentosDe('git', ['fetch', '--quiet', 'origin', 'main']), ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--quiet', 'origin', 'main']);
  assert.deepEqual(argumentosDe('npx', ['pm2', 'stop', 'benura-rodizio']), ['pm2', 'stop', 'benura-rodizio']);
  assert.deepEqual(argumentosDe('npm', ['test']), ['test']);
});

test('executor: sem perguntas (GIT_ASK_YESNO=false, GIT_TERMINAL_PROMPT=0) e com a entrada fechada, não trava', async () => {
  const executar = criarExecutor({ cwd: path.join(__dirname, '..', 'fixtures', 'executor'), logger: loggerNulo });
  const inicio = Date.now();
  const r = await executar('node', ['filho.js'], { timeoutMs: 5000 });
  assert.equal(r.ok, true, r.saida);
  assert.match(r.saida, /ASK=false PROMPT=0/);
  assert.match(r.saida, /entrada fechada/, 'quem lê a entrada recebe o fim na hora, em vez de esperar alguém digitar');
  assert.ok(Date.now() - inicio < 4000, 'terminou antes do timeout');
});

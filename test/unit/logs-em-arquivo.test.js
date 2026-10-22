'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gravarLogsEmArquivo, apagarAntigos } = require('../../src/utils/logs-em-arquivo');

const pastaTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'benura-logs-'));
const saidaFalsa = () => {
  const escrito = [];
  return { escrito, write(pedaco) { escrito.push(String(pedaco)); return true; } };
};
const ler = (pasta, dia, arquivo) => fs.readFileSync(path.join(pasta, dia, arquivo), 'utf8');
/** WriteStream é assíncrono: parar() só resolve quando todos os arquivos (até os do dia anterior) foram gravados. */
const fechar = (gravador) => gravador.parar();

test('logs em arquivo: hora local, avisos à parte, callbacks à parte e segredo mascarado; a saída original continua', async () => {
  const pasta = pastaTemp();
  const saidas = { stdout: saidaFalsa(), stderr: saidaFalsa() };
  const g = gravarLogsEmArquivo({
    servico: 'rodizio', pasta, fuso: 'America/Sao_Paulo', segredos: ['token-secreto-123'], saidas,
    agora: () => new Date('2026-10-15T11:42:18Z'),
  });
  saidas.stdout.write('2026-10-15T11:42:18.123Z [INFO] [rodizio] URA: livres 0→1\n');
  saidas.stdout.write('meia linha ');
  saidas.stdout.write('completa com token-secreto-123\n');
  saidas.stderr.write('2026-10-15T11:42:19.000Z [AVISO] [rodizio] CALLBACK 08:42:18 (34 s na fila)\n');
  await fechar(g);

  assert.equal(ler(pasta, '2026-10-15', 'rodizio.txt'),
    '08:42:18 [INFO] [rodizio] URA: livres 0→1\n08:42:18 meia linha completa com ***\n08:42:18 [AVISO] [rodizio] CALLBACK 08:42:18 (34 s na fila)\n');
  assert.equal(ler(pasta, '2026-10-15', 'avisos.txt'), '08:42:18 [rodizio] [AVISO] [rodizio] CALLBACK 08:42:18 (34 s na fila)\n');
  assert.match(ler(pasta, '2026-10-15', 'callbacks.txt'), /CALLBACK 08:42:18/);
  assert.match(saidas.stdout.escrito.join(''), /token-secreto-123/, 'a saída do PM2 não muda');
});

test('logs em arquivo: troca de pasta na virada do dia e apaga as pastas mais antigas que LOGS_DIAS', async () => {
  const pasta = pastaTemp();
  for (const dia of ['2026-09-01', '2026-09-20', 'outra-coisa']) fs.mkdirSync(path.join(pasta, dia));
  let agora = new Date('2026-10-15T02:59:00Z'); // 23:59 do dia 14 em Brasília
  const saidas = { stdout: saidaFalsa(), stderr: saidaFalsa() };
  const g = gravarLogsEmArquivo({ servico: 'rotinas', pasta, fuso: 'America/Sao_Paulo', dias: 30, saidas, agora: () => agora });
  saidas.stdout.write('antes da meia-noite\n');
  agora = new Date('2026-10-15T03:01:00Z');
  saidas.stdout.write('depois da meia-noite\n');
  await fechar(g);

  assert.equal(ler(pasta, '2026-10-14', 'rotinas.txt'), '23:59:00 antes da meia-noite\n');
  assert.equal(ler(pasta, '2026-10-15', 'rotinas.txt'), '00:01:00 depois da meia-noite\n');
  assert.ok(!fs.existsSync(path.join(pasta, '2026-09-01')), 'mais de 30 dias: apagada');
  assert.ok(fs.existsSync(path.join(pasta, '2026-09-20')));
  assert.ok(fs.existsSync(path.join(pasta, 'outra-coisa')), 'só mexe em pastas de dia');
  assert.deepEqual(apagarAntigos(pasta, '2026-10-15', 0), [], '0 = guarda tudo');
});

test('logs em arquivo: parar devolve a saída original e não grava mais', async () => {
  const pasta = pastaTemp();
  const saidas = { stdout: saidaFalsa(), stderr: saidaFalsa() };
  const original = saidas.stdout.write;
  const g = gravarLogsEmArquivo({ servico: 'x', pasta, fuso: 'UTC', saidas, cabecalho: 'npm run diagnostico:callbacks', agora: () => new Date('2026-10-15T12:00:00Z') });
  await fechar(g);
  assert.equal(saidas.stdout.write, original);
  saidas.stdout.write('fora do arquivo\n');
  assert.equal(ler(pasta, '2026-10-15', 'x.txt'), '12:00:00 === npm run diagnostico:callbacks ===\n');
});

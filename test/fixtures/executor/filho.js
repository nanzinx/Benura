'use strict';
// Usado por test/unit/executor.test.js: mostra o ambiente que o executor passou e tenta ler a entrada.
process.stdout.write(`ASK=${process.env.GIT_ASK_YESNO} PROMPT=${process.env.GIT_TERMINAL_PROMPT}\n`);
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.stdout.write('entrada fechada\n'));
process.stdin.on('error', () => process.stdout.write('entrada fechada\n'));
process.stdin.resume();

'use strict';
/**
 * [NOVO] Ajudante dos scripts do Windows: lê o `pm2 jlist` (o PowerShell 5.1 não lê esse
 * JSON: as variáveis de ambiente vêm com chaves que só diferem em maiúsculas) e imprime
 * uma linha por serviço do BenURA: "nome<TAB>status<TAB>reinícios". Nenhuma linha = o PM2
 * está sem os serviços do BenURA. Código de saída 2 = o PM2 não respondeu.
 *
 *   node scripts/windows/pm2-estado.js [pasta-do-benura]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const pasta = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const pm2 = path.join(pasta, 'node_modules', 'pm2', 'bin', 'pm2');
const r = spawnSync(process.execPath, [pm2, 'jlist'], { cwd: pasta, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
// Antes do JSON o PM2 pode escrever "[PM2] Spawning PM2 daemon...": vale a última linha que é uma lista.
const linha = String(r.stdout || '').split(/\r?\n/).reverse().find((l) => /^\s*\[\s*(\{|\])/.test(l));
let lista;
try {
  lista = JSON.parse(linha);
} catch {
  process.stderr.write(`O PM2 não respondeu ao jlist: ${String(r.stdout || r.stderr || r.error?.message || '').trim().slice(0, 500)}\n`);
  process.exit(2);
}
for (const p of lista.filter((x) => String(x.name).startsWith('benura-'))) {
  process.stdout.write(`${p.name}\t${p.pm2_env?.status ?? '?'}\t${p.pm2_env?.restart_time ?? 0}\n`);
}

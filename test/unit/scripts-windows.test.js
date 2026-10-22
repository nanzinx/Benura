'use strict';
/**
 * [NOVO] Scripts do Windows (scripts/windows/*.ps1): o PowerShell 5.1 lê arquivo sem BOM
 * como ANSI (os acentos saem trocados), então todo .ps1 precisa do BOM do UTF-8. No
 * Windows (CI unitarios-windows), confere também a sintaxe com o parser do PowerShell.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PASTA = path.join(__dirname, '..', '..', 'scripts', 'windows');
const scripts = fs.readdirSync(PASTA).filter((f) => f.endsWith('.ps1'));

test('scripts do Windows: existem e todos têm o BOM do UTF-8', () => {
  assert.ok(scripts.includes('instalar-servico.ps1') && scripts.includes('vigia-pm2.ps1'));
  for (const f of scripts) {
    const inicio = fs.readFileSync(path.join(PASTA, f)).subarray(0, 3);
    assert.deepEqual([...inicio], [0xef, 0xbb, 0xbf], `${f} sem BOM`);
  }
});

test('scripts do Windows: sintaxe válida no PowerShell', { skip: process.platform !== 'win32' && 'só no Windows' }, () => {
  for (const f of scripts) {
    const arquivo = path.join(PASTA, f).replace(/'/g, "''");
    const comando = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${arquivo}', [ref]$null, [ref]$e); `
      + 'if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', comando], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stdout}${r.stderr}`);
  }
});

test('package.json: os comandos servico:* apontam para scripts que existem', () => {
  const { scripts: npm } = require('../../package.json');
  for (const nome of ['servico:instalar', 'servico:verificar', 'servico:desinstalar']) {
    const arquivo = /-File (\S+\.ps1)/.exec(npm[nome])?.[1];
    assert.ok(arquivo && fs.existsSync(path.join(__dirname, '..', '..', arquivo)), nome);
  }
});

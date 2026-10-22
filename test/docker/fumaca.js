'use strict';
/**
 * [NOVO] Teste de fumaça da imagem Docker (CI: job "docker"): sobe o container com uma
 * Argus falsa e confere que os quatro serviços ficam no ar (PM2 + /health), que o estado
 * vai para o volume /dados e que o painel consegue parar e religar os serviços pelo PM2
 * de dentro do container (botões "Desligar/Religar automação").
 *
 *   docker build -t benura:ci . && IMAGEM=benura:ci node test/docker/fumaca.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { criarArgusFake } = require('../rodizio/argus-fake');

const IMAGEM = process.env.IMAGEM || 'benura:ci';
const NOME = `benura-fumaca-${process.pid}`;
const SENHA = 'senha-fumaca-123';
const PORTAS = [3000, 3001, 3003, 3010];
const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

async function aguardar(teste, descricao, ms = 90_000) {
  const ate = Date.now() + ms;
  for (;;) {
    try { if (await teste()) return; } catch { /* ainda não */ }
    if (Date.now() > ate) throw new Error(`não aconteceu em ${ms / 1000} s: ${descricao}`);
    await esperar(1000);
  }
}

/** nome → status dos serviços do BenURA no PM2 de dentro do container. */
function servicos() {
  const saida = docker('exec', NOME, 'npx', 'pm2', 'jlist');
  const linha = saida.split(/\r?\n/).reverse().find((l) => /^\s*\[/.test(l));
  return Object.fromEntries(JSON.parse(linha).map((p) => [p.name.replace('benura-', ''), p.pm2_env.status]));
}
const todos = (status) => () => Object.values(servicos()).length === 4 && Object.values(servicos()).every((s) => s === status);
const saudaveis = async () => (await Promise.all(PORTAS.map((p) => fetch(`http://127.0.0.1:${p}/health`).then((r) => r.ok)))).every(Boolean);

async function main() {
  const argus = await criarArgusFake({
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900'] },
    ],
    status: { 100: 'livre', 200: 'livre', 900: 'livre' },
  });
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'benura-docker-'));
  const dados = path.join(pasta, 'dados');
  fs.mkdirSync(dados, { mode: 0o777 });
  fs.chmodSync(dados, 0o777); // o container roda como o usuário "node"
  const arquivoEnv = path.join(pasta, 'teste.env');
  fs.writeFileSync(arquivoEnv, [
    'DRY_RUN=1', 'USAR_MOCK=1', 'ARGUS_TOKEN=t', `ARGUS_BASE=${argus.url}`, 'GRUPO_URA_ID=2', 'GRUPOS_ROBOS_URA_IDS=3',
    'GRUPOS_ATIVOS_IDS=1', 'WEBHOOK_TOKEN=tok', `PAINEL_SENHA=${SENHA}`,
  ].join('\n'));
  try {
    docker('run', '-d', '--name', NOME, '--network', 'host', '--env-file', arquivoEnv, '-v', `${dados}:/dados`,
      '--tmpfs', '/run/benura:uid=1000,gid=1000', IMAGEM);
    await aguardar(todos('online'), 'os quatro serviços online no PM2');
    await aguardar(saudaveis, '/health de todos');
    if (!fs.readdirSync(dados).some((f) => f.startsWith('state-'))) throw new Error(`estado fora do volume: ${fs.readdirSync(dados)}`);
    console.log('✓ no ar:', JSON.stringify(servicos()));

    // O painel para e religa pelo PM2 de dentro do container.
    const entrar = await fetch('http://127.0.0.1:3010/api/entrar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Painel': '1' }, body: JSON.stringify({ senha: SENHA }),
    });
    const cookie = entrar.headers.get('set-cookie').split(';')[0];
    const pedir = (rota) => fetch(`http://127.0.0.1:3010/api/automacao/${rota}`, { method: 'POST', headers: { Cookie: cookie, 'X-Painel': '1' } });
    if ((await pedir('desligar')).status !== 202) throw new Error('desligar não foi aceito');
    await aguardar(() => { const s = servicos(); return s.painel === 'online' && ['roteador', 'rodizio', 'rotinas'].every((n) => s[n] === 'stopped'); },
      'desligar automação: os três parados, o painel no ar');
    console.log('✓ desligou pelo painel:', JSON.stringify(servicos()));
    if ((await pedir('religar')).status !== 202) throw new Error('religar não foi aceito');
    await aguardar(todos('online'), 'religar automação: todos online');
    console.log('✓ religou pelo painel');

    // Reiniciar o container: as travas (PID) ficam no tmpfs, então nada trava na volta.
    docker('restart', NOME);
    await aguardar(todos('online'), 'todos online depois do docker restart');
    await aguardar(saudaveis, '/health depois do docker restart');
    console.log('✓ docker restart: tudo de volta');
  } catch (e) {
    try { console.error(docker('logs', '--tail', '80', NOME)); } catch { /* sem container */ }
    throw e;
  } finally {
    try { docker('rm', '-f', NOME); } catch { /* já saiu */ }
    await argus.fechar();
  }
}

main().then(() => console.log('Imagem Docker ok'), (e) => { console.error(`✗ ${e.message}`); process.exit(1); });

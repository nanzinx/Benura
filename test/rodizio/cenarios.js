#!/usr/bin/env node
'use strict';
/**
 * Cenários de caracterização do rodízio Ativo ↔ URA e do controle de robôs.
 *
 * Cada cenário sobe uma Argus falsa, inicia o rodízio como processo separado
 * (exatamente como em produção), altera status de operadores e confere os
 * comandos que chegam à Argus.
 *
 *   node test/rodizio/cenarios.js                  roda contra argus-automacao.js deste repositório
 *   node test/rodizio/cenarios.js caminho/antigo.js  roda contra outra versão (ex.: a anterior à refatoração)
 *
 * A mesma suíte foi rodada contra a versão antiga e a nova para garantir que
 * a refatoração preservou o comportamento.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { criarArgusFake } = require('./argus-fake');

const RAIZ = path.join(__dirname, '..', '..');
const ALVO = path.resolve(process.argv[2] || path.join(RAIZ, 'argus-automacao.js'));
const TOKEN = 'tk';

const GRUPOS_BASE = [
  { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100', '101'] }, // Ativo
  { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200'] }, // URA
  { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901'] }, // Robôs
];
const STATUS_BASE = { 100: 'livre', 101: 'livre', 200: 'livre', 900: 'livre', 901: 'livre' };

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function aguardar(condicao, { timeoutMs = 8000, descricao = 'condição' } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (condicao()) return;
    await esperar(100);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}

function portaLivre() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** O script antigo grava a trava ao lado de si mesmo: roda uma cópia numa pasta temporária. */
function prepararAlvo(pasta) {
  const ehDesteRepositorio = path.dirname(ALVO) === RAIZ;
  if (ehDesteRepositorio) return ALVO;
  const copia = path.join(pasta, 'alvo.js');
  fs.copyFileSync(ALVO, copia);
  return copia;
}

async function iniciarRodizio({ grupos = GRUPOS_BASE, status = STATUS_BASE, env = {}, preparar } = {}) {
  const argus = await criarArgusFake({ grupos, status });
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-'));
  preparar?.({ argus, pasta });
  const porta = await portaLivre();
  const saida = [];

  const filho = spawn(process.execPath, [prepararAlvo(pasta)], {
    cwd: pasta,
    env: {
      PATH: process.env.PATH,
      BENURA_SEM_DOTENV: '1',
      ARGUS_TOKEN: 't',
      ARGUS_BASE: argus.url,
      GRUPO_URA_ID: '2',
      GRUPO_ROBOS_URA_ID: '3',
      GRUPOS_ATIVOS_IDS: '1',
      TEMPO_MIN: '0.1', // 6 s
      POLL_ATIVO_MS: '300',
      POLL_URA_MS: '300',
      REFRESH_GRUPOS_MS: '1000',
      MIN_ROBOS_OFF_MS: '500',
      WEBHOOK_GRACE_MS: '1500',
      WEBHOOK_TOKEN: TOKEN,
      PORT: String(porta),
      RODIZIO_PORT: String(porta),
      STATE_FILE: path.join(pasta, 'state.json'),
      RODIZIO_STATE_FILE: path.join(pasta, 'state.json'),
      RODIZIO_LOCK_FILE: path.join(pasta, 'argus.lock'),
      RETORNO_STATE_FILE: path.join(pasta, 'state-retorno-fila.json'),
      RETORNO_LOG_FILE: path.join(pasta, 'logs', 'retorno-fila.jsonl'),
      ...env,
    },
  });
  filho.stdout.on('data', (d) => saida.push(String(d)));
  filho.stderr.on('data', (d) => saida.push(String(d)));

  let saiu = null;
  filho.once('exit', (codigo) => { saiu = codigo; });

  const base = `http://127.0.0.1:${porta}`;
  const encerrarTudo = async () => {
    filho.kill('SIGTERM');
    await new Promise((r) => { if (saiu !== null) r(); filho.once('exit', r); setTimeout(r, 3000); });
    await argus.fechar();
    fs.rmSync(pasta, { recursive: true, force: true });
  };
  try {
    await aguardar(() => saiu !== null || saida.join('').match(/ouvindo|HTTP na porta|Rodízio iniciado/i), { descricao: 'rodízio iniciar' });
    if (saiu !== null) throw new Error(`o processo encerrou ao iniciar (código ${saiu}): ${saida.join('').trim().split('\n').pop()}`);
  } catch (e) {
    await encerrarTudo();
    throw e;
  }
  await esperar(800); // primeiro ciclo de grupos/status

  const chamadas = (comando) => argus.estado.chamadas.filter((c) => c.comando === comando);
  const transferencias = () => chamadas('transferiroperadorgrupo')
    .map((c) => `${c.dados.ramaisOperadores.join(',')}→${c.dados.idGrupoUsuarioDestino}`);

  return {
    argus,
    base,
    saida,
    chamadas,
    transferencias,
    webhook: (corpo, { token = TOKEN } = {}) => fetch(`${base}/webhook${token ? `?token=${token}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    }),
    encerrar: encerrarTudo,
  };
}

// ───────────────────────────── Cenários ─────────────────────────────

const CENARIOS = {
  async 'Ativo: atendeu e ficou livre → vai para a URA; quem não atendeu fica'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    if (r.transferencias().some((t) => t.startsWith('100→'))) throw new Error('100 não atendeu e foi movido');
  },

  async 'URA: volta ao grupo de origem só depois de TEMPO_MIN'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    const entrou = Date.now();
    await aguardar(() => r.transferencias().includes('101→1'), { timeoutMs: 12_000, descricao: '101→Ativo' });
    const segundos = (Date.now() - entrou) / 1000;
    if (segundos < 4.5) throw new Error(`voltou cedo demais (${segundos.toFixed(1)}s; TEMPO_MIN = 6s)`);
  },

  async 'URA: movido que fica offline volta imediatamente'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    r.argus.definirStatus('101', null);
    await aguardar(() => r.transferencias().includes('101→1'), { timeoutMs: 3000, descricao: '101 offline → Ativo' });
  },

  async 'Ativo: quem ficou offline perde o histórico de atendimento'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', null);
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await esperar(2000);
    if (r.transferencias().length) throw new Error(`não deveria transferir: ${r.transferencias()}`);
  },

  async 'Robôs: todos os humanos da URA ocupados → desliga; alguém livre → religa'(r) {
    if (r.chamadas('deslogaroperador').length) throw new Error('desligou robôs com humano livre');
    r.argus.definirStatus('200', 'em atendimento');
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
    const deslogados = r.chamadas('deslogaroperador').map((c) => String(c.dados.ramal)).sort();
    if (deslogados.join() !== '900,901') throw new Error(`deslogou ${deslogados}`);

    r.argus.definirStatus('200', 'livre');
    await aguardar(() => r.chamadas('logaroperadorvirtual').length >= 1, { descricao: 'religar robôs' });
    if (r.chamadas('logaroperadorvirtual')[0].dados.idGrupoUsuario !== 3) throw new Error('religou o grupo errado');
  },

  async 'Robôs: humano da URA em pausa conta como ocupado'(r) {
    r.argus.definirStatus('200', 'pausa');
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Robôs: URA sem humanos → desliga'(r) {
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Robôs: todos os humanos da URA offline → desliga'(r) {
    r.argus.definirStatus('200', null);
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Webhook de início de atendimento na URA → desliga robôs na hora'(r) {
    await esperar(500);
    const res = await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '200' });
    if (res.status !== 200) throw new Error(`webhook respondeu ${res.status}`);
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { timeoutMs: 1200, descricao: 'deslogar após webhook' });
  },

  async 'Webhook de início de atendimento no Ativo → marca histórico'(r) {
    // 101 nunca aparece "em atendimento" no status: só o webhook registra o atendimento.
    await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '101' });
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA pelo webhook' });
  },

  async 'Webhook sem token válido → 401 e nada acontece'(r) {
    const res = await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '200' }, { token: 'errado' });
    if (res.status !== 401) throw new Error(`esperava 401, veio ${res.status}`);
    await esperar(800);
    if (r.chamadas('deslogaroperador').length) throw new Error('webhook inválido teve efeito');
  },

  async 'Health responde'(r) {
    const res = await fetch(`${r.base}/health`);
    if (res.status !== 200) throw new Error(`health ${res.status}`);
  },

  // ── Correções (o script original falha nestes) ──

  async 'Correção: trava deixada por processo morto não impede o início'(r) {
    const res = await fetch(`${r.base}/health`);
    if (res.status !== 200) throw new Error('não iniciou');
  },

  async 'Correção: token inválido (HTTP 403) é reportado como erro de autenticação'(r) {
    await esperar(1500);
    const log = r.saida.join('');
    if (/rate limit/i.test(log)) throw new Error('403 tratado como limite de requisições');
    if (!/token/i.test(log)) throw new Error('nenhuma mensagem sobre o token');
  },

  async 'Correção: webhook tipo 5 com o campo "FidConclusaoDerivacao" (como na documentação)'(r) {
    await esperar(500);
    await r.webhook({ idTipoWebhook: 5, FidConclusaoDerivacao: 1, codUsuarioIntegracao: '200' });
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { timeoutMs: 1200, descricao: 'deslogar após webhook' });
  },

  // ── Retorno de quem desistiu da fila (novo: o script original não tem) ──

  async 'Retorno: abandonou a fila → lead na skill com origem RETORNO_URA'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await aguardar(() => r.chamadas('novo').length === 1, { descricao: 'POST /novo' });
    const [{ skill, dados }] = r.chamadas('novo');
    if (skill !== SKILL) throw new Error(`skill errada: ${skill}`);
    if (dados.telefone1 !== '11987654321' || dados.origem !== 'RETORNO_URA' || dados.info0 !== 'ABANDONOU_FILA') {
      throw new Error(`lead inesperado: ${JSON.stringify(dados)}`);
    }
  },

  async 'Retorno: mesmo telefone desiste duas vezes → um lead só'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await r.webhook(encerramentoUra({ conclusao: 4 }));
    await aguardar(() => r.chamadas('novo').length >= 1, { descricao: 'POST /novo' });
    await esperar(800);
    if (r.chamadas('novo').length !== 1) throw new Error(`${r.chamadas('novo').length} leads incluídos`);
  },

  async 'Retorno: cliente liga de novo e é atendido → retorno removido'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await aguardar(() => r.chamadas('novo').length === 1, { descricao: 'POST /novo' });
    await r.webhook(encerramentoUra({ conclusao: 1 }));
    await aguardar(() => r.chamadas('excluir').length === 1, { descricao: 'POST /excluir' });
    const { codCliente } = r.chamadas('excluir')[0].dados;
    if (codCliente !== r.chamadas('novo')[0].dados.codCliente) throw new Error(`codCliente diferente: ${codCliente}`);
  },

  async 'Retorno: desligado (padrão) → nada vai para o mailing'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await esperar(800);
    if (r.chamadas('novo').length) throw new Error('lead incluído com o retorno desligado');
  },
};

const SKILL = 'hash-skill-retorno';
const RETORNO_LIGADO = { env: { RETORNO_FILA_ATIVO: 'true', RETORNO_SKILL_HASH: SKILL } };

/** Webhook "Encerramento de URA" (tipo 5) como a Argus envia. */
const encerramentoUra = ({ conclusao }) => ({
  idTipoWebhook: 5,
  idConclusaoDerivacao: conclusao,
  telefone: '5511987654321',
  servicoDesc: 'CONSIGNADO',
  dataInicioUra: '2026-10-08T10:00:00',
});

/** PID que certamente não existe (processo já encerrado). */
function pidMorto() {
  const { pid } = require('child_process').spawnSync(process.execPath, ['-e', '0']);
  return pid;
}

const VARIACOES = {
  'Robôs: URA sem humanos → desliga': {
    grupos: GRUPOS_BASE.map((g) => (g.idGrupoUsuario === 2 ? { ...g, ramaisOperadores: [] } : g)),
  },
  'Correção: trava deixada por processo morto não impede o início': {
    preparar: ({ pasta }) => fs.writeFileSync(path.join(pasta, 'argus.lock'), String(pidMorto())),
  },
  'Correção: token inválido (HTTP 403) é reportado como erro de autenticação': {
    preparar: ({ argus }) => { argus.estado.responderComStatusHttp = 403; },
  },
  'Retorno: abandonou a fila → lead na skill com origem RETORNO_URA': RETORNO_LIGADO,
  'Retorno: mesmo telefone desiste duas vezes → um lead só': RETORNO_LIGADO,
  'Retorno: cliente liga de novo e é atendido → retorno removido': RETORNO_LIGADO,
};

// ───────────────────────────── Execução ─────────────────────────────

async function main() {
  const filtro = process.env.CENARIO;
  console.log(`Alvo: ${path.relative(process.cwd(), ALVO) || ALVO}\n`);
  let falhas = 0;

  for (const [nome, cenario] of Object.entries(CENARIOS)) {
    if (filtro && !nome.includes(filtro)) continue;
    const inicio = Date.now();
    let rodizio;
    try {
      rodizio = await iniciarRodizio(VARIACOES[nome]);
      await cenario(rodizio);
      console.log(`  ✓ ${nome} (${((Date.now() - inicio) / 1000).toFixed(1)}s)`);
    } catch (e) {
      falhas++;
      console.log(`  ✗ ${nome}\n      ${e.message}`);
      if (process.env.DEBUG_CENARIOS && rodizio) console.log(rodizio.saida.join('').split('\n').slice(-25).join('\n'));
    } finally {
      await rodizio?.encerrar();
    }
  }

  console.log(`\n${falhas ? `${falhas} cenário(s) falharam` : 'Todos os cenários passaram'}`);
  process.exitCode = falhas ? 1 : 0;
}

main();

'use strict';
/**
 * Automação Argus — rodízio Ativo <-> Receptivo URA + desligamento instantâneo dos robôs
 * Requisitos: Node.js 18+ (fetch nativo). Zero dependências.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ----------------------------- CONFIG (.env / variáveis de ambiente) -----------------------------
const CFG = {
  token: process.env.ARGUS_TOKEN,                                   // Token-Signature
  base: (process.env.ARGUS_BASE || 'https://argus.app.br/apiargus/cmd').replace(/\/$/, ''),
  grupoUraId: Number(process.env.GRUPO_URA_ID),                     // idGrupoUsuario do grupo OPERACIONAL do receptivo URA
  grupoRobosId: Number(process.env.GRUPO_ROBOS_URA_ID),             // idGrupoUsuario do grupo VIRTUAL (robôs URA)
  gruposAtivosIds: (process.env.GRUPOS_ATIVOS_IDS || '')            // opcional: restringe grupos ativos (vazio = todos operacionais, exceto URA)
    .split(',').map(s => s.trim()).filter(Boolean).map(Number),
  tempoMs: Number(process.env.TEMPO_MIN || 3) * 60_000,
  pollAtivoMs: Number(process.env.POLL_ATIVO_MS || 3000),
  pollUraMs: Number(process.env.POLL_URA_MS || 500),                // loop rápido: garante o menor tempo de resposta
  refreshGruposMs: Number(process.env.REFRESH_GRUPOS_MS || 30_000),
  reativarRobos: process.env.REATIVAR_ROBOS !== 'false',
  minRobosOffMs: Number(process.env.MIN_ROBOS_OFF_MS || 3000),      // histerese anti-"liga/desliga"
  concorrencia: Number(process.env.CONCORRENCIA || 20),
  porta: Number(process.env.PORT || 3000),
  webhookToken: process.env.WEBHOOK_TOKEN || '',                    // use ?token=XXX na URL cadastrada no Argus
  reLivre: new RegExp(process.env.REGEX_LIVRE || 'livre|dispon', 'i'),
  reAtendimento: new RegExp(process.env.REGEX_ATENDIMENTO || 'atendimento|falando|conversa', 'i'),
  debug: process.env.DEBUG === '1',
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'state.json'),
};

for (const k of ['token', 'grupoUraId', 'grupoRobosId']) {
  if (!CFG[k] || Number.isNaN(CFG[k])) { console.error(`Config obrigatória ausente: ${k}`); process.exit(1); }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => CFG.debug && log('[debug]', ...a);

// ----------------------------- Cliente HTTP -----------------------------
async function api(endpoint, body = {}, timeout = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`${CFG.base}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Token-Signature': CFG.token },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, ...j };
  } catch (e) {
    // Trata erros de rede ou timeout (AbortError)
    return { codStatus: -1, descStatus: e.name === 'AbortError' ? 'Timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.codStatus === 1) return r;
    last = r;
  }
  return last;
}

async function pMap(items, fn, limit = CFG.concorrencia) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ----------------------------- Estado -----------------------------
let movidos = {};
try { movidos = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch { /* primeiro start */ }
const salvar = () => fs.writeFile(CFG.stateFile, JSON.stringify(movidos, null, 2), () => {});

let gruposAtivos = [];
let uraRamais = new Set();
let robosRamais = [];
const uraStatus = new Map();
const travados = new Set();
let robosEstado = 'unknown';
let robosOffDesde = 0;
const statusVistos = new Set();
const historicoAtendimentoAtivo = new Map();

// ----------------------------- Leitura de grupos / status -----------------------------
async function atualizarGrupos() {
  const r = await api('listargrupos', {}, 5000);
  if (r.codStatus !== 1) return log('listargrupos falhou:', r.descStatus || r.http);
  const grupos = r.grupos || [];

  const ura = grupos.find(g => g.idGrupoUsuario === CFG.grupoUraId);
  const uraOps = (ura?.ramaisOperadores || []).map(String); // padroniza para string

  // Limpeza de movidos: remove quem estava na base local mas não pertence mais ao grupo URA no Argus
  let alterouMovidos = false;
  for (const m of Object.keys(movidos)) {
    if (!uraOps.includes(String(m))) {
      delete movidos[m];
      alterouMovidos = true;
    }
  }
  if (alterouMovidos) salvar();

  uraRamais = new Set(uraOps);

  const robos = grupos.find(g => g.idGrupoUsuario === CFG.grupoRobosId);
  robosRamais = robos?.ramaisOperadores || robosRamais;

  gruposAtivos = grupos.filter(g =>
    g.idTipoGrupo === 1 &&
    g.idGrupoUsuario !== CFG.grupoUraId &&
    (CFG.gruposAtivosIds.length === 0 || CFG.gruposAtivosIds.includes(g.idGrupoUsuario))
  );

  dbg(`grupos: ura=${uraRamais.size} robos=${robosRamais.length} ativos=${gruposAtivos.length}`);
}

function classificar(s) {
  const d = s?.descricaoStatus || '';
  if (CFG.debug && d && !statusVistos.has(d)) { statusVistos.add(d); log(`[debug] descricaoStatus visto: "${d}"`); }
  if (!s) return 'offline';
  if (CFG.reAtendimento.test(d)) return 'atendimento';
  if (CFG.reLivre.test(d) && !s.descricaoPausa) return 'livre';
  return 'outro';
}

async function lerStatus(ramal) {
  const r = await api('statusoperador', { ramal }, 2000);
  if (r.codStatus !== 1 || !r.statusOperador) return { classe: 'offline' };
  return { classe: classificar(r.statusOperador), s: r.statusOperador };
}

// ----------------------------- Transferências -----------------------------
async function transferir(ramal, destinoId) {
  const r = await api('transferiroperadorgrupo', { idGrupoUsuarioDestino: destinoId, ramaisOperadores: [ramal] }, 4000);
  return r.codStatus === 1 && (r.qtdeTransferidos ?? 1) >= 1;
}

async function loopAtivo() {
  const alvos = [];
  for (const g of gruposAtivos)
    for (const ramal of g.ramaisOperadores || [])
      if (!movidos[ramal] && !uraRamais.has(String(ramal)) && !travados.has(String(ramal))) {
        alvos.push({ ramal: String(ramal), grupo: g.idGrupoUsuario });
      }

  await pMap(alvos, async ({ ramal, grupo }) => {
    const { classe, s } = await lerStatus(ramal);
    // Validação estrita de idGrupo para string
    if (String(s.idGrupo) !== String(grupo)) return; // ignora se não estiver de fato neste grupo

    if (classe === 'atendimento') {
      historicoAtendimentoAtivo.set(ramal, true);
      return;
    }

    if (classe === 'offline') {
      historicoAtendimentoAtivo.delete(ramal);
      return;
    }

    if (classe === 'livre' && historicoAtendimentoAtivo.get(ramal)) {
      travados.add(ramal);
      try {
        if (await transferir(ramal, CFG.grupoUraId)) {
          movidos[ramal] = { origemGrupoId: grupo, entrouEm: Date.now() };
          uraRamais.add(ramal); uraStatus.set(ramal, 'livre'); salvar();
          historicoAtendimentoAtivo.delete(ramal); // limpa o histórico
          log(`ATIVO->URA ramal=${ramal} origem=${grupo} (após atendimento no ativo)`);
        } else log(`falha ao mover ${ramal} para URA`);
      } finally { travados.delete(ramal); }
    }
  });
}

async function loopUra() {
  const ramais = [...uraRamais];
  await pMap(ramais, async (ramal) => {
    const { classe } = await lerStatus(ramal);
    uraStatus.set(ramal, classe);

    const m = movidos[ramal];
    if (m && !travados.has(ramal)) {
      const tempoExpirou = Date.now() - m.entrouEm >= CFG.tempoMs && classe !== 'atendimento';
      const deslogou = classe === 'offline';

      if (tempoExpirou || deslogou) {
        travados.add(ramal);
        try {
          if (await transferir(ramal, m.origemGrupoId)) {
            delete movidos[ramal]; uraRamais.delete(ramal); uraStatus.delete(ramal); salvar();
            log(`URA->ATIVO ramal=${ramal} destino=${m.origemGrupoId} (motivo: ${deslogou ? 'offline' : 'tempo expirado'})`);
          } else log(`falha ao devolver ${ramal} ao grupo ${m.origemGrupoId}`);
        } finally { travados.delete(ramal); }
      }
    }
  });
  await avaliarRobos();
}

// ----------------------------- Robôs: desligar o mais rápido possível -----------------------------
let avaliando = false;
async function avaliarRobos() {
  if (avaliando) return; avaliando = true;
  try {
    const humanos = [...uraRamais].filter(r => uraStatus.get(r) !== 'offline');

    if (humanos.length === 0) {
      // Se não há humanos logados na URA, garantir que todos os robôs sejam desligados
      if (robosEstado !== 'off') await desligarRobos();
      return;
    }

    const todosOcupados = humanos.every(r => uraStatus.get(r) === 'atendimento');

    if (todosOcupados) {
      if (robosEstado !== 'off') await desligarRobos();
    } else if (CFG.reativarRobos && robosEstado === 'off') {
      // Histerese simplificada e segura baseada puramente no tempo
      if (Date.now() - robosOffDesde >= CFG.minRobosOffMs) await religarRobos();
    }
  } finally { avaliando = false; }
}

async function desligarRobos() {
  const t0 = process.hrtime.bigint();
  robosEstado = 'off'; robosOffDesde = Date.now();
  const res = await Promise.all(robosRamais.map(ramal =>
    retry(() => api('deslogaroperador', { ramal }, 1500), 3)));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const falhas = res.filter(r => r?.codStatus !== 1).length;
  log(`ROBÔS DESLIGADOS: ${robosRamais.length - falhas}/${robosRamais.length} em ${ms.toFixed(0)}ms`);
  if (falhas) robosEstado = 'unknown'; // se houve falha parcial, tenta de novo no próximo ciclo
}

async function religarRobos() {
  const r = await retry(() => api('logaroperadorvirtual', { idGrupoUsuario: CFG.grupoRobosId }, 4000));
  if (r?.codStatus === 1) { robosEstado = 'on'; log(`ROBÔS RELIGADOS: ${r.qtdeLogados} logados, ${r.qtdeFalhas} falhas`); }
  else log('falha ao religar robôs:', r?.descStatus);
}

// ----------------------------- Webhook (caminho mais rápido) -----------------------------
http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/webhook')) { res.writeHead(404).end(); return; }
  if (CFG.webhookToken && new URL(req.url, 'http://x').searchParams.get('token') !== CFG.webhookToken) {
    res.writeHead(401).end(); return;
  }
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    res.writeHead(200).end('ok');
    try {
      const ev = JSON.parse(raw);
      const ramal = String(ev.codUsuarioIntegracao);
      if ((ev.idTipoWebhook === 1 || ev.idTipoWebhook === 5) && ramal) {
        if (uraRamais.has(ramal)) {
          uraStatus.set(ramal, 'atendimento');
          dbg(`webhook tipo ${ev.idTipoWebhook}: ${ramal} em atendimento`);
          avaliarRobos();
        } else {
          // Se não está na URA, consideramos que entrou em atendimento no ativo
          historicoAtendimentoAtivo.set(ramal, true);
        }
      }
    } catch (e) { dbg('webhook inválido', e.message); }
  });
}).listen(CFG.porta, () => log(`webhook ouvindo na porta ${CFG.porta}`));

// ----------------------------- Scheduler sem sobreposição -----------------------------
function every(ms, fn, nome) {
  const tick = async () => {
    const ini = Date.now();
    try { await fn(); } catch (e) { log(`erro em ${nome}:`, e.message); }
    setTimeout(tick, Math.max(0, ms - (Date.now() - ini)));
  };
  tick();
}

(async () => {
  await atualizarGrupos();
  every(CFG.refreshGruposMs, atualizarGrupos, 'grupos');
  every(CFG.pollAtivoMs, loopAtivo, 'loopAtivo');
  every(CFG.pollUraMs, loopUra, 'loopUra');
  log('automação iniciada', { tempoMin: CFG.tempoMs / 60000, reativarRobos: CFG.reativarRobos });
})();

process.on('unhandledRejection', e => log('unhandledRejection:', e));

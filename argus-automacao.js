'use strict';
/**
 * Automação Argus — rodízio Ativo <-> Receptivo URA + desligamento instantâneo dos robôs
 * 
 * Comportamento implementado:
 * - Movimentação para URA: Operadores que realizam um atendimento no grupo Ativo, ao ficarem livres,
 *   são transferidos para a URA (rodízio).
 * - Retorno para Ativo: Após TEMPO_MIN na URA, se não estiverem em atendimento, ou se ficarem offline,
 *   são devolvidos ao grupo ativo de origem.
 * - Desligamento de Robôs: Quando todos os humanos ONLINE na URA estão em atendimento,
 *   os robôs são deslogados para interromper a entrada de chamadas.
 * - Religamento de Robôs: Quando algum humano na URA volta a ficar livre, os robôs são religados.
 * 
 * Requisitos: Node.js 18+. Sem dependências.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ----------------------------- CONFIG -----------------------------
const CFG = {
  token: process.env.ARGUS_TOKEN,
  base: (process.env.ARGUS_BASE || 'https://argus.app.br/apiargus/cmd').replace(/\/$/, ''),
  grupoUraId: Number(process.env.GRUPO_URA_ID),
  grupoRobosId: Number(process.env.GRUPO_ROBOS_URA_ID),
  gruposAtivosIds: (process.env.GRUPOS_ATIVOS_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean).map(Number),
  tempoMs: Number(process.env.TEMPO_MIN || 3) * 60_000,
  pollAtivoMs: Number(process.env.POLL_ATIVO_MS || 3000),
  pollUraMs: Number(process.env.POLL_URA_MS || 500),
  refreshGruposMs: Number(process.env.REFRESH_GRUPOS_MS || 30_000),
  reativarRobos: process.env.REATIVAR_ROBOS !== 'false',
  minRobosOffMs: Number(process.env.MIN_ROBOS_OFF_MS || 3000),
  concorrencia: Number(process.env.CONCORRENCIA || 20),
  porta: Number(process.env.PORT || 3000),
  webhookToken: process.env.WEBHOOK_TOKEN || '',
  webhookGraceMs: Number(process.env.WEBHOOK_GRACE_MS || 1500),
  statusLivre: (process.env.STATUS_LIVRE || 'livre,disponivel').toLowerCase().split(',').map(s => s.trim()),
  statusAtend: (process.env.STATUS_ATENDIMENTO || 'em atendimento,falando,conversa').toLowerCase().split(',').map(s => s.trim()),
  debug: process.env.DEBUG === '1',
  dryRun: process.env.DRY_RUN === '1',
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'state.json'),
  lockFile: path.join(__dirname, 'argus.lock'),
};

if (!CFG.token || !CFG.grupoUraId || !CFG.grupoRobosId) {
  console.error('Config obrigatória ausente (ARGUS_TOKEN, GRUPO_URA_ID, GRUPO_ROBOS_URA_ID)');
  process.exit(1);
}
if (CFG.gruposAtivosIds.length === 0) {
  console.error('Config obrigatória vazia: GRUPOS_ATIVOS_IDS. A whitelist é necessária.');
  process.exit(1);
}

// ----------------------------- CICLO DE VIDA E LOCK -----------------------------
try {
  fs.writeFileSync(CFG.lockFile, String(process.pid), { flag: 'wx' });
} catch (e) {
  console.error(`ERRO: Lockfile presente. Outra instância rodando? Remova ${CFG.lockFile}`);
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => CFG.debug && log('[debug]', ...a);

// ----------------------------- ESTADO E PERSISTÊNCIA -----------------------------
let movidos = {};
try {
  movidos = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    try {
      movidos = JSON.parse(fs.readFileSync(`${CFG.stateFile}.bak`, 'utf8'));
      log('ALERTA: state.json corrompido, recuperado via .bak');
    } catch (e2) {
      log('ERRO CRÍTICO: Falha ao ler state.json e .bak. Início com state vazio!', e.message);
    }
  }
}

let saving = false;
let pendingSave = false;
async function salvar() {
  if (saving) { pendingSave = true; return; }
  saving = true;
  try {
    const tmp = `${CFG.stateFile}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(movidos, null, 2));
    await fs.promises.rename(tmp, CFG.stateFile);
    await fs.promises.copyFile(CFG.stateFile, `${CFG.stateFile}.bak`); // Backup atômico
  } catch (e) {
    log('Erro ao salvar state:', e.message);
  } finally {
    saving = false;
    if (pendingSave) { pendingSave = false; salvar(); }
  }
}

let gruposAtivos = [];
let uraRamais = new Set();
let robosRamais = [];
const uraStatusInfo = new Map(); // ramal -> { classe, ts, fromWebhook }
const travados = new Set();
let robosEstado = 'unknown';
let robosOffDesde = 0;
const statusVistos = new Set();
const historicoAtendimentoAtivo = new Map();

// Controle de observabilidade
let lastLoopUra = 0;
let lastLoopAtivo = 0;

// Rate Limit Global e Cooldown
let globalRateLimitUntil = 0;
const falhasTransf = new Map();
const proxTransf = new Map();

// ----------------------------- CLIENTE HTTP -----------------------------
async function api(endpoint, body = {}, timeout = 3000) {
  if (Date.now() < globalRateLimitUntil) return { codStatus: -1, classe: 'erro', descStatus: 'Global Rate Limited' };

  if (CFG.dryRun && ['transferiroperadorgrupo', 'deslogaroperador', 'logaroperadorvirtual'].includes(endpoint)) {
    log(`[DRY_RUN] POST /${endpoint}`, JSON.stringify(body));
    return { codStatus: 1, http: 200, qtdeTransferidos: 1, qtdeLogados: 1, qtdeFalhas: 0, descStatus: 'dry run' };
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(`${CFG.base}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Token-Signature': CFG.token },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    
    if (r.status === 429 || r.status === 403) {
      globalRateLimitUntil = Date.now() + 5000;
      log(`ALERTA: Rate limit atingido (${r.status}). Pausa global de 5s.`);
      return { codStatus: -1, classe: 'erro', http: r.status };
    }

    const j = await r.json().catch(() => ({}));
    if (r.status !== 200 || j.codStatus === -1) {
      return { codStatus: -1, classe: 'erro', http: r.status, ...j };
    }
    return { http: r.status, classe: 'ok', ...j };
  } catch (e) {
    return { codStatus: -1, classe: 'erro', descStatus: e.name === 'AbortError' ? 'Timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function retry(fn, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r.classe !== 'erro' && r.codStatus === 1) return r;
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

// ----------------------------- LEITURA DE STATUS -----------------------------
function classificar(s) {
  const d = (s?.descricaoStatus || '').trim().toLowerCase();
  if (CFG.debug && d && !statusVistos.has(d)) { statusVistos.add(d); log(`[debug] descricaoStatus visto: "${d}"`); }
  
  if (!s) return 'offline';
  if (CFG.statusAtend.includes(d)) return 'atendimento';
  if (CFG.statusLivre.includes(d) && !s.descricaoPausa) return 'livre';
  return 'outro';
}

async function lerStatus(ramal) {
  const r = await api('statusoperador', { ramal }, 2000);
  if (r.classe === 'erro') return { classe: 'erro' };
  if (r.codStatus !== 1 || !r.statusOperador) return { classe: 'offline' };
  return { classe: classificar(r.statusOperador), s: r.statusOperador, ts: Date.now() };
}

// ----------------------------- GRUPOS -----------------------------
async function atualizarGrupos() {
  const r = await api('listargrupos', {}, 5000);
  if (r.classe === 'erro' || r.codStatus !== 1 || !r.grupos) {
    log('listargrupos falhou:', r.descStatus);
    return;
  }
  const grupos = r.grupos;

  const ura = grupos.find(g => g.idGrupoUsuario === CFG.grupoUraId);
  if (!ura) {
    log('ALERTA: Grupo URA não encontrado na resposta, abortando limpeza de movidos');
    return;
  }

  const uraOps = (ura.ramaisOperadores || []).map(String);
  let alterouMovidos = false;
  const agora = Date.now();

  for (const [mRamal, mData] of Object.entries(movidos)) {
    if (!uraOps.includes(mRamal)) {
      if (agora - mData.entrouEm < 60000) continue; // período de graça de 60s
      mData.ausentes = (mData.ausentes || 0) + 1;
      if (mData.ausentes >= 2) {
        delete movidos[mRamal];
        alterouMovidos = true;
      }
    } else {
      mData.ausentes = 0; // reset
    }
  }
  if (alterouMovidos) salvar();

  uraRamais = new Set([...uraOps, ...Object.keys(movidos)]);

  const robos = grupos.find(g => g.idGrupoUsuario === CFG.grupoRobosId);
  robosRamais = robos?.ramaisOperadores || robosRamais;

  gruposAtivos = grupos.filter(g =>
    g.idTipoGrupo === 1 &&
    g.idGrupoUsuario !== CFG.grupoUraId &&
    CFG.gruposAtivosIds.includes(g.idGrupoUsuario)
  );

  dbg(`grupos: ura=${uraRamais.size} robos=${robosRamais.length} ativos=${gruposAtivos.length}`);
}

// ----------------------------- TRANSFERÊNCIAS -----------------------------
async function transferirSeguro(ramal, destinoId) {
  if ((proxTransf.get(ramal) || 0) > Date.now()) return false;
  
  const r = await api('transferiroperadorgrupo', { idGrupoUsuarioDestino: destinoId, ramaisOperadores: [ramal] }, 4000);
  const sucesso = r.codStatus === 1 && (r.qtdeTransferidos ?? 1) >= 1;
  
  if (sucesso) {
    falhasTransf.delete(ramal);
    return true;
  }
  
  if (r.classe !== 'erro') { // erro de negócio, não de rede
    const f = (falhasTransf.get(ramal) || 0) + 1;
    falhasTransf.set(ramal, f);
    proxTransf.set(ramal, Date.now() + Math.min(f * 60000, 300000)); // exponencial
    if (f >= 3) log(`ALERTA: Ramal ${ramal} falhou transferência ${f} vezes`);
  }
  return false;
}

// ----------------------------- LOOPS DE NEGÓCIO -----------------------------
async function loopAtivo() {
  const alvos = [];
  for (const g of gruposAtivos)
    for (const ramal of g.ramaisOperadores || [])
      if (!movidos[ramal] && !uraRamais.has(String(ramal)) && !travados.has(String(ramal))) {
        alvos.push({ ramal: String(ramal), grupo: g.idGrupoUsuario });
      }

  await pMap(alvos, async ({ ramal, grupo }) => {
    const { classe, s } = await lerStatus(ramal);
    if (classe === 'erro') return;

    if (classe === 'offline') {
      historicoAtendimentoAtivo.delete(ramal);
      return;
    }

    if (!s || String(s.idGrupo) !== String(grupo)) return; // Evita TypeError (offline sem s)

    if (classe === 'atendimento') {
      historicoAtendimentoAtivo.set(ramal, true);
      return;
    }

    if (classe === 'livre' && historicoAtendimentoAtivo.get(ramal)) {
      if (travados.has(ramal)) return;
      travados.add(ramal);
      try {
        if (await transferirSeguro(ramal, CFG.grupoUraId)) {
          movidos[ramal] = { origemGrupoId: grupo, entrouEm: Date.now() };
          uraRamais.add(ramal); uraStatusInfo.set(ramal, { classe: 'livre', ts: Date.now() }); salvar();
          historicoAtendimentoAtivo.delete(ramal);
          log(`ATIVO->URA ramal=${ramal} origem=${grupo}`);
        } else log(`falha ao mover ${ramal} para URA`);
      } finally { travados.delete(ramal); }
    }
  });
  lastLoopAtivo = Date.now();
}

async function loopUra() {
  const ramais = [...uraRamais];
  
  // Fase 1: Ler todos os status
  await pMap(ramais, async (ramal) => {
    const { classe, ts } = await lerStatus(ramal);
    if (classe !== 'erro') {
      const info = uraStatusInfo.get(ramal);
      // Ignora status livre temporário se o webhook chegou agora (grace period)
      if (classe === 'livre' && info?.fromWebhook && (Date.now() - info.ts < CFG.webhookGraceMs)) {
        // não sobrescreve
      } else {
        uraStatusInfo.set(ramal, { classe, ts: ts || Date.now() });
      }
    }
  });

  // Fase 2: Avalia os robôs IMEDIATAMENTE (antes que transferências longas bloqueiem)
  await avaliarRobos();

  // Fase 3: Transfere humanos de volta
  const alvos = ramais.filter(r => {
    const m = movidos[r];
    const info = uraStatusInfo.get(r);
    if (!m || !info || travados.has(r)) return false;
    return (Date.now() - m.entrouEm >= CFG.tempoMs && info.classe !== 'atendimento') || info.classe === 'offline';
  });

  await pMap(alvos, async (ramal) => {
    const m = movidos[ramal];
    const info = uraStatusInfo.get(ramal);
    if (!m || !info) return;

    travados.add(ramal);
    try {
      if (await transferirSeguro(ramal, m.origemGrupoId)) {
        delete movidos[ramal]; uraRamais.delete(ramal); uraStatusInfo.delete(ramal); salvar();
        log(`URA->ATIVO ramal=${ramal} destino=${m.origemGrupoId} (motivo: ${info.classe === 'offline' ? 'offline' : 'tempo expirado'})`);
      }
    } finally { travados.delete(ramal); }
  });

  lastLoopUra = Date.now();
  if (Date.now() - lastLoopUra > 5000 && CFG.debug) log('ALERTA: loopUra demorou > 5s');
}

// ----------------------------- CONTROLE DE ROBÔS -----------------------------
let avaliando = false;
let reavaliarPendente = false;

async function avaliarRobos() {
  if (avaliando) { reavaliarPendente = true; return; }
  avaliando = true;
  try {
    do {
      reavaliarPendente = false;
      const agora = Date.now();
      
      const humanos = [...uraRamais].filter(r => {
        const info = uraStatusInfo.get(r);
        return info && info.classe !== 'offline' && info.classe !== 'erro';
      });

      // A regra "sem humanos -> desligar" foi expressamente removida.
      if (humanos.length === 0) continue; 

      // Se há status velhos (> 6s), não age, para não derrubar/ligar robôs cegamente.
      if (humanos.some(r => agora - uraStatusInfo.get(r).ts > 6000)) {
        dbg('Ignorando avaliarRobos pois há status desatualizados');
        continue;
      }

      const todosOcupados = humanos.every(r => uraStatusInfo.get(r).classe === 'atendimento');

      if (todosOcupados) {
        if (robosEstado !== 'off') await desligarRobos();
      } else if (CFG.reativarRobos && robosEstado === 'off') {
        if (agora - robosOffDesde >= CFG.minRobosOffMs) await religarRobos();
      }
    } while (reavaliarPendente);
  } finally { avaliando = false; }
}

async function desligarRobos() {
  if (robosRamais.length === 0) { log('ERRO: Nenhum robô na lista para desligar'); return; }
  
  const t0 = process.hrtime.bigint();
  robosEstado = 'off'; robosOffDesde = Date.now();
  let pendentes = [...robosRamais];
  let falhas = 0;

  // Backoff exponencial para robôs que falharam (1, 2, 3 tentativas)
  for (let t = 1; t <= 3 && pendentes.length > 0; t++) {
    if (t > 1) await new Promise(r => setTimeout(r, 500 * (t - 1)));
    
    const res = await Promise.all(pendentes.map(async (ramal) => {
      const r = await api('deslogaroperador', { ramal }, 1500);
      if (r.codStatus === 1) return { ramal, ok: true };
      
      const desc = (r.descStatus || '').toLowerCase();
      // Trata "já deslogado" como sucesso
      if (desc.includes('já deslogado') || desc.includes('nao esta logado')) return { ramal, ok: true };
      
      if (CFG.debug) log(`Falha ao deslogar robo ${ramal}: ${r.descStatus}`);
      return { ramal, ok: false };
    }));
    pendentes = res.filter(x => !x.ok).map(x => x.ramal);
  }

  falhas = pendentes.length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  log(`ROBÔS DESLIGADOS: ${robosRamais.length - falhas}/${robosRamais.length} em ${ms.toFixed(0)}ms`);
  if (falhas) robosEstado = 'unknown'; // Retenta no próx ciclo
}

async function religarRobos() {
  const r = await retry(() => api('logaroperadorvirtual', { idGrupoUsuario: CFG.grupoRobosId }, 2000), 2);
  if (r?.codStatus === 1) { robosEstado = 'on'; log(`ROBÔS RELIGADOS: ${r.qtdeLogados} logados, ${r.qtdeFalhas} falhas`); }
  else log('falha ao religar robôs:', r?.descStatus);
}

// ----------------------------- WEBHOOK & HEALTH -----------------------------
http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ lastLoopUra, lastLoopAtivo, uptime: process.uptime() }));
  }

  if (req.method !== 'POST' || !req.url.startsWith('/webhook')) { res.writeHead(404).end(); return; }

  const tokenParams = new URL(req.url, 'http://x').searchParams.get('token');
  const tokenHeader = req.headers['x-webhook-token'];
  const t = tokenParams || tokenHeader;
  
  if (CFG.webhookToken) {
    if (!t || t.length !== CFG.webhookToken.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CFG.webhookToken))) {
      res.writeHead(401).end(); return;
    }
  }

  let raw = '';
  let aborted = false;
  req.on('data', c => {
    raw += c;
    if (raw.length > 65536) { aborted = true; req.destroy(); }
  });
  
  req.on('end', () => {
    if (aborted) return;
    res.writeHead(200).end('ok');
    try {
      const ev = JSON.parse(raw);
      if (!ev.codUsuarioIntegracao) return; // ramal ausente
      
      const ramal = String(ev.codUsuarioIntegracao);
      const isInicio = ev.idTipoWebhook === 1;
      const isFimDerivado = ev.idTipoWebhook === 5 && ev.idConclusaoDerivacao === 1;

      if ((isInicio || isFimDerivado) && ramal) {
        if (uraRamais.has(ramal)) {
          uraStatusInfo.set(ramal, { classe: 'atendimento', ts: Date.now(), fromWebhook: true });
          dbg(`webhook: ${ramal} atendimento`);
          avaliarRobos();
        } else {
          historicoAtendimentoAtivo.set(ramal, true);
        }
      }
    } catch (e) { dbg('webhook inválido', e.message); }
  });
}).listen(CFG.porta, () => log(`Servidor ouvindo na porta ${CFG.porta}`));

// ----------------------------- BOOT E AGENDAMENTO -----------------------------
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
  log('Automação iniciada', { tempoMin: CFG.tempoMs / 60000, dryRun: CFG.dryRun });
})();

// Graceful shutdown e cleanup
const graceful = async () => {
  log('Desligando graciosamente...');
  await salvar();
  try { fs.unlinkSync(CFG.lockFile); } catch (e) {}
  process.exit(0);
};
process.on('SIGINT', graceful);
process.on('SIGTERM', graceful);
process.on('uncaughtException', e => { log('uncaughtException:', e); graceful(); });
process.on('unhandledRejection', e => log('unhandledRejection:', e));

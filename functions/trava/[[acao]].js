/**
 * [NOVO] Cloudflare Pages Function: a trava dos dois PCs (servidor e reserva).
 *
 * Só um PC por vez age de verdade na Argus: quem age segura a trava e a renova.
 * Fica numa base D1 (TRAVA_DB): gravação consistente, ao contrário do KV, que
 * demora até 1 min para espalhar. A hora é a da Cloudflare, não a dos PCs.
 *
 *   GET  /trava            quem está com ela
 *   POST /trava/pegar      { dono, por, validadeMs, venceu } livre, já sua, ou (venceu: true) vencida
 *   POST /trava/renovar    { dono, validadeMs } só o dono
 *   POST /trava/soltar     { dono } só o dono
 *
 * Variáveis do projeto no Pages: TRAVA_SEGREDO (Secret) e o binding D1 TRAVA_DB.
 * Os PCs mandam o segredo no cabeçalho X-Benura-Trava.
 */

const VALIDADE_PADRAO_MS = 120_000;

const json = (status, corpo) => new Response(JSON.stringify(corpo), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** Compara em tempo constante (hash dos dois lados). */
async function iguais(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', enc.encode(String(v)))));
  const ax = new Uint8Array(x);
  const ay = new Uint8Array(y);
  let diferenca = 0;
  for (let i = 0; i < ax.length; i += 1) diferenca |= ax[i] ^ ay[i];
  return diferenca === 0;
}

const validade = (ms) => Math.min(600_000, Math.max(30_000, Number(ms) || VALIDADE_PADRAO_MS));

async function preparar(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS trava (id INTEGER PRIMARY KEY, dono TEXT, por TEXT, desde INTEGER, expira INTEGER NOT NULL DEFAULT 0)').run();
  await db.prepare('INSERT OR IGNORE INTO trava (id, expira) VALUES (1, 0)').run();
}

async function ler(db, agora) {
  const t = await db.prepare('SELECT dono, por, desde, expira FROM trava WHERE id = 1').first();
  const vale = Boolean(t?.dono) && t.expira > agora;
  return { dono: t?.dono ?? null, por: t?.por ?? null, desde: t?.desde ?? null, expira: t?.expira ?? 0, vale, venceEmMs: vale ? t.expira - agora : 0, agora };
}

export async function onRequest({ request, env, params }) {
  if (!env.TRAVA_DB || !env.TRAVA_SEGREDO) return json(500, { erro: 'Pages sem TRAVA_DB ou TRAVA_SEGREDO configurado' });
  if (!(await iguais(request.headers.get('X-Benura-Trava') ?? '', env.TRAVA_SEGREDO))) return json(403, { erro: 'Segredo da trava errado' });
  const acao = [].concat(params?.acao ?? []).join('/');
  const db = env.TRAVA_DB;
  await preparar(db);
  const agora = Date.now();

  if (request.method === 'GET' && acao === '') return json(200, await ler(db, agora));
  if (request.method !== 'POST') return json(404, { erro: 'Ação não encontrada' });
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return json(400, { erro: 'JSON inválido' });
  }
  const dono = String(corpo?.dono ?? '').trim().slice(0, 60);
  if (!dono) return json(400, { erro: 'Informe o dono' });

  if (acao === 'pegar') {
    const r = await db.prepare(`UPDATE trava SET dono = ?1, por = ?2, desde = CASE WHEN dono = ?1 THEN desde ELSE ?3 END, expira = ?3 + ?4
      WHERE id = 1 AND (dono IS NULL OR dono = ?1 OR expira <= ?3 AND ?5 = 1)`)
      .bind(dono, String(corpo.por ?? '').slice(0, 200) || null, agora, validade(corpo.validadeMs), corpo.venceu === true ? 1 : 0).run();
    return json(r.meta.changes === 1 ? 200 : 409, { ok: r.meta.changes === 1, ...(await ler(db, agora)) });
  }
  if (acao === 'renovar') {
    const r = await db.prepare('UPDATE trava SET expira = ?2 + ?3 WHERE id = 1 AND dono = ?1').bind(dono, agora, validade(corpo.validadeMs)).run();
    return json(r.meta.changes === 1 ? 200 : 409, { ok: r.meta.changes === 1, ...(await ler(db, agora)) });
  }
  if (acao === 'soltar') {
    await db.prepare('UPDATE trava SET dono = NULL, por = NULL, desde = NULL, expira = 0 WHERE id = 1 AND dono = ?1').bind(dono).run();
    return json(200, { ok: true, ...(await ler(db, agora)) });
  }
  return json(404, { erro: 'Ação não encontrada' });
}

/**
 * [NOVO] Cloudflare Pages: só os IPs da empresa entram no BenURA.
 *
 * Roda antes de tudo (a página, o /api e o resto). Compara o CF-Connecting-IP,
 * que a própria Cloudflare põe (o navegador não consegue mudar), com a lista
 * BENURA_IPS_PERMITIDOS do projeto no Pages: separada por vírgula, IPv4 ou IPv6,
 * com ou sem /prefixo (sem prefixo: só aquele IP).
 *   ex.: 201.93.163.133, 2804:1b3:a5e7:c3c7::/48
 *
 *  - /trava/* passa: os dois PCs precisam dela mesmo se o IP da empresa mudar,
 *    e ela já exige o TRAVA_SEGREDO.
 *  - sem a variável, passa tudo (com o cabeçalho X-Benura-Aviso): o deploy não
 *    tranca ninguém antes de a lista existir.
 */

/** @returns {{ v: 4|6, n: bigint } | null} */
export function lerIp(texto) {
  let t = String(texto ?? '').trim().toLowerCase();
  if (!t) return null;
  const v4 = (s) => {
    const p = s.split('.');
    if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
    return p.reduce((acc, x) => (acc << 8n) + BigInt(x), 0n);
  };
  if (!t.includes(':')) {
    const n = v4(t);
    return n === null ? null : { v: 4, n };
  }
  // IPv4 dentro do IPv6 (::ffff:a.b.c.d): vale como IPv4.
  const mapeado = /^(?:(?:0{1,4}:){5}|::)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (mapeado) {
    const n = v4(mapeado[1]);
    return n === null ? null : { v: 4, n };
  }
  t = t.replace(/%.*$/, '');
  const partes = t.split('::');
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(':') : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltam = 8 - esq.length - dir.length;
  if (partes.length === 1 ? esq.length !== 8 : faltam < 1) return null;
  const grupos = [...esq, ...Array(partes.length === 2 ? faltam : 0).fill('0'), ...dir];
  if (grupos.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return { v: 6, n: grupos.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n) };
}

/** @returns {{ v: 4|6, rede: bigint, bits: number, mascara: bigint } | null} */
export function lerFaixa(texto) {
  const [ip, prefixo] = String(texto ?? '').trim().split('/');
  const a = lerIp(ip);
  if (!a) return null;
  const total = a.v === 4 ? 32 : 128;
  const bits = prefixo === undefined ? total : Number(prefixo);
  if (!Number.isInteger(bits) || bits < 0 || bits > total || (prefixo !== undefined && !/^\d+$/.test(prefixo))) return null;
  const mascara = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(total - bits);
  return { v: a.v, rede: a.n & mascara, bits, mascara };
}

export function lerLista(texto) {
  return String(texto ?? '').split(/[,\s]+/).filter(Boolean).map(lerFaixa).filter(Boolean);
}

export function permitido(ip, faixas) {
  const a = lerIp(ip);
  return Boolean(a) && faixas.some((f) => f.v === a.v && (a.n & f.mascara) === f.rede);
}

const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bloqueado(ip) {
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BenURA · acesso bloqueado</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b1b3a;color:#e8eefc}main{max-width:420px;padding:32px 24px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#b9c6e4;line-height:1.5}code{background:#16295a;padding:2px 8px;border-radius:6px;color:#fff}</style></head>
<body><main><h1>Acesso só pela rede da Benconsig</h1><p>O BenURA só abre dos endereços da empresa.</p><p>Seu endereço: <code>${escapar(ip || 'desconhecido')}</code></p><p>Precisa entrar daqui? Peça para incluir esse endereço.</p></main></body></html>`;
  return new Response(html, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

export async function onRequest({ request, env, next }) {
  const { pathname } = new URL(request.url);
  if (pathname === '/trava' || pathname.startsWith('/trava/')) return next();
  const lista = String(env.BENURA_IPS_PERMITIDOS ?? '').trim();
  if (!lista) {
    const r = await next();
    const resposta = new Response(r.body, r);
    resposta.headers.set('X-Benura-Aviso', 'BENURA_IPS_PERMITIDOS não configurado: qualquer IP entra');
    return resposta;
  }
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!permitido(ip, lerLista(lista))) return bloqueado(ip);
  return next();
}

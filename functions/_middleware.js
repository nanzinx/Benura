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

/** Nonce de uso único: o script da tela de bloqueio roda, nenhum outro. */
export function novoNonce() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}

/** Cabeçalhos da tela de bloqueio: nada de fora, o estilo dela e só o script com o nonce. */
export function cabecalhosDoBloqueio(nonce = novoNonce()) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

const ESTILO = `
:root{--fundo:#071a3d;--fundo2:#0f2f6b;--cartao:rgba(17,28,51,.72);--borda:rgba(143,178,245,.18);--texto:#eef3fc;--suave:#a9bbdf;--linha:rgba(143,178,245,.12);--amarelo:#f5b800;--alerta:#ff6b6b;--chip:#16295a;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--fundo:#eef3fc;--fundo2:#dfe8f9;--cartao:rgba(255,255,255,.82);--borda:rgba(19,61,140,.14);--texto:#0a2350;--suave:#4a5b7c;--linha:rgba(19,61,140,.1);--alerta:#d64545;--chip:#eef3fc;color-scheme:light}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;font-family:Inter,"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--texto);background:radial-gradient(1200px 600px at 15% -10%,var(--fundo2),transparent 60%),radial-gradient(900px 500px at 110% 110%,rgba(245,184,0,.12),transparent 60%),var(--fundo);overflow-x:hidden}
.bolha{position:fixed;border-radius:50%;filter:blur(60px);opacity:.35;pointer-events:none;animation:flutuar 14s ease-in-out infinite alternate}
.b1{width:320px;height:320px;background:#2f63d6;top:-80px;left:-60px}
.b2{width:260px;height:260px;background:#f5b800;bottom:-90px;right:-40px;opacity:.2;animation-delay:-6s}
.eq{position:fixed;left:0;right:0;bottom:0;height:120px;display:flex;align-items:flex-end;justify-content:center;gap:10px;opacity:.12;pointer-events:none}
.eq i{display:block;width:10px;border-radius:6px 6px 0 0;background:var(--amarelo);transform-origin:bottom;animation:eq 1.6s ease-in-out infinite alternate}
.eq i:nth-child(odd){background:#8fb2f5}
.cartao{position:relative;width:100%;max-width:460px;padding:32px 28px 24px;border:1px solid var(--borda);border-radius:24px;background:var(--cartao);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 30px 80px -30px rgba(0,0,0,.55);text-align:center;animation:subir .6s cubic-bezier(.2,.8,.2,1) both}
.marca{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.01em}
.marca b{color:var(--amarelo)}
.marca svg{width:34px;height:34px}
.selo{position:relative;width:96px;height:96px;margin:26px auto 18px;display:grid;place-items:center}
.selo .nucleo{position:relative;z-index:1;width:76px;height:76px;border-radius:24px;display:grid;place-items:center;background:linear-gradient(145deg,#ff7a7a,#d64545);box-shadow:0 14px 30px -10px rgba(214,69,69,.7);animation:pulo .7s .15s cubic-bezier(.2,.8,.2,1.3) both}
.selo svg{width:38px;height:38px}
.onda{position:absolute;inset:10px;border-radius:28px;border:2px solid var(--alerta);opacity:0;animation:onda 2.4s 0.8s ease-out infinite}
.onda.o2{animation-delay:2s}
.etiqueta{display:inline-block;margin:0 0 10px;padding:4px 10px;border-radius:999px;background:rgba(214,69,69,.14);color:var(--alerta);font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0 0 8px;font-size:26px;line-height:1.2;letter-spacing:-.02em}
.sub{margin:0 auto 22px;max-width:360px;color:var(--suave);line-height:1.55;font-size:15px}
.sub b{color:var(--texto)}
.dados{margin:0 0 20px;padding:0;border:1px solid var(--linha);border-radius:16px;text-align:left;overflow:hidden}
.dados div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;animation:surgir .45s ease-out both}
.dados div+div{border-top:1px solid var(--linha)}
.dados div:nth-child(1){animation-delay:.3s}.dados div:nth-child(2){animation-delay:.38s}.dados div:nth-child(3){animation-delay:.46s}
dt{color:var(--suave);font-size:13px;white-space:nowrap}
.dados .ip{display:grid;gap:8px;justify-content:stretch}
.dados .ip dd{justify-content:space-between;text-align:left}
.dados .ip code{flex:1;text-align:left}
dd{margin:0;display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;text-align:right;min-width:0}
code{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;background:var(--chip);border:1px solid var(--linha);padding:4px 8px;border-radius:8px;font-size:13px;overflow-wrap:anywhere}
button{font:inherit;cursor:pointer;border-radius:10px;transition:transform .15s,background-color .15s,box-shadow .15s}
button:active{transform:scale(.97)}
button:focus-visible{outline:2px solid var(--amarelo);outline-offset:2px}
.copiar{border:1px solid var(--borda);background:transparent;color:var(--texto);padding:4px 10px;font-size:12px;font-weight:700;white-space:nowrap}
.copiar:hover{background:var(--linha)}
.copiar.ok{border-color:#34c38f;color:#34c38f}
.passos{margin:0 0 22px;padding:0;list-style:none;text-align:left;display:grid;gap:10px}
.passos li{display:flex;gap:12px;align-items:flex-start;color:var(--suave);font-size:14px;line-height:1.5;animation:surgir .45s ease-out both}
.passos li:nth-child(1){animation-delay:.55s}.passos li:nth-child(2){animation-delay:.63s}
.passos b{color:var(--texto)}
.n{flex:none;width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:rgba(245,184,0,.16);color:var(--amarelo);font-weight:800;font-size:13px}
.denovo{width:100%;border:0;padding:12px 16px;background:var(--amarelo);color:#0a2350;font-weight:800;font-size:15px;display:inline-flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 10px 24px -12px rgba(245,184,0,.9)}
.denovo:hover{background:#ffc933}
.denovo svg{width:18px;height:18px}
.denovo.girando svg{animation:girar .8s linear infinite}
.rodape{margin:18px 0 0;color:var(--suave);font-size:12px;opacity:.8}
@keyframes subir{from{opacity:0;transform:translateY(18px) scale(.98)}to{opacity:1;transform:none}}
@keyframes surgir{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes pulo{from{opacity:0;transform:scale(.5) rotate(-8deg)}to{opacity:1;transform:none}}
@keyframes onda{0%{opacity:.7;transform:scale(1)}100%{opacity:0;transform:scale(1.55)}}
@keyframes eq{from{transform:scaleY(.25)}to{transform:scaleY(1)}}
@keyframes flutuar{from{transform:translate(0,0)}to{transform:translate(40px,30px)}}
@keyframes girar{to{transform:rotate(360deg)}}
@media (max-width:420px){.cartao{padding:26px 18px 20px}h1{font-size:23px}.dados div{flex-wrap:wrap}.dados dd{text-align:left}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.onda{display:none}}
`;

const LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0A2350"/><rect x="12" y="26" width="6" height="12" rx="3" fill="#fff"/><rect x="22" y="16" width="6" height="32" rx="3" fill="#F5B800"/><rect x="32" y="21" width="6" height="22" rx="3" fill="#fff"/><rect x="42" y="12" width="6" height="40" rx="3" fill="#F5B800"/><rect x="52" y="27" width="4" height="10" rx="2" fill="#fff" opacity=".6"/></svg>';
const CADEADO = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/><circle cx="12" cy="16" r="1.3" fill="#fff"/></svg>';
const RECARREGAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>';
/** Alturas das barrinhas do fundo (o equalizador da marca), e o atraso de cada uma. */
const BARRAS = [40, 75, 55, 95, 60, 85, 45, 70, 100, 50, 80, 65, 90, 55, 75, 45, 85, 60]
  .map((h, i) => `<i style="height:${h}%;animation-delay:${-(i * 0.17).toFixed(2)}s"></i>`).join('');

/** A tela de bloqueio (o benura-painel também a usa, para quem entra pelo túnel direto). */
export function paginaBloqueada(ip, nonce = '') {
  const mostrar = escapar(ip || 'desconhecido');
  const n = escapar(nonce);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="theme-color" content="#0a2350"><title>BenURA · Acesso bloqueado</title><style>${ESTILO}</style></head>
<body><span class="bolha b1" aria-hidden="true"></span><span class="bolha b2" aria-hidden="true"></span><div class="eq" aria-hidden="true">${BARRAS}</div>
<main class="cartao">
<div class="marca">${LOGO}<span>Ben<b>URA</b></span></div>
<div class="selo" aria-hidden="true"><span class="onda"></span><span class="onda o2"></span><span class="nucleo">${CADEADO}</span></div>
<p class="etiqueta">Erro 403 · fora da rede</p>
<h1>Acesso bloqueado</h1>
<p class="sub"><b>Acesso só pela rede da Benconsig.</b> O BenURA mostra a operação ao vivo e só abre nos endereços da empresa.</p>
<dl class="dados">
<div class="ip"><dt>Seu IP</dt><dd><code id="ip">${mostrar}</code><button type="button" class="copiar" id="copiar">Copiar</button></dd></div>
<div><dt>Motivo</dt><dd>Este endereço não está na lista da empresa</dd></div>
<div><dt>Agora</dt><dd id="hora">—</dd></div>
</dl>
<ol class="passos">
<li><span class="n">1</span><span><b>Está na empresa?</b> Conecte-se à rede da Benconsig e tente de novo.</span></li>
<li><span class="n">2</span><span><b>Precisa entrar daqui?</b> Mande o IP acima para quem cuida do BenURA incluir na lista.</span></li>
</ol>
<button type="button" class="denovo" id="denovo">${RECARREGAR}Tentar de novo</button>
<p class="rodape">BenURA · Benconsig</p>
</main>
<script nonce="${n}">
(function () {
  var hora = document.getElementById('hora');
  function tique() { hora.textContent = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }); }
  tique(); setInterval(tique, 1000);
  var copiar = document.getElementById('copiar');
  copiar.addEventListener('click', function () {
    var texto = document.getElementById('ip').textContent;
    var feito = function () { copiar.textContent = 'Copiado!'; copiar.classList.add('ok'); setTimeout(function () { copiar.textContent = 'Copiar'; copiar.classList.remove('ok'); }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(texto).then(feito, function () {});
  });
  var denovo = document.getElementById('denovo');
  denovo.addEventListener('click', function () { denovo.classList.add('girando'); setTimeout(function () { location.reload(); }, 450); });
})();
</script></body></html>`;
}

function bloqueado(ip) {
  const nonce = novoNonce();
  return new Response(paginaBloqueada(ip, nonce), { status: 403, headers: cabecalhosDoBloqueio(nonce) });
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

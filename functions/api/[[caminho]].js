/**
 * Cloudflare Pages Function: o /api do painel (página no Pages) vai para o
 * benura-painel do servidor, pelo Cloudflare Tunnel.
 *
 * Para o navegador continua tudo no mesmo endereço (https://benura.benconsig.com.br):
 * cookie de sessão, conferência de origem e CSP seguem como no servidor. O endereço
 * do túnel (BENURA_API_URL) fica fechado no Cloudflare Access: só entra quem traz o
 * service token, e o servidor ainda exige o PAINEL_PROXY_SEGREDO.
 *
 * Variáveis do projeto no Pages (Production, como "Secret"):
 *   BENURA_API_URL            https://benura-api.benconsig.com.br
 *   CF_ACCESS_CLIENT_ID       service token do Access
 *   CF_ACCESS_CLIENT_SECRET
 *   PAINEL_PROXY_SEGREDO      o mesmo do .env do servidor
 */

const SEM_CORPO = new Set(['GET', 'HEAD']);

const erro = (status, mensagem) => new Response(JSON.stringify({ erro: mensagem }), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export async function onRequest({ request, env }) {
  if (!env.BENURA_API_URL || !env.PAINEL_PROXY_SEGREDO) return erro(500, 'Pages sem BENURA_API_URL ou PAINEL_PROXY_SEGREDO configurado');
  const url = new URL(request.url);
  const destino = new URL(url.pathname + url.search, env.BENURA_API_URL);

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('X-Benura-Proxy', env.PAINEL_PROXY_SEGREDO);
  // Quem abriu a página: no servidor, o CF-Connecting-IP seria o da própria Cloudflare.
  headers.set('X-Benura-Cliente-IP', request.headers.get('CF-Connecting-IP') ?? '');
  if (env.CF_ACCESS_CLIENT_ID) {
    headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET ?? '');
  }

  try {
    return await fetch(destino, {
      method: request.method,
      headers,
      body: SEM_CORPO.has(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    });
  } catch {
    return erro(502, 'Servidor do BenURA fora do ar (o túnel não respondeu)');
  }
}

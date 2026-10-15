'use strict';
/**
 * Página de GET /ura (rodízio): ligar e desligar a URA cheia.
 * Autocontida (sem CDN): roda no PC do expediente, às vezes sem internet.
 */

const PAGINA_URA = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BenURA · URA cheia</title>
<style>
  :root { --fundo:#f6f7f9; --cartao:#fff; --texto:#1c2430; --suave:#5b6675; --borda:#d9dee5; --primaria:#1d5fd1; --ok:#1b7f45; --erro:#b42318; --aviso:#9a5b00; }
  @media (prefers-color-scheme: dark) {
    :root { --fundo:#12161c; --cartao:#1b2129; --texto:#e6e9ee; --suave:#9aa5b3; --borda:#2c3440; --primaria:#5b9bff; --ok:#4cc38a; --erro:#ff6b5e; --aviso:#f0b35a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:720px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:var(--suave); margin:0 0 20px; }
  .cartao { background:var(--cartao); border:1px solid var(--borda); border-radius:10px; padding:16px; margin-bottom:16px; }
  .estado { font-size:20px; font-weight:700; }
  .ligada { color:var(--ok); } .desligada { color:var(--suave); }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; margin:12px 0 0; }
  dt { color:var(--suave); } dd { margin:0; font-variant-numeric:tabular-nums; }
  ul { margin:0; padding-left:20px; }
  .linha { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-top:12px; }
  input[type=password] { padding:8px; border:1px solid var(--borda); border-radius:8px; background:var(--fundo); color:var(--texto); }
  button { background:var(--primaria); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  button.secundario { background:transparent; color:var(--texto); border:1px solid var(--borda); }
  .ok { color:var(--ok); } .erro { color:var(--erro); } .aviso { color:var(--aviso); }
</style>
</head>
<body>
<main>
  <h1>URA cheia</h1>
  <p class="sub">Quando pedirem todo mundo na URA, e para ajustar os robôs por livre. O BenURA continua cuidando dos robôs (proporcionais aos livres), da telefonia e da regra do ocioso.</p>

  <div class="cartao">
    <div class="estado" id="estado">Carregando…</div>
    <dl>
      <dt>Humanos na URA</dt><dd id="humanos">–</dd>
      <dt>Robôs ligados / alvo</dt><dd id="robos">–</dd>
      <dt>Ainda na telefonia de outro grupo</dt><dd id="presos">–</dd>
    </dl>
    <p class="aviso" id="dryrun" hidden>DRY_RUN ligado: o BenURA só simula as transferências.</p>
  </div>

  <div class="cartao">
    <ul>
      <li><b>Colocar todos na URA</b>: em até 5 s, todos os operadores dos grupos do Ativo vão para a URA, atendendo ou não.</li>
      <li>A regra do ocioso continua valendo: quem ficar livre 3 min seguidos na URA volta ao Ativo, e volta à URA quando atender lá (mesmo sem ter batido a meta).</li>
      <li>Quem está em ligação só passa a receber da URA quando ficar livre (a discadora troca a telefonia com atraso).</li>
      <li><b>Voltar ao normal</b>: só sobe para a URA quem é elegível (meta de ontem, venda hoje ou fixo).</li>
      <li>Vale até desligar ou até virar o dia.</li>
    </ul>
    <div class="linha">
      <label>Token (WEBHOOK_TOKEN, se configurado): <input type="password" id="token" autocomplete="off"></label>
    </div>
    <div class="linha">
      <button id="ligar">Colocar todos na URA</button>
      <button id="desligar" class="secundario">Voltar ao normal</button>
      <span id="situacao"></span>
    </div>
  </div>

  <div class="cartao">
    <div class="estado">Robôs por livre: <span id="porLivre">–</span></div>
    <p class="sub" id="porLivreInfo"></p>
    <ul>
      <li>Sobe sozinho quando a URA está parada: livres sem receber derivação, robôs todos ligados.</li>
      <li>Desce sozinho a cada callback (se o webhook da Argus estiver configurado).</li>
      <li>Ajuste aqui quando quiser; o automático continua a partir do valor escolhido.</li>
    </ul>
    <div class="linha">
      <label>Novo valor: <input type="number" id="novoPorLivre" min="1" max="100" style="width:80px"></label>
      <button id="aplicarPorLivre">Aplicar</button>
      <span id="situacaoPorLivre"></span>
    </div>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  try { $('token').value = localStorage.getItem('benura-token') || ''; } catch {}

  function hora(iso) {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  async function atualizar() {
    try {
      const h = await (await fetch('/health')).json();
      const cheia = h.uraCheia || {};
      $('estado').className = 'estado ' + (cheia.ligada ? 'ligada' : 'desligada');
      $('estado').textContent = cheia.ligada ? 'Ligada desde ' + hora(cheia.desde) : 'Desligada (rodízio normal)';
      $('humanos').textContent = (h.ramaisUra || []).length;
      $('robos').textContent = (h.robos?.ligados ?? '?') + ' / ' + (h.robos?.alvo ?? '?');
      $('presos').textContent = (h.uraLogadosEmOutroGrupo || []).length;
      $('dryrun').hidden = !h.dryRun;
      const a = h.ajusteRobos || {};
      $('porLivre').textContent = a.porLivre ?? '?';
      $('porLivreInfo').textContent = 'Começa em ' + (a.base ?? '?') + ' · mínimo ' + (a.piso ?? '?') + ' · máximo ' + (a.maximo ?? '?')
        + (a.ajustadoAMao ? ' · ajustado à mão às ' + hora(a.ajustadoAMao) : '')
        + (a.automatico === false ? ' · automático desligado' : '');
    } catch (e) {
      $('estado').className = 'estado erro';
      $('estado').textContent = 'Rodízio sem resposta: ' + e.message;
    }
  }

  /** Chama a API com o token; mostra o andamento e o erro no elemento de saída. */
  async function pedir({ url, method, corpo, botoes, saida, emAndamento, sucesso }) {
    const token = $('token').value.trim();
    try { localStorage.setItem('benura-token', token); } catch {}
    botoes.forEach((b) => { $(b).disabled = true; });
    $(saida).className = '';
    $(saida).textContent = emAndamento;
    try {
      const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
      const resposta = await fetch(url, { method, headers, body: corpo ? JSON.stringify(corpo) : undefined });
      const r = await resposta.json();
      if (!resposta.ok) throw new Error(r.erro || ('HTTP ' + resposta.status));
      $(saida).className = 'ok';
      $(saida).textContent = sucesso(r);
    } catch (e) {
      $(saida).className = 'erro';
      $(saida).textContent = 'Erro: ' + e.message;
    } finally {
      botoes.forEach((b) => { $(b).disabled = false; });
      atualizar();
    }
  }

  const uraCheia = (method, emAndamento, sucesso) => pedir({
    url: '/ura/cheia', method, botoes: ['ligar', 'desligar'], saida: 'situacao', emAndamento, sucesso,
  });

  $('ligar').addEventListener('click', () => {
    if (!confirm('Colocar todos os operadores do Ativo na URA?')) return;
    uraCheia('POST', 'Ligando…', (c) => (c.mudou ? 'Ligada. Os operadores vão para a URA em até 5 s.' : 'Já estava ligada.'));
  });

  $('desligar').addEventListener('click', () => {
    uraCheia('DELETE', 'Desligando…', (c) => (c.mudou ? 'Rodízio de volta ao normal.' : 'Já estava desligada.'));
  });

  $('aplicarPorLivre').addEventListener('click', () => {
    const valor = Number($('novoPorLivre').value);
    pedir({
      url: '/robos/por-livre', method: 'POST', corpo: { valor }, botoes: ['aplicarPorLivre'], saida: 'situacaoPorLivre',
      emAndamento: 'Aplicando…', sucesso: (r) => 'Agora: ' + r.porLivre + ' robôs por livre.',
    });
  });

  atualizar();
  setInterval(atualizar, 5000);
</script>
</body>
</html>
`;

module.exports = { PAGINA_URA };

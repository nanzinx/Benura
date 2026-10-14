'use strict';
/**
 * Página de GET /manual: colar a esteira quando o Carrossel está fora do ar.
 * Autocontida (sem CDN): roda no PC do expediente, às vezes sem internet.
 */

const PAGINA_MANUAL = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BenURA · Esteira colada</title>
<style>
  :root { --fundo:#f6f7f9; --cartao:#fff; --texto:#1c2430; --suave:#5b6675; --borda:#d9dee5; --primaria:#1d5fd1; --ok:#1b7f45; --erro:#b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --fundo:#12161c; --cartao:#1b2129; --texto:#e6e9ee; --suave:#9aa5b3; --borda:#2c3440; --primaria:#5b9bff; --ok:#4cc38a; --erro:#ff6b5e; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--fundo); color:var(--texto); font:15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width:880px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.sub { color:var(--suave); margin:0 0 20px; }
  .cartao { background:var(--cartao); border:1px solid var(--borda); border-radius:10px; padding:16px; margin-bottom:16px; }
  ol { margin:0; padding-left:20px; }
  textarea { width:100%; min-height:220px; font:12px/1.4 ui-monospace, Consolas, monospace; color:var(--texto); background:var(--fundo);
    border:1px solid var(--borda); border-radius:8px; padding:10px; }
  .linha { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-top:12px; }
  input[type=password] { padding:8px; border:1px solid var(--borda); border-radius:8px; background:var(--fundo); color:var(--texto); }
  button { background:var(--primaria); color:#fff; border:0; border-radius:8px; padding:10px 18px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  button.secundario { background:transparent; color:var(--erro); border:1px solid var(--erro); }
  .ok { color:var(--ok); } .erro { color:var(--erro); }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  td, th { text-align:left; padding:6px 4px; border-bottom:1px solid var(--borda); }
  td.valor { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  h2 { font-size:16px; margin:16px 0 4px; }
</style>
</head>
<body>
<main>
  <h1>Esteira colada</h1>
  <p class="sub">Use quando o Carrossel estiver fora do ar. O roteador aplica as mesmas regras com estas vendas.</p>

  <div class="cartao">
    <ol>
      <li>Na esteira, filtre <b>Etapa = Andamento</b> e o período por <b>data de cadastro</b> incluindo o <b>dia anterior trabalhado e hoje</b>.</li>
      <li>Exporte o CSV e escolha o arquivo abaixo, <b>ou</b> copie a tabela (com o cabeçalho) e cole na caixa.</li>
      <li>Clique em <b>Enviar</b>. Durante o dia, cole de novo para atualizar as vendas de hoje.</li>
      <li>Cada colagem substitui os dias que contém. <b>Limpar esteiras coladas</b> apaga tudo o que foi colado.</li>
    </ol>
  </div>

  <div class="cartao">
    <input type="file" id="arquivo" accept=".csv,.txt">
    <textarea id="texto" placeholder="Proposta;...;Data/Hora;...;Agente;...;Valor Contrato;..."></textarea>
    <div class="linha">
      <label>Token (WEBHOOK_TOKEN, se configurado): <input type="password" id="token" autocomplete="off"></label>
      <button id="enviar">Enviar</button>
      <button id="limpar" class="secundario">Limpar esteiras coladas</button>
      <span id="situacao"></span>
    </div>
  </div>

  <div class="cartao" id="resultado" hidden></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  try { $('token').value = localStorage.getItem('benura-token') || ''; } catch {}

  $('arquivo').addEventListener('change', async () => {
    const arquivo = $('arquivo').files[0];
    if (!arquivo) return;
    const bytes = await arquivo.arrayBuffer();
    let texto = new TextDecoder('utf-8').decode(bytes);
    if (texto.includes('\\uFFFD')) texto = new TextDecoder('windows-1252').decode(bytes);
    $('texto').value = texto;
  });

  function linhaTabela(tabela, nome, total) {
    const tr = tabela.insertRow();
    tr.insertCell().textContent = nome;
    const td = tr.insertCell();
    td.className = 'valor';
    td.textContent = reais(total);
  }

  function secao(destino, titulo, lista, vazio) {
    const h = document.createElement('h2');
    h.textContent = titulo + ' (' + lista.length + ')';
    destino.append(h);
    if (!lista.length) {
      const p = document.createElement('p');
      p.textContent = vazio;
      destino.append(p);
      return;
    }
    const tabela = document.createElement('table');
    lista.forEach((v) => linhaTabela(tabela, v.nome, v.total));
    destino.append(tabela);
  }

  function mostrar(r) {
    const destino = $('resultado');
    destino.hidden = false;
    destino.replaceChildren();
    const p = document.createElement('p');
    p.textContent = r.vendas + ' venda(s) lida(s) de ' + r.diasColados.join(', ')
      + (r.ignoradas ? ' · ' + r.ignoradas + ' linha(s) ignorada(s) (sem agente, data ou valor)' : '')
      + ' · dia anterior: ' + (r.diaAnterior || 'não encontrado (cole também a esteira do dia anterior)');
    destino.append(p);
    secao(destino, 'Acima da meta no dia anterior (' + reais(r.metaDiaria) + ') → URA', r.acimaDaMeta, 'Ninguém passou da meta.');
    secao(destino, 'Venderam hoje (' + r.hoje + ') → sobem para a URA', r.vendeuHoje, 'Nenhuma venda de hoje na esteira colada.');
  }

  /** Chama /manual com o token; mostra o andamento e o erro em #situacao. */
  async function pedir(method, emAndamento, sucesso, body) {
    const token = $('token').value.trim();
    try { localStorage.setItem('benura-token', token); } catch {}
    $('enviar').disabled = $('limpar').disabled = true;
    $('situacao').className = '';
    $('situacao').textContent = emAndamento;
    try {
      const resposta = await fetch('/manual', {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body,
      });
      const corpo = await resposta.json();
      if (!resposta.ok) throw new Error(corpo.erro || ('HTTP ' + resposta.status));
      $('situacao').className = 'ok';
      $('situacao').textContent = sucesso(corpo);
      return corpo;
    } catch (e) {
      $('situacao').className = 'erro';
      $('situacao').textContent = 'Erro: ' + e.message;
      return null;
    } finally {
      $('enviar').disabled = $('limpar').disabled = false;
    }
  }

  $('enviar').addEventListener('click', async () => {
    const corpo = await pedir('POST', 'Enviando…', () => 'Esteira recebida.', JSON.stringify({ texto: $('texto').value }));
    if (corpo) mostrar(corpo);
  });

  $('limpar').addEventListener('click', async () => {
    if (!confirm('Apagar todas as esteiras coladas? Se o Carrossel estiver fora do ar, o roteador fica sem vendas até colar de novo.')) return;
    const corpo = await pedir('DELETE', 'Apagando…', (c) => c.apagados + ' dia(s) apagado(s).');
    if (corpo) $('resultado').hidden = true;
  });
</script>
</body>
</html>
`;

module.exports = { PAGINA_MANUAL };

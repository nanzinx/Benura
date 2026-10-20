'use strict';
/* BenURA · Painel da supervisão. Sem bibliotecas: roda no PC do expediente, às vezes sem internet. */

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...filhos) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...filhos.filter((f) => f != null));
  return e;
};
const reais = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const horaCurta = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '–');
const duracao = (seg) => {
  if (seg == null || !Number.isFinite(seg)) return '–';
  if (seg < 60) return Math.round(seg) + ' s';
  if (seg < 3600) return Math.floor(seg / 60) + ' min ' + String(Math.round(seg % 60)).padStart(2, '0') + ' s';
  return Math.floor(seg / 3600) + ' h ' + String(Math.floor((seg % 3600) / 60)).padStart(2, '0') + ' min';
};
const NOME_CLASSE = { livre: 'Livre', atendimento: 'Em atendimento', outro: 'Pausa / outro', offline: 'Offline', erro: 'Sem resposta' };

const estado = { visao: null, dia: null, filtroAvisos: 'todos', alertasVistos: new Set(), som: false, temporizadores: [] };

// ───────────── API ─────────────

class SemSessao extends Error {}

async function api(metodo, url, corpo) {
  const resposta = await fetch(url, {
    method: metodo,
    credentials: 'same-origin',
    headers: { 'X-Painel': '1', ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
  });
  let json = null;
  try { json = await resposta.json(); } catch { /* sem corpo */ }
  if (resposta.status === 401 && url !== '/api/entrar') throw new SemSessao();
  if (!resposta.ok) throw new Error(json?.erro || ('HTTP ' + resposta.status));
  return json;
}

// ───────────── Entrada e saída ─────────────

function mostrarEntrada() {
  pararAtualizacoes();
  $('telaPainel').hidden = true;
  $('telaEntrada').hidden = false;
  $('senha').value = '';
  $('senha').focus();
}

function mostrarPainel() {
  $('telaEntrada').hidden = true;
  $('telaPainel').hidden = false;
  irPara(location.hash);
  iniciarAtualizacoes();
}

$('formEntrada').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('botaoEntrar').disabled = true;
  $('erroEntrada').textContent = '';
  try {
    await api('POST', '/api/entrar', { senha: $('senha').value });
    mostrarPainel();
  } catch (e) {
    $('erroEntrada').textContent = e.message;
  } finally {
    $('botaoEntrar').disabled = false;
  }
});

$('sair').addEventListener('click', async () => {
  try { await api('POST', '/api/sair'); } catch { /* já saiu */ }
  mostrarEntrada();
});

/** Erro de uma atualização: sem sessão volta à entrada; o resto aparece na faixa. */
function tratarErro(e) {
  if (e instanceof SemSessao) mostrarEntrada();
  else console.warn(e);
}

// ───────────── Abas ─────────────

const ABAS = ['visao', 'ura', 'esteira', 'servicos'];

function irPara(hash) {
  const aba = ABAS.includes(String(hash).slice(1)) ? String(hash).slice(1) : 'visao';
  document.querySelectorAll('[data-secao]').forEach((s) => { s.hidden = s.dataset.secao !== aba; });
  document.querySelectorAll('[data-aba]').forEach((a) => {
    a.classList.toggle('ativa', a.dataset.aba === aba);
    if (a.dataset.aba === aba) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (aba === 'visao' && estado.dia) desenharGraficos();
}
window.addEventListener('hashchange', () => irPara(location.hash));

// ───────────── Atualizações periódicas ─────────────

function iniciarAtualizacoes() {
  pararAtualizacoes();
  const cada = (ms, fn) => { fn(); estado.temporizadores.push(setInterval(fn, ms)); };
  cada(5000, atualizarVisao);
  cada(30_000, atualizarDia);
  cada(30_000, atualizarRoteador);
  cada(60_000, atualizarRisco);
  cada(1000, () => { $('relogio').textContent = new Date().toLocaleTimeString('pt-BR'); });
}

function pararAtualizacoes() {
  estado.temporizadores.forEach(clearInterval);
  estado.temporizadores = [];
}

async function atualizarVisao() {
  try {
    estado.visao = await api('GET', '/api/visao');
    desenharVisao(estado.visao);
  } catch (e) { tratarErro(e); }
}

async function atualizarDia() {
  try {
    estado.dia = await api('GET', '/api/dia');
    desenharDia(estado.dia);
  } catch (e) { tratarErro(e); }
}

async function atualizarRoteador() {
  try {
    desenharRoteador(await api('GET', '/api/roteador/status'));
  } catch (e) {
    tratarErro(e);
    $('roteadorResumo').textContent = 'Roteador sem resposta';
  }
}

async function atualizarRisco() {
  try {
    const { clientes } = await api('GET', '/api/rodizio/perfis/risco');
    const corpo = $('tabelaRisco').tBodies[0];
    corpo.replaceChildren(...clientes.map((c) => el('tr', {},
      el('td', { textContent: c.mascara }),
      el('td', { className: 'num', textContent: c.callbacks }),
      el('td', { className: 'num', textContent: c.atendeu }),
      el('td', { textContent: c.ultimoDia ? c.ultimoDia.split('-').reverse().join('/') : '–' }),
      el('td', { textContent: c.motivos.join(', ') }))));
    $('riscoVazio').hidden = clientes.length > 0;
  } catch (e) { tratarErro(e); }
}

// ───────────── Visão (a cada 5 s) ─────────────

function definirEstado(id, texto, tipo) {
  $(id).textContent = texto;
  $(id).className = 'estado' + (tipo ? ' ' + tipo : '');
}

function desenharVisao(v) {
  const r = v.servicos.rodizio.dados;
  $('atualizadoEm').textContent = 'Atualizado às ' + new Date(v.agora).toLocaleTimeString('pt-BR');
  $('seloDryRun').hidden = !r?.dryRun;
  desenharFaixas(v);
  desenharServicos(v);
  if (!r) {
    ['kpiLivres', 'kpiHumanos', 'kpiRobos'].forEach((id) => { $(id).textContent = '–'; });
    $('kpiPanico').textContent = 'sem resposta';
    return;
  }
  desenharKpis(r);
  desenharUra(r.uraAgora || []);
  desenharControles(r, v.alertas);
  avisarClientesDeRisco(v.alertas?.alertas || []);
}

function desenharKpis(r) {
  const ura = r.uraAgora || [];
  const livres = ura.filter((u) => u.classe === 'livre' && !u.emCarencia).length;
  const humanos = ura.filter((u) => u.classe && u.classe !== 'offline').length;
  const atendendo = ura.filter((u) => u.classe === 'atendimento').length;
  $('kpiLivres').textContent = livres;
  $('kpiLivres').className = 'kpi-valor' + (livres <= 1 ? ' perigo' : '');
  $('kpiLivresNota').textContent = livres <= 1 ? 'atenção: poucos livres' : 'prontos para receber';
  $('kpiHumanos').textContent = humanos;
  $('kpiHumanosNota').textContent = atendendo + ' em atendimento';
  $('kpiRobos').textContent = r.robos?.ligados ?? '?';
  $('kpiRobosNota').textContent = 'de ' + (r.robos?.total ?? '?') + ' robôs';
  const p = r.panico || {};
  $('kpiPanico').textContent = !p.modo ? 'modo automático' : (p.ativoAgora ? 'desligando robôs' : (p.ligado ? 'ligado' : 'desligado'));
  $('kpiPanico').className = 'kpi-valor kpi-texto' + (p.ativoAgora ? ' perigo' : (p.ligado ? ' ok' : ''));
  $('kpiPanicoNota').textContent = p.uraPassiva?.ligado ? 'URA passiva hoje' : (r.uraCheia?.ligada ? 'URA cheia ligada' : '');
}

function desenharUra(ura) {
  const ordem = { livre: 0, atendimento: 1, outro: 2, erro: 3, offline: 4 };
  const lista = [...ura].sort((a, b) => (ordem[a.classe] ?? 9) - (ordem[b.classe] ?? 9) || String(a.nome).localeCompare(String(b.nome)));
  const agora = Date.now();
  $('tabelaUra').tBodies[0].replaceChildren(...lista.map((u) => el('tr', {},
    el('td', { className: 'ramal', textContent: u.ramal }),
    el('td', {}, u.nome || '—', u.fixo ? el('span', { className: 'marcador', textContent: 'fixo' }) : null),
    el('td', {}, el('span', { className: 'chip ' + (u.classe || 'erro'), textContent: (NOME_CLASSE[u.classe] || 'Sem leitura') + (u.emCarencia ? ' · carência' : '') })),
    el('td', { className: 'num', textContent: u.livreDesde ? duracao((agora - new Date(u.livreDesde)) / 1000) : '' }))));
  $('uraVazia').hidden = lista.length > 0;
  $('uraResumo').textContent = lista.length + ' na lista da URA';
}

function desenharControles(r, alertas) {
  const p = r.panico || {};
  $('cartaoPanico').hidden = !p.modo;
  definirEstado('estadoPanico', p.ativoAgora ? 'desligando robôs' : (p.ligado ? 'ligado' : 'desligado'), p.ativoAgora ? 'perigo' : (p.ligado ? 'ligado' : ''));
  $('antesDeSair').textContent = Math.round((p.antesDeSairMs ?? 60_000) / 1000) + ' s';
  $('motivoPanico').hidden = !p.motivo;
  $('motivoPanico').textContent = String(p.motivo || '').replace(/^PÂNICO: /, 'Agora: ');
  const passiva = p.uraPassiva || {};
  definirEstado('estadoPassiva', passiva.ligado ? 'ligada desde ' + horaCurta(passiva.desde) : 'desligada', passiva.ligado ? 'ligado' : '');
  const cheia = r.uraCheia || {};
  definirEstado('estadoCheia', cheia.ligada ? 'ligada desde ' + horaCurta(cheia.desde) : 'rodízio normal', cheia.ligada ? 'alerta' : '');
  const ativo = Boolean(alertas?.ativo);
  $('cartaoRisco').hidden = !ativo;
  if (ativo) {
    definirEstado('estadoRisco', alertas.desligaRobos?.ligado ? 'desliga os robôs' : 'só avisa', alertas.desligaRobos?.ligado ? 'perigo' : 'ligado');
    $('riscoInfo').textContent = (alertas.perfis?.clientes ?? 0) + ' cliente(s) com perfil · ' + (alertas.perfis?.risco ?? 0) + ' de risco'
      + (alertas.perfis?.historicoAte ? ' · histórico até ' + alertas.perfis.historicoAte.split('-').reverse().join('/') : '');
  }
}

// ───────────── Faixas do topo ─────────────

function faixa(tipo, icone, titulo, detalhe) {
  return el('div', { className: 'faixa ' + tipo, role: tipo === 'perigo' ? 'alert' : 'status' },
    el('span', { className: 'faixa-icone', textContent: icone, ariaHidden: 'true' }),
    el('div', {}, titulo, detalhe ? el('small', { textContent: detalhe }) : null));
}

function desenharFaixas(v) {
  const faixas = [];
  const r = v.servicos.rodizio.dados;
  for (const a of v.alertas?.alertas || []) {
    faixas.push(faixa('perigo', '!', 'Cliente de risco em ligação com ' + (a.robo || 'robô') + ': ' + a.mascara,
      a.motivos.join(', ') + ' nos últimos dias · desde ' + horaCurta(a.inicio)));
  }
  if (r?.panico?.ativoAgora) faixas.push(faixa('perigo', '!', 'Pânico ativo: o BenURA está desligando os robôs', String(r.panico.motivo || '').replace(/^PÂNICO: /, '')));
  const fora = Object.entries(v.servicos).filter(([nome, s]) => !s.online && nome !== 'atualizador').map(([, s]) => s.nome);
  if (fora.length) faixas.push(faixa('alerta', '!', 'Fora do ar: ' + fora.join(', '), 'No PC do BenURA: npx pm2 status (e npx pm2 logs para ver o motivo).'));
  if (v.argus.tokenRecusado) faixas.push(faixa('alerta', '!', 'A Argus recusou o token', 'Atualize ARGUS_TOKEN no .env (Configurações → Desenvolvedor → Acesso API) e reinicie: npx pm2 restart all.'));
  else if (v.servicos.rodizio.online && !v.argus.respondendo) faixas.push(faixa('alerta', '!', 'O rodízio não fala com a Argus há ' + duracao(v.argus.cicloUraHaSeg), 'Veja os avisos na aba Serviços.'));
  $('faixas').replaceChildren(...faixas);
  document.title = (v.alertas?.alertas?.length ? '⚠ Cliente de risco · ' : '') + 'BenURA · Painel da supervisão';
}

// ───────────── Serviços ─────────────

function desenharServicos(v) {
  const r = v.servicos.rodizio.dados;
  const linhas = {
    roteador: (d) => [['Carga do dia', d.cargaInicialFeita ? 'feita' : 'pendente'], ['Última leitura de vendas', horaCurta(d.ultimoMonitoramento)]],
    rodizio: (d) => [['Último ciclo da URA', duracao(v.argus.cicloUraHaSeg) + ' atrás'], ['Modo dos robôs', d.robos?.modo === 'panico' ? 'pânico' : 'automático'], ['DRY_RUN', d.dryRun ? 'ligado (simulação)' : 'desligado']],
    rotinas: (d) => [['Última execução', horaCurta(d.ultimaExecucao)]],
    atualizador: () => [],
  };
  const cartoes = Object.entries(v.servicos).map(([chave, s]) => {
    const detalhes = s.online && s.dados ? (linhas[chave] || (() => []))(s.dados) : [];
    return el('article', { className: 'servico' },
      el('div', { className: 'servico-topo' }, el('h2', { textContent: s.nome }),
        el('span', { className: 'estado ' + (s.online ? 'ligado' : (chave === 'atualizador' ? '' : 'perigo')), textContent: s.online ? 'no ar' : 'fora do ar' })),
      el('dl', {}, ...[['Resposta', s.online ? s.ms + ' ms' : '–'], ['No ar há', s.dados?.uptime ? duracao(s.dados.uptime) : '–'], ...detalhes]
        .flatMap(([k, val]) => [el('dt', { textContent: k }), el('dd', { textContent: val })])));
  });
  const argusOk = v.argus.respondendo && !v.argus.tokenRecusado;
  cartoes.push(el('article', { className: 'servico' },
    el('div', { className: 'servico-topo' }, el('h2', { textContent: 'Argus (discadora)' }),
      el('span', { className: 'estado ' + (argusOk ? 'ligado' : 'perigo'), textContent: v.argus.tokenRecusado ? 'token recusado' : (argusOk ? 'respondendo' : 'sem resposta') })),
    el('dl', {}, el('dt', { textContent: 'Último ciclo' }), el('dd', { textContent: r ? duracao(v.argus.cicloUraHaSeg) + ' atrás' : '–' }),
      el('dt', { textContent: 'Fixos na URA' }), el('dd', { textContent: r ? String((r.fixosPermanentes || []).length) : '–' }))));
  $('listaServicos').replaceChildren(...cartoes);
}

// ───────────── O dia (a cada 30 s) ─────────────

function desenharDia(d) {
  const callbacks = [...d.callbacks].reverse();
  $('kpiCallbacks').textContent = d.callbacks.length;
  $('kpiCallbacksNota').textContent = d.callbacks.length ? 'último às ' + d.callbacks[d.callbacks.length - 1].hora.slice(0, 5) : 'nenhum até agora';
  $('listaCallbacks').replaceChildren(...callbacks.slice(0, 60).map((c) => el('li', {},
    el('div', { className: 'cb-topo' }, el('span', { className: 'cb-hora', textContent: c.hora }),
      el('span', { className: 'cb-conclusao', textContent: c.conclusao || 'callback' }),
      el('span', { className: 'suave', textContent: [c.robo, c.duracaoSeg + ' s'].filter(Boolean).join(' · ') })),
    c.detalhes.length ? el('div', { className: 'cb-detalhe', textContent: c.detalhes.join(' · ') }) : null)));
  $('callbacksVazio').hidden = d.callbacks.length > 0;
  desenharAvisos();
  if (!$('graficoLivres').closest('[data-secao]').hidden) desenharGraficos();
}

function desenharAvisos() {
  const avisos = (estado.dia?.avisos || []).filter((a) => estado.filtroAvisos === 'todos' || a.nivel === estado.filtroAvisos);
  $('listaAvisos').replaceChildren(...avisos.map((a) => el('li', { className: a.nivel },
    el('span', { className: 'aviso-hora', textContent: a.hora }),
    el('span', { className: 'aviso-servico', textContent: a.servico }),
    el('span', { className: 'aviso-texto', textContent: a.texto }))));
  $('avisosVazio').hidden = avisos.length > 0;
}

document.querySelectorAll('[data-filtro]').forEach((b) => b.addEventListener('click', () => {
  estado.filtroAvisos = b.dataset.filtro;
  document.querySelectorAll('[data-filtro]').forEach((x) => x.classList.toggle('ativo', x === b));
  desenharAvisos();
}));

// ───────────── Gráficos (SVG, linha em degraus) ─────────────

const seg = (hora) => { const [h, m, s] = hora.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

function desenharGraficos() {
  const d = estado.dia;
  if (!d) return;
  const pontos = d.linhaDoTempo;
  desenharDegraus($('graficoLivres'), pontos.map((p) => ({ t: seg(p.hora), y: p.livres, hora: p.hora })), {
    rotulo: 'livre(s)', marcas: d.callbacks.map((c) => ({ t: seg(c.hora), texto: c.hora + ' · ' + (c.conclusao || 'callback') })),
  });
  desenharDegraus($('graficoRobos'), pontos.filter((p) => p.robos != null).map((p) => ({ t: seg(p.hora), y: p.robos, hora: p.hora })), { rotulo: 'robô(s) ligado(s)' });
}

function desenharDegraus(alvo, pontos, { rotulo, marcas = [] }) {
  alvo.replaceChildren();
  if (pontos.length < 1) {
    alvo.append(el('div', { className: 'grafico-vazio', textContent: 'Sem dados ainda hoje.' }));
    return;
  }
  const largura = alvo.clientWidth || 800;
  const altura = alvo.clientHeight || 220;
  const m = { cima: 10, direita: 12, baixo: 24, esquerda: 32 };
  const agora = (() => { const n = new Date(); return n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds(); })();
  const inicio = Math.min(pontos[0].t, ...marcas.map((x) => x.t));
  const fim = Math.max(agora, pontos[pontos.length - 1].t + 60);
  const maxY = Math.max(2, ...pontos.map((p) => p.y));
  const x = (t) => m.esquerda + ((t - inicio) / Math.max(1, fim - inicio)) * (largura - m.esquerda - m.direita);
  const y = (v) => altura - m.baixo - (v / maxY) * (altura - m.cima - m.baixo);

  const svg = svgEl('svg', { viewBox: `0 0 ${largura} ${altura}`, preserveAspectRatio: 'none' });
  const passo = maxY <= 6 ? 1 : Math.ceil(maxY / 5);
  const eixo = svgEl('g', { class: 'eixo' });
  for (let v = 0; v <= maxY; v += passo) {
    svg.append(svgEl('line', { class: 'grade-linha', x1: m.esquerda, x2: largura - m.direita, y1: y(v), y2: y(v) }));
    const t = svgEl('text', { x: m.esquerda - 8, y: y(v) + 4, 'text-anchor': 'end' });
    t.textContent = v;
    eixo.append(t);
  }
  const horas = Math.max(1, Math.round((fim - inicio) / 3600 / 6));
  for (let h = Math.ceil(inicio / 3600); h * 3600 <= fim; h += horas) {
    const t = svgEl('text', { x: x(h * 3600), y: altura - 6, 'text-anchor': 'middle' });
    t.textContent = String(h).padStart(2, '0') + 'h';
    eixo.append(t);
  }
  svg.append(eixo);

  // Degraus: o valor vale até a próxima mudança (e até agora, no último).
  let caminho = `M${x(pontos[0].t)},${y(pontos[0].y)}`;
  for (let i = 1; i < pontos.length; i++) caminho += `H${x(pontos[i].t)}V${y(pontos[i].y)}`;
  caminho += `H${x(fim)}`;
  svg.append(svgEl('path', { class: 'area', d: `${caminho}V${y(0)}H${x(pontos[0].t)}Z` }));
  svg.append(svgEl('path', { class: 'serie', d: caminho }));
  for (const mk of marcas) svg.append(svgEl('line', { class: 'callback', x1: x(mk.t), x2: x(mk.t), y1: altura - m.baixo, y2: altura - m.baixo - 12 }));

  const cruz = svgEl('line', { class: 'cruz', y1: m.cima, y2: altura - m.baixo, visibility: 'hidden' });
  const ponto = svgEl('circle', { class: 'ponto', r: 4, visibility: 'hidden' });
  svg.append(cruz, ponto);
  alvo.append(svg);

  const dica = $('dica');
  const valorEm = (t) => { let atual = pontos[0]; for (const p of pontos) { if (p.t <= t) atual = p; else break; } return atual; };
  svg.addEventListener('pointermove', (ev) => {
    const caixa = svg.getBoundingClientRect();
    const px = ((ev.clientX - caixa.left) / caixa.width) * largura;
    const t = inicio + ((px - m.esquerda) / (largura - m.esquerda - m.direita)) * (fim - inicio);
    if (t < inicio || t > fim) { dica.hidden = true; return; }
    const p = valorEm(t);
    const perto = marcas.filter((mk) => Math.abs(x(mk.t) - px) < 6);
    cruz.setAttribute('x1', px); cruz.setAttribute('x2', px); cruz.setAttribute('visibility', 'visible');
    ponto.setAttribute('cx', px); ponto.setAttribute('cy', y(p.y)); ponto.setAttribute('visibility', 'visible');
    const hh = String(Math.floor(t / 3600)).padStart(2, '0') + ':' + String(Math.floor((t % 3600) / 60)).padStart(2, '0');
    dica.replaceChildren(el('div', {}, el('b', { textContent: hh }), ' · ' + p.y + ' ' + rotulo), ...perto.map((mk) => el('div', { textContent: 'Callback ' + mk.texto })));
    dica.hidden = false;
    dica.style.left = Math.min(ev.clientX + 14, window.innerWidth - dica.offsetWidth - 8) + 'px';
    dica.style.top = (ev.clientY - dica.offsetHeight - 12) + 'px';
  });
  svg.addEventListener('pointerleave', () => {
    dica.hidden = true;
    cruz.setAttribute('visibility', 'hidden');
    ponto.setAttribute('visibility', 'hidden');
  });
  alvo.setAttribute('aria-label', rotulo + ': agora ' + pontos[pontos.length - 1].y + ', máximo ' + maxY + ' hoje');
}

let redimensionando = null;
window.addEventListener('resize', () => { clearTimeout(redimensionando); redimensionando = setTimeout(desenharGraficos, 150); });

// ───────────── Roteador (a cada 30 s) ─────────────

function desenharRoteador(s) {
  const subiram = (s.ura || []).filter((v) => v.promovidoNoDia);
  $('rotUra').textContent = (s.ura || []).length;
  $('rotAtivo').textContent = (s.ativo || []).length;
  $('rotSubiram').textContent = subiram.length;
  $('rotMeta').textContent = reais(s.meta);
  $('roteadorResumo').textContent = s.cargaInicialFeita ? 'carga do dia feita' + (s.ultimoMonitoramento ? ' · vendas lidas às ' + horaCurta(s.ultimoMonitoramento) : '') : 'carga do dia pendente';
  $('tabelaSubiram').tBodies[0].replaceChildren(...(subiram.length ? subiram.map((v) => el('tr', {},
    el('td', { className: 'ramal', textContent: v.ramal }), el('td', { textContent: v.nome }), el('td', { textContent: v.equipe || '' }),
    el('td', { className: 'num', textContent: reais(v.vendaQueDisparou) }))) : [el('tr', {}, el('td', { colSpan: 4, className: 'suave', textContent: 'Ninguém subiu por venda hoje ainda.' }))]));
}

// ───────────── Comandos da URA ─────────────

document.querySelectorAll('[data-comando]').forEach((botao) => botao.addEventListener('click', async () => {
  const { comando, metodo, confirmar } = botao.dataset;
  if (confirmar && !window.confirm(confirmar)) return;
  const saida = document.querySelector(`[data-saida="${comando}"]`);
  const irmaos = document.querySelectorAll(`[data-comando="${comando}"]`);
  irmaos.forEach((b) => { b.disabled = true; });
  saida.className = 'mensagem';
  saida.textContent = 'Enviando…';
  try {
    const r = await api(metodo, '/api/rodizio/' + comando);
    saida.className = 'mensagem ok';
    saida.textContent = r?.mudou === false ? 'Já estava assim.' : 'Feito.';
    atualizarVisao();
  } catch (e) {
    if (e instanceof SemSessao) return mostrarEntrada();
    saida.className = 'mensagem erro';
    saida.textContent = 'Não foi possível: ' + e.message;
  } finally {
    irmaos.forEach((b) => { b.disabled = false; });
  }
  return undefined;
}));

// ───────────── Clientes de risco: som e notificação ─────────────

$('ativarNotificacoes').addEventListener('click', async () => {
  estado.som = true;
  bipe();
  try { if (window.Notification && Notification.permission === 'default') await Notification.requestPermission(); } catch { /* sem suporte */ }
  $('estadoNotificacoes').textContent = 'Som ligado' + (window.Notification && Notification.permission === 'granted' ? ' · notificações ligadas' : ' · notificações bloqueadas no navegador');
});

function bipe() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25].forEach((atraso) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.2, ctx.currentTime + atraso);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + atraso + 0.2);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + atraso);
      o.stop(ctx.currentTime + atraso + 0.2);
    });
  } catch { /* sem áudio */ }
}

function avisarClientesDeRisco(alertas) {
  const novos = alertas.filter((a) => !estado.alertasVistos.has(a.id));
  novos.forEach((a) => estado.alertasVistos.add(a.id));
  if (!novos.length) return;
  if (estado.som) bipe();
  try {
    if (window.Notification && Notification.permission === 'granted') {
      novos.forEach((a) => new Notification('Cliente de risco em ligação', { body: (a.robo || 'Robô') + ' com ' + a.mascara + ' (' + a.motivos.join(', ') + ')' }));
    }
  } catch { /* sem notificação */ }
}

// ───────────── Esteira manual ─────────────

$('arquivoEsteira').addEventListener('change', async () => {
  const arquivo = $('arquivoEsteira').files[0];
  if (!arquivo) return;
  const bytes = await arquivo.arrayBuffer();
  let texto = new TextDecoder('utf-8').decode(bytes);
  if (texto.includes('�')) texto = new TextDecoder('windows-1252').decode(bytes);
  $('textoEsteira').value = texto;
  $('nomeArquivo').textContent = arquivo.name;
});

async function comandoEsteira(metodo, url, corpo, emAndamento, sucesso) {
  const botoes = ['enviarEsteira', 'limparEsteira', 'recarregarVendas'].map($);
  botoes.forEach((b) => { b.disabled = true; });
  $('saidaEsteira').className = 'mensagem';
  $('saidaEsteira').textContent = emAndamento;
  try {
    const r = await api(metodo, url, corpo);
    $('saidaEsteira').className = 'mensagem ok';
    $('saidaEsteira').textContent = sucesso(r);
    return r;
  } catch (e) {
    if (e instanceof SemSessao) { mostrarEntrada(); return null; }
    $('saidaEsteira').className = 'mensagem erro';
    $('saidaEsteira').textContent = 'Não foi possível: ' + e.message;
    return null;
  } finally {
    botoes.forEach((b) => { b.disabled = false; });
  }
}

function tabelaVendedores(tabela, lista, vazio) {
  tabela.tBodies[0].replaceChildren(...(lista.length
    ? lista.map((v) => el('tr', {}, el('td', { textContent: v.nome }), el('td', { className: 'num', textContent: reais(v.total) })))
    : [el('tr', {}, el('td', { className: 'suave', textContent: vazio }))]));
}

$('enviarEsteira').addEventListener('click', async () => {
  if (!$('textoEsteira').value.trim()) {
    $('saidaEsteira').className = 'mensagem erro';
    $('saidaEsteira').textContent = 'Escolha o arquivo ou cole a esteira primeiro.';
    return;
  }
  const r = await comandoEsteira('POST', '/api/roteador/manual', { texto: $('textoEsteira').value }, 'Enviando…', () => 'Esteira recebida.');
  if (!r) return;
  $('resultadoEsteira').hidden = false;
  $('resumoEsteira').textContent = r.vendas + ' venda(s) de ' + r.diasColados.join(', ')
    + (r.ignoradas ? ' · ' + r.ignoradas + ' linha(s) ignorada(s)' : '')
    + ' · dia anterior: ' + (r.diaAnterior || 'não encontrado (cole também o dia anterior)');
  $('tituloAcima').textContent = 'Acima da meta no dia anterior (' + reais(r.metaDiaria) + ') → URA · ' + r.acimaDaMeta.length;
  $('tituloHoje').textContent = 'Venderam hoje (' + r.hoje + ') → sobem para a URA · ' + r.vendeuHoje.length;
  tabelaVendedores($('tabelaAcima'), r.acimaDaMeta, 'Ninguém passou da meta.');
  tabelaVendedores($('tabelaHoje'), r.vendeuHoje, 'Nenhuma venda de hoje na esteira colada.');
});

$('limparEsteira').addEventListener('click', async () => {
  if (!window.confirm('Apagar todas as esteiras coladas? Se o Carrossel estiver fora do ar, o roteador fica sem vendas até colar de novo.')) return;
  const r = await comandoEsteira('DELETE', '/api/roteador/manual', undefined, 'Apagando…', (c) => c.apagados + ' dia(s) apagado(s).');
  if (r) $('resultadoEsteira').hidden = true;
});

$('recarregarVendas').addEventListener('click', async () => {
  if (!window.confirm('Refazer a carga das vendas agora? O roteador relê o Carrossel (ou a esteira colada) e reaplica as filas.')) return;
  await comandoEsteira('POST', '/api/roteador/recarregar', undefined, 'Pedindo a recarga…', () => 'Recarga iniciada. Acompanhe na Visão geral.');
});

// ───────────── Início ─────────────

(async () => {
  try {
    await api('GET', '/api/sessao');
    mostrarPainel();
  } catch {
    mostrarEntrada();
  }
})();

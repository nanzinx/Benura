'use strict';
/**
 * Robô da esteira do Vanguard (Sistema Corban): entra com um login próprio,
 * aplica os filtros de cada cenário e baixa o Excel — o mesmo caminho que o
 * Carrossel já faz com Puppeteer (scraper.js), aqui com Playwright.
 *
 * Os filtros são aplicados direto nos campos do formulário (os <select> por
 * trás do select2 e do multiselect), não clicando nos menus: é mais estável
 * quando o layout muda. Os seletores podem ser trocados por configuração.
 *
 * Usa o Chrome (ou Edge) já instalado no PC: não baixa navegador.
 */

const fs = require('fs');
const path = require('path');
const { normalizarNome } = require('../../utils/texto');

const SELETORES_PADRAO = Object.freeze({
  usuario: '#exten',
  senha: '#password',
  entrar: '#button-sigin',
  tipoData: '#tipodata',
  dataInicial: '#data_inicial',
  dataFinal: '#data_final',
  etapa: '#etapa',
  status: '#status',
  equipe: '#cod_equipe',
  filtrar: 'button[name="enviarfiltro"]',
  extrairExcel: 'button[data-original-title="Extrair Excel"]',
  // Tela Funcionários
  procurarFuncionarios: ':is(button, a):has-text("Procurar")',
  exportarFuncionarios: ':is(button, a):has-text("Exportar")',
});

class VanguardLoginError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'VanguardLoginError';
  }
}

/** "2026-10-09" → "09/10/2026" */
const paraDataBr = (iso) => iso.split('-').reverse().join('/');

/** Data ISO `dias` antes de `hojeIso` (sem fuso: só calendário). */
function diasAntes(hojeIso, dias) {
  const d = new Date(`${hojeIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Período de um cenário: sem `diasAtras` → datas vazias (tudo). */
function periodoDoCenario(cenario, hojeIso) {
  if (cenario.diasAtras == null) return { inicial: '', final: '' };
  return { inicial: paraDataBr(diasAntes(hojeIso, cenario.diasAtras)), final: paraDataBr(hojeIso) };
}

/**
 * Roda no navegador: marca num <select> as opções cujo texto bate com `textos`
 * (sem acento/caixa), ou todas com `todas`. Avisa o select2/multiselect, se houver.
 * @returns {{ faltando: string[], disponiveis: string[] }}
 */
function marcarOpcoesNoNavegador({ seletor, textos, todas }) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const select = document.querySelector(seletor);
  if (!select) return { faltando: [`campo ${seletor} não encontrado`], disponiveis: [] };
  const desejados = new Set(textos.map(norm));
  const opcoes = [...select.options];
  opcoes.forEach((o) => { o.selected = todas || desejados.has(norm(o.textContent)); });
  const marcados = new Set(opcoes.filter((o) => o.selected).map((o) => norm(o.textContent)));
  const $ = window.jQuery;
  if ($ && $(select).data('multiselect')) $(select).multiselect('refresh');
  if ($) $(select).trigger('change');
  else select.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    faltando: todas ? [] : textos.filter((t) => !marcados.has(norm(t))),
    disponiveis: opcoes.map((o) => o.textContent.trim()),
  };
}

/**
 * Roda no navegador, na tela Funcionários: põe o filtro de status em "Todos"
 * (o select que tem a opção "Ativos") e a agência em "Todas", se houver.
 * Os campos são achados pelo conteúdo, não por id.
 * @returns {{ erro?: string, avisos: string[] }}
 */
function filtrosFuncionariosNoNavegador({ status }) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const selects = [...document.querySelectorAll('select')];
  const avisar = (el) => (window.jQuery ? window.jQuery(el).trigger('change') : el.dispatchEvent(new Event('change', { bubbles: true })));
  const campoStatus = selects.find((sel) => [...sel.options].some((o) => norm(o.textContent) === 'ATIVOS'));
  if (!campoStatus) return { erro: 'campo de status (com a opção "Ativos") não encontrado', avisos: [] };
  const opcao = [...campoStatus.options].find((o) => norm(o.textContent) === norm(status));
  if (!opcao) return { erro: `status "${status}" não existe. Opções: ${[...campoStatus.options].map((o) => o.textContent.trim()).join(' | ')}`, avisos: [] };
  campoStatus.value = opcao.value;
  avisar(campoStatus);

  const avisos = [];
  const agencia = selects.find((sel) => [...sel.options].some((o) => /^\d+\s*-\s/.test(o.textContent.trim())));
  const todas = agencia && [...agencia.options].find((o) => ['TODAS', 'TODOS'].includes(norm(o.textContent)) || o.value === '');
  if (agencia && todas) {
    agencia.value = todas.value;
    avisar(agencia);
  }
  if (agencia && !todas) avisos.push('o filtro de agência não tem a opção "Todas": a exportação pode vir só da agência selecionada');
  return { avisos };
}

/** Roda no navegador: preenche um campo de texto/data e avisa os ouvintes. */
function preencherNoNavegador({ seletor, valor }) {
  const campo = document.querySelector(seletor);
  if (!campo) return false;
  campo.value = valor;
  campo.dispatchEvent(new Event('input', { bubbles: true }));
  campo.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

class RoboEsteira {
  /**
   * @param {object} deps
   * @param {{ url: string, usuario: string, senha: string, pastaDownload: string, timeoutMs?: number,
   *           navegador?: { canal?: string, executavel?: string, headless?: boolean },
   *           seletores?: object }} deps.cfg
   * @param {object} deps.logger
   * @param {object} [deps.chromium] - playwright chromium (testes)
   */
  constructor({ cfg, logger, chromium }) {
    this.cfg = { timeoutMs: 60_000, navegador: {}, ...cfg };
    this.seletores = { ...SELETORES_PADRAO, ...cfg.seletores };
    this.log = logger;
    this.chromium = chromium || require('playwright-core').chromium;
  }

  /**
   * Baixa a esteira de cada cenário numa única sessão.
   * @param {Array<{ nome: string, tipoData: string, diasAtras?: number|null, etapas?: string[] }>} cenarios
   * @param {{ hoje: string }} opcoes - data ISO de hoje
   * @returns {Promise<Record<string, string>>} nome do cenário → arquivo baixado
   */
  async baixar(cenarios, { hoje }) {
    fs.mkdirSync(this.cfg.pastaDownload, { recursive: true });
    const navegador = await this.abrirNavegador();
    try {
      const contexto = await navegador.newContext({ acceptDownloads: true });
      contexto.setDefaultTimeout(this.cfg.timeoutMs);
      const pagina = await contexto.newPage();
      await this.entrar(pagina);
      const arquivos = {};
      for (const cenario of cenarios) arquivos[cenario.nome] = await this.baixarCenario(pagina, cenario, hoje);
      await this.sair(pagina);
      return arquivos;
    } finally {
      await navegador.close();
    }
  }

  /**
   * Exporta a tela Funcionários com o status "Todos" (ativos e inativos).
   * @param {{ hoje: string }} opcoes
   * @returns {Promise<string>} arquivo baixado
   */
  async baixarFuncionarios({ hoje }) {
    if (!this.cfg.urlFuncionarios) throw new Error('Informe VANGUARD_FUNCIONARIOS_URL (endereço da tela Funcionários do Vanguard).');
    fs.mkdirSync(this.cfg.pastaDownload, { recursive: true });
    const navegador = await this.abrirNavegador();
    try {
      const contexto = await navegador.newContext({ acceptDownloads: true });
      contexto.setDefaultTimeout(this.cfg.timeoutMs);
      const pagina = await contexto.newPage();
      await this.entrar(pagina);
      const arquivo = await this.exportarFuncionarios(pagina, hoje);
      await this.sair(pagina);
      return arquivo;
    } finally {
      await navegador.close();
    }
  }

  async exportarFuncionarios(pagina, hoje) {
    const s = this.seletores;
    await pagina.goto(this.cfg.urlFuncionarios, { waitUntil: 'domcontentloaded' });
    const { erro, avisos } = await pagina.evaluate(filtrosFuncionariosNoNavegador, { status: this.cfg.statusFuncionarios || 'Todos' });
    if (erro) throw new Error(`Tela Funcionários: ${erro}`);
    avisos.forEach((a) => this.log.aviso(`Tela Funcionários: ${a}.`));

    await Promise.all([pagina.waitForLoadState('domcontentloaded'), pagina.locator(s.procurarFuncionarios).first().click()]);
    const [download] = await Promise.all([pagina.waitForEvent('download'), pagina.locator(s.exportarFuncionarios).first().click()]);
    const destino = path.join(this.cfg.pastaDownload, `FUNCIONARIOS-${hoje}${path.extname(download.suggestedFilename()) || '.xls'}`);
    await download.saveAs(destino);
    this.log.info('Vanguard: Funcionários exportados (status Todos).');
    return destino;
  }

  abrirNavegador() {
    const { canal, executavel, headless = true } = this.cfg.navegador;
    const opcoes = executavel ? { executablePath: executavel } : { channel: canal || 'chrome' };
    return this.chromium.launch({ ...opcoes, headless });
  }

  async entrar(pagina) {
    const s = this.seletores;
    await pagina.goto(this.cfg.url, { waitUntil: 'domcontentloaded' });
    await pagina.fill(s.usuario, this.cfg.usuario);
    await pagina.fill(s.senha, this.cfg.senha);
    await Promise.all([pagina.waitForLoadState('domcontentloaded'), pagina.click(s.entrar)]);
    await pagina.waitForLoadState('networkidle').catch(() => {});
    if (await pagina.locator(s.senha).count()) throw new VanguardLoginError('Login no Vanguard recusado (usuário/senha do robô?).');
    this.log.info('Vanguard: login ok.');
  }

  async baixarCenario(pagina, cenario, hoje) {
    const s = this.seletores;
    await pagina.goto(new URL('index.php/esteira', `${this.cfg.url.replace(/\/+$/, '')}/`).href, { waitUntil: 'domcontentloaded' });
    await this.marcar(pagina, s.tipoData, [cenario.tipoData], 'Tipo de data');
    const periodo = periodoDoCenario(cenario, hoje);
    await pagina.evaluate(preencherNoNavegador, { seletor: s.dataInicial, valor: periodo.inicial });
    await pagina.evaluate(preencherNoNavegador, { seletor: s.dataFinal, valor: periodo.final });
    await this.marcar(pagina, s.etapa, cenario.etapas || [], 'Etapa');
    await this.marcarStatus(pagina, cenario.status || []);
    await pagina.evaluate(marcarOpcoesNoNavegador, { seletor: s.equipe, textos: [], todas: true });

    await Promise.all([pagina.waitForLoadState('domcontentloaded'), pagina.click(s.filtrar)]);
    const [download] = await Promise.all([pagina.waitForEvent('download'), pagina.click(s.extrairExcel)]);
    const destino = path.join(this.cfg.pastaDownload, `${normalizarNome(cenario.nome).replace(/[^A-Z0-9]+/g, '-')}-${hoje}${path.extname(download.suggestedFilename()) || '.xlsx'}`);
    await download.saveAs(destino);
    this.log.info(`Vanguard: esteira "${cenario.nome}" baixada (${cenario.tipoData}${periodo.inicial ? ` ${periodo.inicial}–${periodo.final}` : ', sem data'}).`);
    return destino;
  }

  /**
   * Status direto na tela, como no processo manual (o arquivo já vem filtrado).
   * O filtro por status depois do download continua como segunda proteção.
   */
  async marcarStatus(pagina, status) {
    if (!status.length) return;
    if (!(await pagina.locator(this.seletores.status).count())) {
      this.log.aviso(`Campo Status (${this.seletores.status}) não está na tela; o status será filtrado só depois do download.`);
      return;
    }
    await this.marcar(pagina, this.seletores.status, status, 'Status');
  }

  /** Marca as opções; se alguma não existir, falha listando as que existem (para corrigir a configuração). */
  async marcar(pagina, seletor, textos, rotulo) {
    const { faltando, disponiveis } = await pagina.evaluate(marcarOpcoesNoNavegador, { seletor, textos, todas: false });
    if (!faltando.length) return;
    throw new Error(`${rotulo}: "${faltando.join('", "')}" não existe no Vanguard. Opções: ${disponiveis.join(' | ')}`);
  }

  async sair(pagina) {
    await pagina.goto(new URL('index.php/auth/logout', `${this.cfg.url.replace(/\/+$/, '')}/`).href).catch(() => {});
  }
}

module.exports = { RoboEsteira, VanguardLoginError, SELETORES_PADRAO, periodoDoCenario, diasAntes };

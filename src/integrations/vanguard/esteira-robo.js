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
  equipe: '#cod_equipe',
  filtrar: 'button[name="enviarfiltro"]',
  extrairExcel: 'button[data-original-title="Extrair Excel"]',
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
    await pagina.evaluate(marcarOpcoesNoNavegador, { seletor: s.equipe, textos: [], todas: true });

    await Promise.all([pagina.waitForLoadState('domcontentloaded'), pagina.click(s.filtrar)]);
    const [download] = await Promise.all([pagina.waitForEvent('download'), pagina.click(s.extrairExcel)]);
    const destino = path.join(this.cfg.pastaDownload, `${normalizarNome(cenario.nome).replace(/[^A-Z0-9]+/g, '-')}-${hoje}${path.extname(download.suggestedFilename()) || '.xlsx'}`);
    await download.saveAs(destino);
    this.log.info(`Vanguard: esteira "${cenario.nome}" baixada (${cenario.tipoData}${periodo.inicial ? ` ${periodo.inicial}–${periodo.final}` : ', sem data'}).`);
    return destino;
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

'use strict';
/**
 * Serviço de roteamento — orquestra os casos de uso do dia:
 *
 *   executarCargaInicial()  → distribui vendedores com base nas vendas de ontem
 *   monitorarVendas()       → detecta vendas de hoje e sobe vendedores do Ativo à URA
 *   registrarVenda()        → mesmo gatilho, disparado por webhook
 *
 * Não conhece HTTP, Argus nem o formato da API do Carrossel: depende apenas
 * dos serviços injetados. É aqui que os dois sistemas se encontram: o
 * Carrossel identifica vendedores pelo nome e o DiretorioOperadores traduz
 * o nome para o ramal da Argus.
 */

const { Fila } = require('../domain/fila');
const { Resultado } = require('../integrations/argus/discadora.service');
const { distribuirCargaInicial, deveSubirParaUra } = require('../domain/regras-roteamento');
const { estadoVazio } = require('../repositories/estado.repository');
const { formatarReais, paraNumero } = require('../utils/moeda');

/** Máximo de re-tentativas de sincronização de um ramal com a discadora no dia. */
const MAX_TENTATIVAS_SYNC = 5;

class CargaInicialError extends Error {
  constructor(mensagem, cause) {
    super(mensagem, cause ? { cause } : undefined);
    this.name = 'CargaInicialError';
  }
}

/** Executa `fn`; qualquer falha adia a carga inicial (o agendador tenta de novo). */
async function adiarSeFalhar(fn) {
  try {
    return await fn();
  } catch (e) {
    throw new CargaInicialError(`Carga inicial adiada: ${e.message}`, e);
  }
}

/** Registro de um vendedor no estado do dia. */
const novoRegistro = (campos) => ({
  nome: null,
  equipe: 'Sem equipe',
  vendaOntem: null,
  fila: Fila.ATIVO,
  promovidoNoDia: false,
  vendaQueDisparou: null,
  sincronizado: false,
  tentativasSync: 0,
  ultimoResultado: null,
  atualizadoEm: null,
  ...campos,
});

const motivoDaCarga = (fila, venda) => (fila === Fila.URA
  ? `meta batida ontem (${formatarReais(venda)})`
  : `abaixo da meta ontem (${formatarReais(venda)})`);

/** "grupo anterior: 1, destino: 3" — só o que for informativo. */
const descreverGrupos = (anterior, destino) => [
  anterior != null ? `grupo anterior: ${anterior}` : null,
  destino != null && destino !== anterior ? `destino: ${destino}` : null,
].filter(Boolean).join(', ');

class RoteamentoService {
  /**
   * @param {object} deps
   * @param {import('../integrations/carrossel/carrossel.service').CarrosselService} deps.carrossel
   * @param {import('../integrations/argus/discadora.service').DiscadoraService} deps.discadora
   * @param {import('../repositories/estado.repository').EstadoRepository} deps.repositorio
   * @param {import('../integrations/argus/diretorio-operadores.service').DiretorioOperadores} deps.diretorio
   * @param {{ hoje(): string }} deps.relogio
   * @param {{ metaDiaria: number }} deps.regras
   * @param {object} deps.logger
   */
  constructor({ carrossel, discadora, repositorio, diretorio, relogio, regras, logger }) {
    this.carrossel = carrossel;
    this.discadora = discadora;
    this.repositorio = repositorio;
    this.diretorio = diretorio;
    /** Nomes sem ramal já avisados (evita repetir o aviso a cada ciclo). */
    this.semRamalAvisados = new Set();
    this.relogio = relogio;
    this.regras = regras;
    this.log = logger;
    this.estado = estadoVazio();
    this.trava = Promise.resolve();
    this.ultimoMonitoramento = null;
  }

  /** Carrega o estado persistido. */
  inicializar() {
    this.estado = this.repositorio.carregar();
    return this;
  }

  cargaInicialFeitaHoje() {
    return this.estado.data === this.relogio.hoje();
  }

  /**
   * Garante que operações que alteram o estado rodem uma de cada vez
   * (monitoramento, webhook e recarga manual podem coincidir).
   */
  exclusivo(fn) {
    const execucao = this.trava.then(fn, fn);
    this.trava = execucao.catch(() => {});
    return execucao;
  }

  // ───────────────────────────── Carga inicial ─────────────────────────────

  /**
   * Distribui os vendedores entre URA e Ativo com base nas vendas do dia útil
   * anterior ("ontem" no Carrossel).
   *
   * Se o Carrossel estiver indisponível, lança `CargaInicialError` e NÃO marca
   * o dia como processado — o agendador tenta de novo no próximo ciclo.
   *
   * @returns {Promise<{ ura: number, ativo: number, falhas: number }>}
   * @throws {CargaInicialError}
   */
  executarCargaInicial() {
    return this.exclusivo(() => this.cargaInicial());
  }

  async cargaInicial() {
    const vendasOntem = await this.buscarVendasOntem();
    const vendedores = await this.montarUniversoOuAdiar(vendasOntem.vendedores);

    this.log.info(`Carga inicial: vendas de ${vendasOntem.diaOntem || 'ontem (dia útil anterior)'}, `
      + `meta ${formatarReais(this.regras.metaDiaria)}, extração do Carrossel: ${vendasOntem.ultimaExtracao}.`);

    const { ura, ativo } = distribuirCargaInicial(vendedores, this.regras.metaDiaria);
    this.log.info(`${vendedores.length} vendedor(es): ${ura.length} → URA, ${ativo.length} → Ativo.`);

    const { estado, falhas } = await this.aplicarDistribuicao(ura, ativo);
    this.estado = estado;
    await this.repositorio.salvar(this.estado);

    this.log.info(`Carga inicial concluída: URA=${ura.length} Ativo=${ativo.length} falhas=${falhas}.`);
    return { ura: ura.length, ativo: ativo.length, falhas };
  }

  async buscarVendasOntem() {
    const vendas = await adiarSeFalhar(() => this.carrossel.listarVendas('ontem', { permitirFallback: false }));
    // O dia útil anterior sempre tem vendas; lista vazia indica relatórios
    // ausentes no Carrossel (scraper falhou), não um dia sem vendas.
    if (vendas.vendedores.length === 0) {
      throw new CargaInicialError('Carga inicial adiada: o Carrossel não retornou vendas do dia anterior.');
    }
    return vendas;
  }

  async montarUniversoOuAdiar(vendasOntem) {
    const vendedores = await adiarSeFalhar(() => this.montarUniversoDoDia(vendasOntem));
    if (vendedores.length === 0) throw new CargaInicialError('Carga inicial adiada: nenhum vendedor identificado na Argus.');
    return vendedores;
  }

  /** Cria o estado do dia e leva cada decisão para a discadora. */
  async aplicarDistribuicao(ura, ativo) {
    const estado = { ...estadoVazio(), data: this.relogio.hoje() };
    const decisoes = [...ura.map((v) => [v, Fila.URA]), ...ativo.map((v) => [v, Fila.ATIVO])];
    let falhas = 0;

    for (const [v, fila] of decisoes) {
      const registro = novoRegistro({ nome: v.nome, equipe: v.equipe, vendaOntem: v.totalVendas, fila });
      estado.vendedores[v.ramal] = registro;
      const sincronizado = await this.sincronizar(v.ramal, registro, motivoDaCarga(fila, v.totalVendas));
      if (!sincronizado) falhas++;
    }
    return { estado, falhas };
  }

  /**
   * Universo da carga: todos os operadores que estão na URA ou no Ativo hoje
   * (pela Argus), mais as exceções do arquivo de ramais. Como o Carrossel só
   * lista quem vendeu, quem não aparece nele vendeu R$ 0.
   */
  async montarUniversoDoDia(vendasOntem) {
    await this.diretorio.atualizar({ forcar: true });
    const porRamal = new Map(this.resolverRamais(vendasOntem).map((v) => [v.ramal, v]));

    const candidatos = [...this.diretorio.vendedoresGerenciados(), ...this.diretorio.listarExcecoesRamal()];
    for (const c of candidatos) {
      if (porRamal.has(c.ramal)) continue;
      porRamal.set(c.ramal, { nome: c.nome, chave: c.chave, equipe: 'Sem venda ontem', totalVendas: 0, ramal: c.ramal });
    }
    return [...porRamal.values()];
  }

  /**
   * Associa o ramal da Argus a cada vendedor do Carrossel (pelo nome).
   * Quem não for encontrado é ignorado, com um aviso por nome.
   */
  resolverRamais(vendedores) {
    const resolvidos = [];
    for (const v of vendedores) {
      const ramal = this.diretorio.ramalPorNome(v.nome);
      if (!ramal) {
        this.avisarSemRamal(v);
        continue;
      }
      resolvidos.push({ ...v, ramal });
    }
    return resolvidos;
  }

  avisarSemRamal(v) {
    if (this.semRamalAvisados.has(v.chave)) return;
    this.semRamalAvisados.add(v.chave);
    this.log.aviso(`"${v.nome}" está no Carrossel mas não foi encontrado(a) entre os operadores ativos da Argus; `
      + 'será ignorado(a). Se o nome for diferente na Argus, adicione-o ao arquivo de exceções de ramal.');
  }

  // ───────────────────────────── Monitoramento ─────────────────────────────

  /**
   * Um ciclo de monitoramento: consulta as vendas de hoje (uma requisição para
   * todos os vendedores) e aplica o gatilho de mudança.
   *
   * @returns {Promise<{ promovidos: number, ignorado?: string }>}
   */
  monitorarVendas() {
    return this.exclusivo(() => this.cicloDeMonitoramento());
  }

  async cicloDeMonitoramento() {
    if (!this.cargaInicialFeitaHoje()) return { promovidos: 0, ignorado: 'carga inicial pendente' };

    await this.reprocessarPendentes();

    const { vendedores: vendasHoje, origem } = await this.carrossel.listarVendas('hoje');
    await this.diretorio.atualizar();

    let promovidos = 0;
    for (const v of this.resolverRamais(vendasHoje)) {
      const promovido = await this.aplicarGatilho(v.ramal, v.totalVendas, { nome: v.nome, equipe: v.equipe, origem });
      if (promovido) promovidos++;
    }

    this.ultimoMonitoramento = new Date().toISOString();
    if (promovidos) await this.repositorio.salvar(this.estado);
    return { promovidos };
  }

  /**
   * Registra uma venda recebida por webhook.
   *
   * @param {{ ramal: string|number, valor: number|string, vendedor?: string }} venda
   * @returns {Promise<{ aceito: boolean, promovido: boolean, motivo?: string }>}
   */
  registrarVenda({ ramal, valor, vendedor }) {
    const r = String(ramal ?? '').trim();
    const v = paraNumero(valor);
    if (!r || v <= 0) return Promise.resolve({ aceito: false, promovido: false, motivo: 'ramal ou valor inválido' });

    return this.exclusivo(() => this.processarVenda(r, v, vendedor));
  }

  async processarVenda(ramal, valor, vendedor) {
    if (!this.cargaInicialFeitaHoje()) return { aceito: false, promovido: false, motivo: 'carga inicial pendente' };

    const promovido = await this.aplicarGatilho(ramal, valor, { nome: vendedor, origem: 'webhook' });
    if (promovido) await this.repositorio.salvar(this.estado);
    return { aceito: true, promovido };
  }

  // ───────────────────────────── Internos ─────────────────────────────

  /**
   * Aplica o gatilho de mudança a um vendedor.
   * @returns {Promise<boolean>} true se o vendedor foi promovido à URA
   */
  async aplicarGatilho(ramal, vendaHoje, { nome, equipe, origem }) {
    const registro = this.estado.vendedores[ramal] ?? this.registrarNovoVendedor(ramal, { nome, equipe });
    if (!deveSubirParaUra(registro.fila, vendaHoje)) return false;

    this.log.info(`Gatilho: ${registro.nome} (ramal ${ramal}) vendeu ${formatarReais(vendaHoje)} hoje [${origem}]. Ativo → URA.`);
    Object.assign(registro, {
      fila: Fila.URA, promovidoNoDia: true, vendaQueDisparou: vendaHoje, sincronizado: false, tentativasSync: 0,
    });
    await this.sincronizar(ramal, registro, `venda hoje (${formatarReais(vendaHoje)})`);
    return true;
  }

  /**
   * Vendedor que não estava na carga inicial (ex.: contratado hoje). Entra
   * como Ativo, mas não é movido: fica onde está até vender.
   */
  registrarNovoVendedor(ramal, { nome, equipe }) {
    const registro = novoRegistro({
      nome: nome || `Ramal ${ramal}`,
      equipe: equipe || 'Sem equipe',
      sincronizado: true,
      ultimoResultado: 'NAO_GERENCIADO',
      atualizadoEm: new Date().toISOString(),
    });
    this.estado.vendedores[ramal] = registro;
    this.log.info(`Novo vendedor no Carrossel: ${registro.nome} (ramal ${ramal}).`);
    return registro;
  }

  /**
   * Leva a decisão registrada (`registro.fila`) para a discadora.
   * @returns {Promise<boolean>} true se a discadora ficou consistente com a decisão
   */
  async sincronizar(ramal, registro, motivo) {
    const r = await this.discadora.moverPara(ramal, registro.fila);
    Object.assign(registro, {
      tentativasSync: (registro.tentativasSync || 0) + 1,
      ultimoResultado: r.resultado,
      grupoDestino: r.grupoDestino ?? null,
      atualizadoEm: new Date().toISOString(),
      sincronizado: r.resultado !== Resultado.FALHA,
    });
    this.logarSincronizacao(ramal, registro, motivo, r);
    return registro.sincronizado;
  }

  logarSincronizacao(ramal, registro, motivo, { resultado, grupoAnterior, grupoDestino, erro }) {
    const quem = `${registro.nome} (ramal ${ramal}) → ${registro.fila}`;
    if (resultado === Resultado.FALHA) return this.log.erro(`✗ ${quem} falhou: ${erro}. Será re-tentado.`);
    if (resultado === Resultado.SEM_GRUPO_ATIVO) {
      return this.log.aviso(`⚠ ${quem}: grupo do supervisor não identificado; mantido onde está.`);
    }

    const grupos = descreverGrupos(grupoAnterior, grupoDestino);
    return this.log.info(`✓ ${quem}: ${resultado} — ${motivo}${grupos ? ` (${grupos})` : ''}`);
  }

  /** Re-tenta transferências que falharam, até MAX_TENTATIVAS_SYNC por dia. */
  async reprocessarPendentes() {
    const pendentes = Object.entries(this.estado.vendedores)
      .filter(([, r]) => !r.sincronizado && (r.tentativasSync || 0) < MAX_TENTATIVAS_SYNC);
    if (!pendentes.length) return;

    this.log.info(`Re-tentando ${pendentes.length} transferência(s) pendente(s).`);
    for (const [ramal, registro] of pendentes) {
      await this.sincronizar(ramal, registro, 'nova tentativa');
      if (!registro.sincronizado && registro.tentativasSync >= MAX_TENTATIVAS_SYNC) {
        this.log.erro(`Ramal ${ramal}: desistindo após ${MAX_TENTATIVAS_SYNC} tentativas hoje. Verifique na Argus.`);
      }
    }
    await this.repositorio.salvar(this.estado);
  }

  /** Visão consolidada para o endpoint /status. */
  resumo() {
    const vendedores = Object.entries(this.estado.vendedores).map(([ramal, r]) => ({ ramal, ...r }));
    return {
      data: this.estado.data,
      cargaInicialFeita: this.cargaInicialFeitaHoje(),
      meta: this.regras.metaDiaria,
      ultimoMonitoramento: this.ultimoMonitoramento,
      ura: vendedores.filter((v) => v.fila === Fila.URA),
      ativo: vendedores.filter((v) => v.fila === Fila.ATIVO),
      pendentes: vendedores.filter((v) => !v.sincronizado).map((v) => v.ramal),
    };
  }
}

module.exports = { RoteamentoService, CargaInicialError, MAX_TENTATIVAS_SYNC };

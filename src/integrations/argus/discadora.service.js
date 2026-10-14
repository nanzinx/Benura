'use strict';
/**
 * Camada de serviço da discadora — isola o roteador da estrutura da URA.
 *
 * Princípios que garantem independência de ajustes manuais na URA:
 *
 *  1. FONTE DA VERDADE É A ARGUS, NÃO O SCRIPT.
 *     Antes de transferir, consultamos em qual grupo o ramal está agora.
 *     Nunca presumimos a posição a partir do estado local.
 *
 *  2. OPERAÇÕES IDEMPOTENTES.
 *     Se o ramal já está no grupo destino (ex.: alguém o moveu manualmente),
 *     nada é enviado à Argus e o resultado é `JA_NO_DESTINO`.
 *
 *  3. RESPEITO A GRUPOS EXTERNOS.
 *     Ramais que estão em grupos que o roteador não gerencia (treinamento,
 *     supervisão, outra campanha...) não são puxados de volta, salvo se
 *     RESPEITAR_GRUPOS_EXTERNOS=0.
 *
 *  4. SEM RECONCILIAÇÃO CONTÍNUA.
 *     O roteador só age em eventos de negócio (carga do dia, venda detectada).
 *     Ele não "corrige" a URA periodicamente, então não briga com quem a ajusta
 *     manualmente nem com a automação de rodízio (argus-automacao.js).
 *
 *  5. CONFIGURAÇÃO, NÃO CÓDIGO.
 *     IDs de grupo vêm da configuração; mudanças estruturais na URA exigem
 *     só ajuste de variáveis de ambiente.
 *
 *  6. "ATIVO" É O GRUPO DO SUPERVISOR.
 *     O Ativo não é um grupo só: cada supervisor tem o seu (GABRIEL - COMERCIAL,
 *     MAYSA - COMERCIAL...). Quem já está em qualquer grupo do Ativo fica onde
 *     está; quem precisa voltar da URA vai para o grupo do próprio supervisor,
 *     descoberto pelo DiretorioOperadores.
 */

const { Fila } = require('../../domain/fila');

/** Índice ramal → grupo a partir da resposta de /listargrupos. */
const indexarRamais = (grupos) => new Map(
  grupos.flatMap((g) => (g.ramaisOperadores || []).map((r) => [String(r), g.idGrupoUsuario])),
);

const Resultado = Object.freeze({
  TRANSFERIDO: 'TRANSFERIDO',
  JA_NO_DESTINO: 'JA_NO_DESTINO',
  GRUPO_EXTERNO: 'GRUPO_EXTERNO', // ignorado para respeitar ajuste manual
  SEM_GRUPO_ATIVO: 'SEM_GRUPO_ATIVO', // não foi possível descobrir o grupo do supervisor
  SIMULADO: 'SIMULADO', // DRY_RUN
  FALHA: 'FALHA',
});

class DiscadoraService {
  /**
   * @param {object} deps
   * @param {import('./argus.client').ArgusClient} deps.client
   * @param {object} deps.cfg - Seção `argus` da configuração
   * @param {import('./diretorio-operadores.service').DiretorioOperadores} deps.diretorio
   * @param {boolean} deps.respeitarGruposExternos
   * @param {object} deps.logger
   */
  constructor({ client, cfg, diretorio, respeitarGruposExternos, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.diretorio = diretorio;
    this.respeitarGruposExternos = respeitarGruposExternos;
    this.log = logger;
    this.cache = { mapa: null, em: 0, ids: new Set() };
    this.gruposAtivos = new Set(cfg.gruposAtivosIds);
    this.gruposGerenciados = new Set([cfg.grupoUraId, ...cfg.gruposAtivosIds]);
  }

  /**
   * Mapa ramal → id do grupo atual, com cache curto.
   * @returns {Promise<Map<string, number>|null>} null se a Argus não respondeu
   */
  async mapaDeGrupos({ forcar = false } = {}) {
    const fresco = Date.now() - this.cache.em < this.cfg.cacheGruposMs;
    if (!forcar && fresco) return this.cache.mapa; // inclui falha recente (mapa null)

    const grupos = await this.lerGrupos();
    this.cache = {
      mapa: grupos ? indexarRamais(grupos) : null,
      em: Date.now(),
      ids: new Set((grupos || []).map((g) => g.idGrupoUsuario)),
    };
    return this.cache.mapa;
  }

  /** @returns {Promise<Array|null>} Grupos da Argus, ou null se ela não respondeu. */
  async lerGrupos() {
    try {
      return await this.client.listarGrupos();
    } catch (e) {
      this.log.aviso(`Não foi possível ler os grupos da Argus (${e.message}). Seguindo sem verificação prévia.`);
      return null;
    }
  }

  /**
   * Grupo atual de um ramal.
   * @returns {Promise<number|null|undefined>} undefined = não deu para verificar; null = em nenhum grupo
   */
  async grupoAtualDe(ramal) {
    const mapa = await this.mapaDeGrupos();
    if (!mapa) return undefined;
    return mapa.get(ramal) ?? null;
  }

  invalidarCache() {
    this.cache.em = 0;
  }

  /**
   * Confere se os grupos configurados existem na Argus.
   * Não é fatal: a Argus pode estar fora no boot.
   *
   * @returns {Promise<boolean|null>} true/false, ou null se não foi possível verificar
   */
  async verificarGruposConfigurados() {
    const mapa = await this.mapaDeGrupos({ forcar: true });
    if (!mapa) return null;

    const faltando = [...this.gruposGerenciados].filter((id) => !this.cache.ids.has(id));
    if (faltando.length) {
      this.log.erro(`Grupo(s) configurado(s) não existe(m) na Argus: ${faltando.join(', ')}. Verifique GRUPO_URA_ID/GRUPOS_ATIVOS_IDS.`);
      return false;
    }
    return true;
  }

  /**
   * Grupo destino para uma fila.
   *  - URA: o grupo da URA.
   *  - ATIVO: se já está num grupo do Ativo, ele mesmo (não mexe); senão,
   *    o grupo do supervisor; se só existe um grupo do Ativo, esse.
   * @returns {Promise<number|null>}
   */
  async destinoDaFila(ramal, fila, grupoAtual) {
    if (fila === Fila.URA) return this.cfg.grupoUraId;
    if (fila !== Fila.ATIVO) throw new Error(`Fila desconhecida: ${fila}`);
    if (this.gruposAtivos.has(grupoAtual)) return grupoAtual;

    const peloDiretorio = await this.grupoAtivoPeloDiretorio(ramal, grupoAtual);
    if (peloDiretorio != null) return peloDiretorio;

    return this.gruposAtivos.size === 1 ? [...this.gruposAtivos][0] : null;
  }

  /**
   * Grupo do Ativo segundo o diretório de usuários.
   * Sem leitura de grupos agora (grupoAtual undefined), usa o grupo que o
   * diretório conhece, para não trocar de supervisor quem já está no Ativo.
   */
  async grupoAtivoPeloDiretorio(ramal, grupoAtual) {
    if (!this.diretorio) return null;
    try {
      await this.diretorio.atualizar();
    } catch (e) {
      this.log.aviso(`Não foi possível consultar o supervisor do ramal ${ramal}: ${e.message}`);
      return null;
    }

    const conhecido = grupoAtual === undefined ? this.grupoAtivoConhecido(ramal) : null;
    return conhecido ?? this.diretorio.grupoAtivoDoOperador(ramal);
  }

  /** Grupo do Ativo em que o diretório viu o ramal pela última vez. */
  grupoAtivoConhecido(ramal) {
    const vinculos = this.diretorio.operadorPorRamal(ramal)?.vinculos || [];
    return vinculos.find((v) => this.gruposAtivos.has(v.idGrupo))?.idGrupo ?? null;
  }

  /**
   * Move um ramal para a fila desejada de forma idempotente e segura.
   *
   * @param {string} ramal
   * @param {'URA'|'ATIVO'} fila
   * @returns {Promise<{ resultado: string, grupoAnterior: number|null|undefined, grupoDestino?: number, erro?: string }>}
   */
  async moverPara(ramal, fila) {
    const grupoAnterior = await this.grupoAtualDe(ramal);

    const emGrupoExterno = grupoAnterior != null && !this.gruposGerenciados.has(grupoAnterior);
    if (emGrupoExterno && this.respeitarGruposExternos) {
      this.log.info(`Ramal ${ramal} está no grupo ${grupoAnterior} (não gerenciado). Mantido onde está.`);
      return { resultado: Resultado.GRUPO_EXTERNO, grupoAnterior };
    }

    const destinoId = await this.destinoDaFila(ramal, fila, grupoAnterior);
    if (destinoId == null) {
      this.log.aviso(`Ramal ${ramal}: grupo do Ativo indefinido (supervisor sem grupo identificável). `
        + 'Defina-o em SUPERVISORES_GRUPOS_FILE.');
      return { resultado: Resultado.SEM_GRUPO_ATIVO, grupoAnterior };
    }
    return this.transferirParaGrupo(ramal, destinoId, { grupoAnterior, rotulo: fila });
  }

  /**
   * Transfere um ramal para um grupo específico (idempotente, respeita DRY_RUN).
   * @returns {Promise<{ resultado: string, grupoAnterior, grupoDestino: number, erro?: string }>}
   */
  async transferirParaGrupo(ramal, destinoId, { grupoAnterior, rotulo = `grupo ${destinoId}` } = {}) {
    if (grupoAnterior === undefined) grupoAnterior = await this.grupoAtualDe(ramal);
    const base = { grupoAnterior, grupoDestino: destinoId };

    if (grupoAnterior === destinoId) return { ...base, resultado: Resultado.JA_NO_DESTINO };

    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Transferiria ramal ${ramal} → ${rotulo} (grupo ${destinoId}).`);
      return { ...base, resultado: Resultado.SIMULADO };
    }

    try {
      await this.client.transferirOperador(ramal, destinoId);
      this.invalidarCache();
      return { ...base, resultado: Resultado.TRANSFERIDO };
    } catch (e) {
      this.log.erro(`Falha ao transferir ramal ${ramal} → ${rotulo}: ${e.message}`);
      return { ...base, resultado: Resultado.FALHA, erro: e.message };
    }
  }
}

module.exports = { DiscadoraService, Fila, Resultado };

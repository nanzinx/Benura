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
 */

const { Fila } = require('../../domain/fila');

const Resultado = Object.freeze({
  TRANSFERIDO: 'TRANSFERIDO',
  JA_NO_DESTINO: 'JA_NO_DESTINO',
  GRUPO_EXTERNO: 'GRUPO_EXTERNO', // ignorado para respeitar ajuste manual
  SIMULADO: 'SIMULADO', // DRY_RUN
  FALHA: 'FALHA',
});

class DiscadoraService {
  /**
   * @param {object} deps
   * @param {import('./argus.client').ArgusClient} deps.client
   * @param {object} deps.cfg - Seção `argus` da configuração
   * @param {boolean} deps.respeitarGruposExternos
   * @param {object} deps.logger
   */
  constructor({ client, cfg, respeitarGruposExternos, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.respeitarGruposExternos = respeitarGruposExternos;
    this.log = logger;
    this.cache = { mapa: null, em: 0, ids: new Set() };
    this.grupoPorFila = { [Fila.URA]: cfg.grupoUraId, [Fila.ATIVO]: cfg.grupoAtivoId };
  }

  /**
   * Mapa ramal → id do grupo atual, com cache curto.
   * @returns {Promise<Map<string, number>|null>} null se a Argus não respondeu
   */
  async mapaDeGrupos({ forcar = false } = {}) {
    // DRY_RUN sem token = modo offline: não há Argus para consultar.
    if (this.cfg.dryRun && !this.cfg.token) return null;

    const fresco = Date.now() - this.cache.em < this.cfg.cacheGruposMs;
    if (!forcar && fresco) return this.cache.mapa; // inclui falha recente (mapa null)

    try {
      const grupos = await this.client.listarGrupos();
      const mapa = new Map();
      for (const g of grupos) {
        for (const r of g.ramaisOperadores || []) mapa.set(String(r), g.idGrupoUsuario);
      }
      this.cache = { mapa, em: Date.now(), ids: new Set(grupos.map((g) => g.idGrupoUsuario)) };
      return mapa;
    } catch (e) {
      this.log.aviso(`Não foi possível ler os grupos da Argus (${e.message}). Seguindo sem verificação prévia.`);
      this.cache = { mapa: null, em: Date.now(), ids: new Set() };
      return null;
    }
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

    const faltando = Object.entries(this.grupoPorFila)
      .filter(([, id]) => !this.cache.ids.has(id))
      .map(([fila, id]) => `${fila} (id=${id})`);

    if (faltando.length) {
      this.log.erro(`Grupo(s) configurado(s) não existe(m) na Argus: ${faltando.join(', ')}. Verifique GRUPO_URA_ID/GRUPO_ATIVO_ID.`);
      return false;
    }
    return true;
  }

  /**
   * Move um ramal para a fila desejada de forma idempotente e segura.
   *
   * @param {string} ramal
   * @param {'URA'|'ATIVO'} fila
   * @returns {Promise<{ resultado: string, grupoAnterior: number|null|undefined, erro?: string }>}
   */
  async moverPara(ramal, fila) {
    const destinoId = this.grupoPorFila[fila];
    if (destinoId === undefined) throw new Error(`Fila desconhecida: ${fila}`);

    const mapa = await this.mapaDeGrupos();
    // undefined = não deu para verificar; null = ramal não está em nenhum grupo.
    const grupoAnterior = mapa ? (mapa.get(ramal) ?? null) : undefined;

    if (grupoAnterior === destinoId) {
      return { resultado: Resultado.JA_NO_DESTINO, grupoAnterior };
    }

    const gerenciados = Object.values(this.grupoPorFila);
    const emGrupoExterno = grupoAnterior != null && !gerenciados.includes(grupoAnterior);
    if (emGrupoExterno && this.respeitarGruposExternos) {
      this.log.info(`Ramal ${ramal} está no grupo ${grupoAnterior} (não gerenciado). Mantido onde está.`);
      return { resultado: Resultado.GRUPO_EXTERNO, grupoAnterior };
    }

    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Transferiria ramal ${ramal} → ${fila} (grupo ${destinoId}).`);
      return { resultado: Resultado.SIMULADO, grupoAnterior };
    }

    try {
      await this.client.transferirOperador(ramal, destinoId);
      this.invalidarCache();
      return { resultado: Resultado.TRANSFERIDO, grupoAnterior };
    } catch (e) {
      this.log.erro(`Falha ao transferir ramal ${ramal} → ${fila}: ${e.message}`);
      return { resultado: Resultado.FALHA, grupoAnterior, erro: e.message };
    }
  }
}

module.exports = { DiscadoraService, Fila, Resultado };

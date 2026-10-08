'use strict';
/**
 * Persistência dos operadores que o rodízio colocou na URA ("movidos").
 *
 * Formato (compatível com o state.json do argus-automacao.js original):
 *   { "101": { "origemGrupoId": 1, "entrouEm": 1760000000000, "ausentes": 0 } }
 */

const { lerComBackup, GravadorJsonAtomico } = require('../utils/persistencia-json');

/** Mantém só entradas bem-formadas. */
function normalizar(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return {};
  const validas = Object.entries(bruto)
    .filter(([, m]) => m && Number.isFinite(m.entrouEm) && m.origemGrupoId != null);
  return Object.fromEntries(validas);
}

class EstadoRodizioRepository {
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.log = logger;
    this.gravador = new GravadorJsonAtomico(arquivo, logger);
  }

  /** @returns {object} movidos (vazio se não houver estado). Nunca lança. */
  carregar() {
    const { dados, origem, erro } = lerComBackup(this.arquivo);
    if (erro) this.log.aviso(`Não foi possível ler ${this.arquivo}: ${erro.message}`);
    if (origem === 'backup') this.log.aviso(`${this.arquivo} ilegível; recuperado a partir do .bak.`);
    if (!origem) return {};

    const movidos = normalizar(dados);
    this.log.info(`Estado do rodízio carregado: ${Object.keys(movidos).length} operador(es) na URA pelo rodízio.`);
    return movidos;
  }

  salvar(movidos) {
    return this.gravador.salvar(movidos);
  }

  aguardarEscritas() {
    return this.gravador.aguardar();
  }
}

module.exports = { EstadoRodizioRepository };

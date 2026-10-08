'use strict';
/**
 * Exceções do cadastro nome → ramal (opcional).
 *
 * O ramal de cada vendedor é descoberto automaticamente pelo /listarusuarios
 * da Argus (DiretorioOperadores). Este arquivo só é necessário quando o nome
 * no Carrossel difere do nome na Argus, ou para incluir alguém que não está
 * nos grupos gerenciados. As entradas daqui têm prioridade.
 *
 * Formatos aceitos (JSON):
 *   { "ANA CLARA SOUZA": "1001", "Ricardo Mendes": 1004 }
 *   [ { "nome": "ANA CLARA SOUZA", "ramal": "1001" }, ... ]
 *
 * Nomes são comparados sem acento, sem diferença de maiúsculas e com espaços
 * normalizados. O arquivo é relido automaticamente quando muda no disco.
 */

const fs = require('fs');
const { normalizarNome } = require('../utils/texto');

class CadastroRamaisRepository {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.log = logger;
    this.mtimeMs = -1;
    /** @type {Map<string, { nome: string, ramal: string }>} chave normalizada → registro */
    this.porChave = new Map();
  }

  /**
   * Recarrega o arquivo se ele mudou. Em caso de erro, mantém o último
   * cadastro válido em memória (uma edição malfeita não derruba o roteador).
   */
  atualizar() {
    let stat;
    try {
      stat = fs.statSync(this.arquivo);
    } catch (e) {
      if (this.mtimeMs !== 0) {
        if (e.code !== 'ENOENT') this.log.aviso(`Não foi possível ler ${this.arquivo} (${e.code}).`);
        else if (this.porChave.size) this.log.info(`${this.arquivo} removido; sem exceções de ramal.`);
        this.porChave = new Map();
        this.mtimeMs = 0;
      }
      return this;
    }
    if (stat.mtimeMs === this.mtimeMs) return this;

    try {
      const bruto = JSON.parse(fs.readFileSync(this.arquivo, 'utf8'));
      const entradas = Array.isArray(bruto)
        ? bruto.map((x) => [x?.nome, x?.ramal])
        : Object.entries(bruto || {});

      const mapa = new Map();
      const ramaisVistos = new Map();
      for (const [nome, ramal] of entradas) {
        const chave = normalizarNome(nome);
        const r = String(ramal ?? '').trim();
        if (!chave || !r) {
          this.log.aviso(`Cadastro de ramais: entrada ignorada (nome="${nome}", ramal="${ramal}").`);
          continue;
        }
        if (ramaisVistos.has(r) && ramaisVistos.get(r) !== chave) {
          this.log.aviso(`Cadastro de ramais: ramal ${r} usado por mais de um vendedor (${ramaisVistos.get(r)} e ${chave}).`);
        }
        ramaisVistos.set(r, chave);
        mapa.set(chave, { nome: String(nome).trim(), ramal: r });
      }

      this.porChave = mapa;
      this.mtimeMs = stat.mtimeMs;
      this.log.info(`Exceções de ramal carregadas: ${mapa.size} vendedor(es).`);
    } catch (e) {
      this.log.erro(`Cadastro de ramais inválido (${e.message}). Mantendo a versão anterior (${this.porChave.size} vendedores).`);
      this.mtimeMs = stat.mtimeMs; // não tenta reler o mesmo arquivo quebrado a cada ciclo
    }
    return this;
  }

  /** @returns {string|null} Ramal do vendedor, ou null se não cadastrado. */
  ramalDe(nome) {
    return this.porChave.get(normalizarNome(nome))?.ramal ?? null;
  }

  /** @returns {Array<{ nome: string, chave: string, ramal: string }>} */
  listar() {
    return [...this.porChave].map(([chave, v]) => ({ ...v, chave }));
  }
}

module.exports = { CadastroRamaisRepository };

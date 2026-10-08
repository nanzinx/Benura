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

const { normalizarNome } = require('../utils/texto');
const { ArquivoJsonObservado } = require('../utils/arquivo-json');

/** Converte os dois formatos aceitos em pares [nome, ramal]. */
const paresNomeRamal = (bruto) => (Array.isArray(bruto)
  ? bruto.map((x) => [x?.nome, x?.ramal])
  : Object.entries(bruto || {}));

class CadastroRamaisRepository {
  /**
   * @param {object} deps
   * @param {string} deps.arquivo
   * @param {object} deps.logger
   */
  constructor({ arquivo, logger }) {
    this.arquivo = arquivo;
    this.fonte = new ArquivoJsonObservado(arquivo);
    this.log = logger;
    /** @type {Map<string, { nome: string, ramal: string }>} chave normalizada → registro */
    this.porChave = new Map();
  }

  /**
   * Recarrega o arquivo se ele mudou. Em caso de erro, mantém o último
   * cadastro válido em memória (uma edição malfeita não derruba o roteador).
   */
  atualizar() {
    const { estado, dados, erro } = this.fonte.verificar();
    if (estado === 'inalterado') return this;
    if (estado === 'ausente') return this.limpar(erro);

    if (estado === 'invalido') {
      this.log.erro(`Cadastro de ramais inválido (${erro.message}). Mantendo a versão anterior (${this.porChave.size} vendedores).`);
      return this;
    }

    this.porChave = this.montarMapa(dados);
    this.log.info(`Exceções de ramal carregadas: ${this.porChave.size} vendedor(es).`);
    return this;
  }

  limpar(erro) {
    this.logarRemocao(erro);
    this.porChave = new Map();
    return this;
  }

  logarRemocao(erro) {
    if (erro) return this.log.aviso(`Não foi possível ler ${this.arquivo} (${erro.code || erro.message}).`);
    if (this.porChave.size) return this.log.info(`${this.arquivo} removido; sem exceções de ramal.`);
    return undefined;
  }

  montarMapa(bruto) {
    const mapa = new Map();
    const donoDoRamal = new Map();

    for (const [nome, ramal] of paresNomeRamal(bruto)) {
      const chave = normalizarNome(nome);
      const r = String(ramal ?? '').trim();
      if (!chave || !r) {
        this.log.aviso(`Cadastro de ramais: entrada ignorada (nome="${nome}", ramal="${ramal}").`);
        continue;
      }

      const dono = donoDoRamal.get(r);
      if (dono && dono !== chave) this.log.aviso(`Cadastro de ramais: ramal ${r} usado por mais de um vendedor (${dono} e ${chave}).`);

      donoDoRamal.set(r, chave);
      mapa.set(chave, { nome: String(nome).trim(), ramal: r });
    }
    return mapa;
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

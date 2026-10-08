'use strict';
/**
 * Diretório de usuários da Argus — a "lista telefônica" do sistema.
 *
 * Com uma chamada a /listarusuarios (+ /listargrupos) responde:
 *   - qual o ramal de um vendedor pelo nome (para casar com o Carrossel);
 *   - se um login já existe (ativo ou inativo);
 *   - quem é o supervisor (usuário administrativo) de um nome;
 *   - qual é o grupo do Ativo de cada supervisor;
 *   - quais operadores o roteador gerencia (os que estão na URA ou no Ativo).
 *
 * GRUPO DO SUPERVISOR — como é descoberto:
 *   1. Exceção explícita em SUPERVISORES_GRUPOS_FILE (nome do supervisor → idGrupo);
 *   2. Senão, é inferido dos dados: o grupo do Ativo onde está a maioria dos
 *      operadores daquele supervisor. Não depende do nome do grupo
 *      ("MAYSA - COMERCIAL"), então renomear grupos na Argus não quebra nada.
 *
 * O snapshot fica em cache (ARGUS_CACHE_DIRETORIO_MS). Se a Argus falhar, o
 * último snapshot válido continua sendo usado.
 */

const fs = require('fs');
const { normalizarNome, normalizarLogin } = require('../../utils/texto');
const { TipoUsuario } = require('./argus.client');

class DiretorioIndisponivelError extends Error {
  constructor(mensagem, cause) {
    super(mensagem, cause ? { cause } : undefined);
    this.name = 'DiretorioIndisponivelError';
  }
}

/** Converte o usuário cru da Argus no modelo interno. */
function mapearUsuario(u) {
  return {
    idUsuario: u.idUsuario,
    nome: String(u.nome || '').trim(),
    chave: normalizarNome(u.nome),
    login: normalizarLogin(u.login),
    ramal: u.ramal ? String(u.ramal).trim() : null,
    ativo: u.ativo !== false,
    tipo: u.idTipoUsuario,
    vinculos: (u.campanhas || []).map((c) => ({
      idCampanha: c.idCampanha,
      campanhaDesc: c.campanhaDesc,
      idGrupo: c.idGrupoUsuario ?? null,
      grupoDesc: c.grupoUsuarioDesc ?? null,
      idSupervisor: c.idUsuarioSupervisor ?? null,
      nomeSupervisor: c.nomeUsuarioSupervisor ?? null,
    })),
  };
}

/** Agrupa itens por chave, preservando todos (nomes podem repetir). */
function indexar(itens, chaveDe) {
  const mapa = new Map();
  for (const item of itens) {
    const k = chaveDe(item);
    if (!k) continue;
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(item);
  }
  return mapa;
}

class DiretorioOperadores {
  /**
   * @param {object} deps
   * @param {import('./argus.client').ArgusClient} deps.client
   * @param {{ grupoUraId: number, gruposAtivosIds: number[], cacheDiretorioMs: number }} deps.cfg
   * @param {import('../../repositories/cadastro-ramais.repository').CadastroRamaisRepository} [deps.excecoesRamal]
   * @param {string} [deps.arquivoSupervisoresGrupos]
   * @param {object} deps.logger
   */
  constructor({ client, cfg, excecoesRamal, arquivoSupervisoresGrupos, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.excecoesRamal = excecoesRamal;
    this.arquivoSupervisoresGrupos = arquivoSupervisoresGrupos;
    this.log = logger;
    this.snapshot = null;
    this.carregadoEm = 0;
    this.avisosAmbiguidade = new Set();
  }

  get gruposAtivos() {
    return new Set(this.cfg.gruposAtivosIds);
  }

  get gruposGerenciados() {
    return new Set([this.cfg.grupoUraId, ...this.cfg.gruposAtivosIds]);
  }

  // ───────────────────────────── Carga ─────────────────────────────

  /**
   * Recarrega o snapshot se o cache venceu.
   * @throws {DiretorioIndisponivelError} só se nunca houve um snapshot válido
   */
  async atualizar({ forcar = false } = {}) {
    this.excecoesRamal?.atualizar();
    const fresco = Date.now() - this.carregadoEm < this.cfg.cacheDiretorioMs;
    if (!forcar && this.snapshot && fresco) return this;

    try {
      const [usuariosCrus, grupos] = await Promise.all([this.client.listarUsuarios(), this.client.listarGrupos()]);
      this.snapshot = this.montarSnapshot(usuariosCrus.map(mapearUsuario), grupos);
      this.carregadoEm = Date.now();
      this.log.debug(`Diretório Argus: ${this.snapshot.usuarios.length} usuário(s), ${grupos.length} grupo(s).`);
    } catch (e) {
      if (!this.snapshot) throw new DiretorioIndisponivelError(`Diretório de usuários da Argus indisponível: ${e.message}`, e);
      this.log.aviso(`Falha ao atualizar o diretório da Argus (${e.message}); usando dados de ${new Date(this.carregadoEm).toISOString()}.`);
      this.carregadoEm = Date.now(); // evita re-tentar a cada chamada
    }
    return this;
  }

  montarSnapshot(usuarios, grupos) {
    const operadoresAtivos = usuarios.filter((u) => u.tipo === TipoUsuario.OPERADOR && u.ativo);
    const supervisores = usuarios.filter((u) => u.tipo === TipoUsuario.ADMINISTRATIVO && u.ativo);
    return {
      usuarios,
      grupos: new Map(grupos.map((g) => [g.idGrupoUsuario, g])),
      porLogin: indexar(usuarios, (u) => u.login),
      operadoresPorChave: indexar(operadoresAtivos, (u) => u.chave),
      operadoresPorRamal: new Map(operadoresAtivos.filter((u) => u.ramal).map((u) => [u.ramal, u])),
      supervisores,
      supervisoresPorChave: indexar(supervisores, (u) => u.chave),
      grupoInferidoPorSupervisor: this.inferirGruposDosSupervisores(operadoresAtivos),
    };
  }

  /** Para cada supervisor, o grupo do Ativo com mais operadores dele (empate = indefinido). */
  inferirGruposDosSupervisores(operadores) {
    const contagem = new Map(); // idSupervisor → Map(idGrupo → qtde)
    for (const op of operadores) {
      for (const v of op.vinculos) {
        if (v.idSupervisor == null || !this.gruposAtivos.has(v.idGrupo)) continue;
        if (!contagem.has(v.idSupervisor)) contagem.set(v.idSupervisor, new Map());
        const porGrupo = contagem.get(v.idSupervisor);
        porGrupo.set(v.idGrupo, (porGrupo.get(v.idGrupo) || 0) + 1);
      }
    }
    const resultado = new Map();
    for (const [idSupervisor, porGrupo] of contagem) {
      const ordenado = [...porGrupo].sort((a, b) => b[1] - a[1]);
      if (ordenado.length === 1 || ordenado[0][1] > ordenado[1][1]) resultado.set(idSupervisor, ordenado[0][0]);
    }
    return resultado;
  }

  exigirSnapshot() {
    if (!this.snapshot) throw new DiretorioIndisponivelError('Diretório da Argus ainda não carregado (chame atualizar()).');
    return this.snapshot;
  }

  // ───────────────────────────── Consultas ─────────────────────────────

  /** Usuários (qualquer tipo, ativos ou não) com este login. */
  usuariosPorLogin(login) {
    return this.exigirSnapshot().porLogin.get(normalizarLogin(login)) || [];
  }

  /** Operadores ativos com este nome. */
  operadoresPorNome(nome) {
    return this.exigirSnapshot().operadoresPorChave.get(normalizarNome(nome)) || [];
  }

  operadorPorRamal(ramal) {
    return this.exigirSnapshot().operadoresPorRamal.get(String(ramal)) || null;
  }

  grupo(idGrupo) {
    return this.exigirSnapshot().grupos.get(idGrupo) || null;
  }

  /**
   * Ramal de um vendedor pelo nome: exceção manual primeiro, depois a Argus.
   * Nomes repetidos entre operadores ativos são ambíguos e retornam null.
   */
  ramalPorNome(nome) {
    const excecao = this.excecoesRamal?.ramalDe(nome);
    if (excecao) return excecao;

    const comRamal = this.operadoresPorNome(nome).filter((u) => u.ramal);
    if (comRamal.length === 1) return comRamal[0].ramal;
    if (comRamal.length > 1) {
      const chave = normalizarNome(nome);
      if (!this.avisosAmbiguidade.has(chave)) {
        this.avisosAmbiguidade.add(chave);
        this.log.aviso(`Nome "${nome}" corresponde a ${comRamal.length} operadores na Argus `
          + `(ramais ${comRamal.map((u) => u.ramal).join(', ')}). Defina o ramal no arquivo de exceções.`);
      }
    }
    return null;
  }

  /**
   * Supervisor (usuário administrativo ativo) pelo nome.
   * Aceita nome exato (normalizado) ou, se único, um nome que comece pelo outro
   * — a Argus e o Vanguard às vezes abreviam sobrenomes.
   *
   * @returns {{ supervisor: object|null, candidatos: object[] }}
   */
  supervisorPorNome(nome) {
    const { supervisores, supervisoresPorChave } = this.exigirSnapshot();
    const chave = normalizarNome(nome);
    const exatos = supervisoresPorChave.get(chave) || [];
    if (exatos.length === 1) return { supervisor: exatos[0], candidatos: exatos };
    if (exatos.length > 1) return { supervisor: null, candidatos: exatos };

    const parciais = supervisores.filter((s) => chave.split(' ').length >= 2
      && (s.chave.startsWith(`${chave} `) || chave.startsWith(`${s.chave} `)));
    return { supervisor: parciais.length === 1 ? parciais[0] : null, candidatos: parciais };
  }

  /**
   * Grupo do Ativo de um supervisor.
   * @returns {{ idGrupo: number, origem: 'excecao'|'inferido' }|null}
   */
  grupoDoSupervisor(supervisor) {
    if (!supervisor) return null;
    const excecoes = this.lerExcecoesSupervisores();
    const idExcecao = excecoes.get(supervisor.chave);
    if (idExcecao != null) return { idGrupo: idExcecao, origem: 'excecao' };

    const inferido = this.exigirSnapshot().grupoInferidoPorSupervisor.get(supervisor.idUsuario);
    return inferido != null ? { idGrupo: inferido, origem: 'inferido' } : null;
  }

  /**
   * Grupo do Ativo para onde um operador deve voltar: o do supervisor dele.
   * @returns {number|null}
   */
  grupoAtivoDoOperador(ramal) {
    const op = this.operadorPorRamal(ramal);
    if (!op) return null;
    for (const v of op.vinculos) {
      if (v.idSupervisor == null) continue;
      const sup = this.usuarioPorId(v.idSupervisor);
      const grupo = this.grupoDoSupervisor(sup || { idUsuario: v.idSupervisor, chave: normalizarNome(v.nomeSupervisor) });
      if (grupo) return grupo.idGrupo;
    }
    return null;
  }

  /** Todos os ramais em uso (qualquer usuário, ativo ou não). */
  ramaisEmUso() {
    return this.exigirSnapshot().usuarios.map((u) => u.ramal).filter(Boolean);
  }

  /** Usuário pelo id (qualquer tipo). */
  usuarioPorId(idUsuario) {
    return this.exigirSnapshot().usuarios.find((u) => u.idUsuario === idUsuario) || null;
  }

  /** Entradas do arquivo de exceções nome → ramal. */
  listarExcecoesRamal() {
    return this.excecoesRamal?.listar() || [];
  }

  /** Operadores ativos que estão hoje na URA ou em algum grupo do Ativo. */
  vendedoresGerenciados() {
    const gerenciados = this.gruposGerenciados;
    return this.exigirSnapshot().usuarios
      .filter((u) => u.tipo === TipoUsuario.OPERADOR && u.ativo && u.ramal
        && u.vinculos.some((v) => gerenciados.has(v.idGrupo)))
      .map((u) => ({ nome: u.nome, chave: u.chave, ramal: u.ramal }));
  }

  /** Exceções supervisor → grupo (arquivo JSON opcional, relido a cada chamada se mudar). */
  lerExcecoesSupervisores() {
    if (!this.arquivoSupervisoresGrupos) return new Map();
    try {
      const stat = fs.statSync(this.arquivoSupervisoresGrupos);
      if (this.excecoesSup?.mtimeMs === stat.mtimeMs) return this.excecoesSup.mapa;
      const bruto = JSON.parse(fs.readFileSync(this.arquivoSupervisoresGrupos, 'utf8'));
      const mapa = new Map(Object.entries(bruto).map(([nome, id]) => [normalizarNome(nome), Number(id)]));
      this.excecoesSup = { mtimeMs: stat.mtimeMs, mapa };
      this.log.info(`Exceções supervisor → grupo carregadas: ${mapa.size}.`);
      return mapa;
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.excecoesSup = null;
        return new Map();
      }
      this.log.aviso(`Exceções supervisor → grupo inválidas (${e.message}); mantendo a versão anterior.`);
      return this.excecoesSup?.mapa || new Map();
    }
  }
}

module.exports = { DiretorioOperadores, DiretorioIndisponivelError, mapearUsuario };

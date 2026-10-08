'use strict';
/**
 * Cadastro de operadores na Argus a partir do login no Vanguard.
 *
 * A API da Argus NÃO tem comando para criar usuários (doc-api-argus.pdf), então
 * o fluxo é semiautomático e dividido em duas etapas:
 *
 *   1. planejar(login)  → busca o funcionário no Vanguard, confere se o login já
 *                         existe na Argus, descobre supervisor e grupo e gera a
 *                         FICHA pronta para o cadastro manual no programa da Argus.
 *
 *   2. conferir(login)  → depois do cadastro manual, lê a Argus de novo, confere
 *                         grupo e supervisor e, se pedido, corrige o grupo pela API.
 *
 * Toda execução é registrada na auditoria.
 *
 * Independência da URA: a conferência nunca tira da URA um operador que esteja
 * lá — o rodízio (argus-automacao.js) pode tê-lo colocado ali legitimamente.
 */

const {
  StatusPlano, StatusConferencia, interpretarLoginVanguard, motivoDeBloqueio, nomeParaArgus,
  sugerirProximoRamal, compararCadastro, statusDaConferencia,
} = require('../domain/cadastro-operador');
const { Resultado } = require('../integrations/argus/discadora.service');
const { TipoUsuario } = require('../integrations/argus/argus.client');

/** Resultados da discadora que deixam o grupo correto. */
const RESULTADOS_CORRIGIDOS = new Set([Resultado.TRANSFERIDO, Resultado.SIMULADO, Resultado.JA_NO_DESTINO]);

class CadastroOperadorService {
  /**
   * @param {object} deps
   * @param {{ buscarPorLogin(login: string): Promise<object|null> }} deps.fonteFuncionarios - Vanguard
   * @param {import('../integrations/argus/diretorio-operadores.service').DiretorioOperadores} deps.diretorio
   * @param {import('../integrations/argus/discadora.service').DiscadoraService} deps.discadora
   * @param {import('../repositories/auditoria.repository').AuditoriaRepository} deps.auditoria
   * @param {{ grupoUraId: number }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ fonteFuncionarios, diretorio, discadora, auditoria, cfg, logger }) {
    this.fonte = fonteFuncionarios;
    this.diretorio = diretorio;
    this.discadora = discadora;
    this.auditoria = auditoria;
    this.cfg = cfg;
    this.log = logger;
  }

  // ───────────────────────────── Etapa 1: planejar ─────────────────────────────

  /**
   * Gera a ficha de cadastro de um operador.
   * @returns {Promise<{ status: string, loginVanguard: string, ficha?: object, pendencias: string[], avisos: string[], existentes?: object[], motivo?: string }>}
   */
  async planejar(loginVanguardBruto) {
    const plano = await this.montarPlano(loginVanguardBruto);
    await this.auditoria.registrar('cadastro.planejar', plano);
    this.log.info(`Planejamento de ${plano.loginVanguard}: ${plano.status}`);
    return plano;
  }

  async montarPlano(loginVanguardBruto) {
    const base = { loginVanguard: String(loginVanguardBruto), pendencias: [], avisos: [] };

    let login;
    try {
      login = interpretarLoginVanguard(loginVanguardBruto);
    } catch (e) {
      return { ...base, status: StatusPlano.BLOQUEADO, motivo: e.message };
    }
    Object.assign(base, login);

    const funcionario = await this.buscarFuncionario(login.loginVanguard);
    const bloqueio = motivoDeBloqueio(funcionario);
    if (bloqueio) return { ...base, funcionario, status: StatusPlano.BLOQUEADO, motivo: bloqueio };
    base.funcionario = funcionario;

    await this.diretorio.atualizar({ forcar: true });
    const jaExiste = this.verificarLoginExistente(login.loginArgus);
    if (jaExiste) return { ...base, ...jaExiste };

    base.avisos.push(...this.avisosDeHomonimos(funcionario.nome));
    const { supervisor, grupo, pendencias } = this.resolverSupervisorEGrupo(funcionario.supervisor);
    base.pendencias.push(...pendencias);
    base.ficha = this.montarFicha({ funcionario, login, supervisor, grupo });

    return { ...base, status: base.pendencias.length ? StatusPlano.PENDENTE : StatusPlano.PRONTO };
  }

  /** @returns {object|null} Resultado JA_EXISTE, ou null se o login está livre. */
  verificarLoginExistente(loginArgus) {
    const existentes = this.diretorio.usuariosPorLogin(loginArgus).map((u) => this.resumirUsuario(u));
    if (!existentes.length) return null;

    const todosInativos = existentes.every((u) => !u.ativo);
    const motivo = todosInativos
      ? `O login ${loginArgus} já existe na Argus, INATIVO. Reative o usuário em vez de criar outro.`
      : `O login ${loginArgus} já existe na Argus. Use "conferir" para validar grupo e supervisor.`;
    return { status: StatusPlano.JA_EXISTE, existentes, motivo };
  }

  /** Mesmo nome com outro login pode ser a mesma pessoa (recontratação, erro de digitação). */
  avisosDeHomonimos(nome) {
    const homonimos = this.diretorio.operadoresPorNome(nome);
    if (!homonimos.length) return [];
    return [`Já existe operador ativo com o nome "${nome}" e outro login `
      + `(${homonimos.map((u) => u.login).join(', ')}). Confirme que não é a mesma pessoa.`];
  }

  /** Ficha para o formulário "Cadastro de Usuário" da Argus. */
  montarFicha({ funcionario, login, supervisor, grupo }) {
    const grupoArgus = grupo ? this.diretorio.grupo(grupo.idGrupo) : null;
    return {
      tipo: 'Operador',
      nome: nomeParaArgus(funcionario.nome),
      login: login.loginArgus,
      ramalIntegracaoSugerido: sugerirProximoRamal(this.diretorio.ramaisEmUso()),
      vinculo: {
        campanha: grupoArgus?.campanhaDesc ?? null,
        idCampanha: grupoArgus?.idCampanha ?? null,
        grupo: grupoArgus?.grupoUsuarioDesc ?? (grupo ? `id ${grupo.idGrupo}` : null),
        idGrupo: grupo?.idGrupo ?? null,
        grupoOrigem: grupo?.origem ?? null,
        supervisor: supervisor?.nome ?? null,
        idSupervisor: supervisor?.idUsuario ?? null,
        principal: true,
        perfil: 'Operador',
      },
    };
  }

  // ───────────────────────────── Etapa 2: conferir ─────────────────────────────

  /**
   * Confere o cadastro feito manualmente na Argus.
   * @param {string} loginVanguardBruto
   * @param {{ corrigir?: boolean }} [opcoes] - corrigir: transfere para o grupo certo pela API
   */
  async conferir(loginVanguardBruto, { corrigir = false } = {}) {
    const resultado = await this.montarConferencia(loginVanguardBruto, { corrigir });
    await this.auditoria.registrar('cadastro.conferir', { ...resultado, corrigir });
    this.log.info(`Conferência de ${resultado.loginVanguard}: ${resultado.status}`);
    return resultado;
  }

  async montarConferencia(loginVanguardBruto, { corrigir }) {
    const login = interpretarLoginVanguard(loginVanguardBruto);
    const base = { ...login, divergencias: [], acoes: [], pendencias: [] };

    await this.diretorio.atualizar({ forcar: true });
    const usuario = this.localizarOperador(login.loginArgus);
    if (!usuario) {
      return { ...base, status: StatusConferencia.NAO_ENCONTRADO, motivo: `Login ${login.loginArgus} não encontrado na Argus.` };
    }
    base.usuario = this.resumirUsuario(usuario);

    const { esperado, pendencias } = await this.montarEsperado(login.loginVanguard);
    base.esperado = esperado;
    base.pendencias.push(...pendencias);

    const { vinculo, divergencias } = compararCadastro(usuario, esperado);
    base.divergencias = divergencias.map((d) => this.descreverDivergencia(d));
    await this.tratarDivergenciaDeGrupo(base, { usuario, vinculo, corrigir });

    if (base.divergencias.some((d) => d.campo === 'supervisor')) {
      base.pendencias.push('Supervisor divergente: a API da Argus não altera supervisor. Ajuste no cadastro do usuário.');
    }
    return { ...base, status: statusDaConferencia(base, esperado) };
  }

  /** Prefere o operador ativo quando há mais de um usuário com o login. */
  localizarOperador(loginArgus) {
    const candidatos = this.diretorio.usuariosPorLogin(loginArgus);
    return candidatos.find((u) => u.ativo && u.tipo === TipoUsuario.OPERADOR) || candidatos[0] || null;
  }

  /** Esperado: supervisor informado pelo Vanguard e o grupo do Ativo dele. */
  async montarEsperado(loginVanguard) {
    const funcionario = await this.buscarFuncionario(loginVanguard);
    const { supervisor, grupo, pendencias } = this.resolverSupervisorEGrupo(funcionario?.supervisor);
    const esperado = {
      idGrupo: grupo?.idGrupo ?? null,
      idSupervisor: supervisor?.idUsuario ?? null,
      grupo: grupo ? this.diretorio.grupo(grupo.idGrupo)?.grupoUsuarioDesc ?? null : null,
      supervisor: supervisor?.nome ?? null,
    };
    return { esperado, pendencias };
  }

  /**
   * Grupo divergente:
   *  - operador na URA → ignora (pode ser o rodízio; não mexemos na URA);
   *  - --corrigir      → transfere para o grupo esperado pela API;
   *  - senão           → fica como divergência.
   */
  async tratarDivergenciaDeGrupo(base, { usuario, vinculo, corrigir }) {
    const divGrupo = base.divergencias.find((d) => d.campo === 'grupo');
    if (!divGrupo) return;

    if (vinculo?.idGrupo === this.cfg.grupoUraId) {
      base.divergencias = base.divergencias.filter((d) => d !== divGrupo);
      base.acoes.push('Operador está na URA agora (rodízio). Grupo não conferido para não interferir na URA.');
      return;
    }
    if (!corrigir || !usuario.ramal) return;

    const { idGrupo, grupo } = base.esperado;
    const r = await this.discadora.transferirParaGrupo(usuario.ramal, idGrupo, { rotulo: grupo });
    base.acoes.push(`Transferência para o grupo ${idGrupo}: ${r.resultado}${r.erro ? ` (${r.erro})` : ''}`);
    if (!RESULTADOS_CORRIGIDOS.has(r.resultado)) return;

    base.divergencias = base.divergencias.filter((d) => d !== divGrupo);
    base.corrigido = true;
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  async buscarFuncionario(loginVanguard) {
    try {
      return await this.fonte.buscarPorLogin(loginVanguard);
    } catch (e) {
      throw new Error(`Falha ao consultar o funcionário ${loginVanguard} no Vanguard: ${e.message}`, { cause: e });
    }
  }

  /** Supervisor (Argus) pelo nome vindo do Vanguard, e o grupo do Ativo dele. */
  resolverSupervisorEGrupo(nomeSupervisor) {
    const semResultado = (pendencia) => ({ supervisor: null, grupo: null, pendencias: [pendencia] });
    if (!nomeSupervisor) return semResultado('Supervisor não informado pelo Vanguard.');

    const { supervisor, candidatos } = this.diretorio.supervisorPorNome(nomeSupervisor);
    if (candidatos.length > 1 && !supervisor) {
      return semResultado(`Supervisor "${nomeSupervisor}" ambíguo na Argus: ${candidatos.map((c) => c.nome).join(' | ')}.`);
    }
    if (!supervisor) {
      return semResultado(`Supervisor "${nomeSupervisor}" não encontrado entre os usuários administrativos ativos da Argus.`);
    }

    const grupo = this.diretorio.grupoDoSupervisor(supervisor);
    if (grupo) return { supervisor, grupo, pendencias: [] };
    return {
      supervisor,
      grupo: null,
      pendencias: [`Não foi possível identificar o grupo do Ativo de ${supervisor.nome}. Defina-o em SUPERVISORES_GRUPOS_FILE.`],
    };
  }

  /** Troca ids de grupo/supervisor por "NOME (id)" para leitura humana. */
  descreverDivergencia(d) {
    const nomeDe = {
      grupo: (id) => this.diretorio.grupo(id)?.grupoUsuarioDesc,
      supervisor: (id) => this.diretorio.usuarioPorId(id)?.nome,
    }[d.campo];
    if (!nomeDe) return d;
    const fmt = (id) => (id == null ? '(nenhum)' : `${nomeDe(id) ?? '?'} (id ${id})`);
    return { ...d, esperado: fmt(d.esperado), atual: fmt(d.atual), idEsperado: d.esperado, idAtual: d.atual };
  }

  resumirUsuario(u) {
    const v = u.vinculos.find((x) => x.idGrupo != null) || u.vinculos[0];
    return {
      idUsuario: u.idUsuario,
      nome: u.nome,
      login: u.login,
      ramal: u.ramal,
      ativo: u.ativo,
      tipo: u.tipo === TipoUsuario.OPERADOR ? 'Operador' : 'Administrativo',
      grupo: v?.grupoDesc ?? null,
      idGrupo: v?.idGrupo ?? null,
      supervisor: v?.nomeSupervisor ?? null,
    };
  }
}

module.exports = { CadastroOperadorService };

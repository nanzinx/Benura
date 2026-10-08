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
  StatusPlano, StatusConferencia, interpretarLoginVanguard, ehPerfilOperador, ehStatusAtivo,
  sugerirProximoRamal, compararCadastro,
} = require('../domain/cadastro-operador');
const { Resultado } = require('../integrations/argus/discadora.service');
const { TipoUsuario } = require('../integrations/argus/argus.client');

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

    // 1. Login do Vanguard → login da Argus
    let login;
    try {
      login = interpretarLoginVanguard(loginVanguardBruto);
    } catch (e) {
      return { ...base, status: StatusPlano.BLOQUEADO, motivo: e.message };
    }
    Object.assign(base, login);

    // 2. Funcionário no Vanguard
    const funcionario = await this.buscarFuncionario(login.loginVanguard);
    if (!funcionario?.nome) {
      return { ...base, status: StatusPlano.BLOQUEADO, motivo: 'Funcionário não encontrado no Vanguard (ou sem nome).' };
    }
    base.funcionario = funcionario;
    if (!ehPerfilOperador(funcionario.perfil)) {
      return { ...base, status: StatusPlano.BLOQUEADO, motivo: `Perfil "${funcionario.perfil}" não é de operador.` };
    }
    if (!ehStatusAtivo(funcionario.status)) {
      return { ...base, status: StatusPlano.BLOQUEADO, motivo: `Funcionário está "${funcionario.status}" no Vanguard.` };
    }

    // 3. Já existe na Argus?
    await this.diretorio.atualizar({ forcar: true });
    const existentes = this.diretorio.usuariosPorLogin(login.loginArgus).map((u) => this.resumirUsuario(u));
    if (existentes.length) {
      const inativo = existentes.every((u) => !u.ativo);
      return {
        ...base,
        status: StatusPlano.JA_EXISTE,
        existentes,
        motivo: inativo
          ? `O login ${login.loginArgus} já existe na Argus, INATIVO. Reative o usuário em vez de criar outro.`
          : `O login ${login.loginArgus} já existe na Argus. Use "conferir" para validar grupo e supervisor.`,
      };
    }

    const homonimos = this.diretorio.operadoresPorNome(funcionario.nome);
    if (homonimos.length) {
      base.avisos.push(`Já existe operador ativo com o nome "${funcionario.nome}" e outro login `
        + `(${homonimos.map((u) => u.login).join(', ')}). Confirme que não é a mesma pessoa.`);
    }

    // 4. Supervisor e grupo
    const { supervisor, grupo, pendencias } = this.resolverSupervisorEGrupo(funcionario.supervisor);
    base.pendencias.push(...pendencias);

    // 5. Ficha para o formulário "Cadastro de Usuário" da Argus
    const grupoArgus = grupo ? this.diretorio.grupo(grupo.idGrupo) : null;
    base.ficha = {
      tipo: 'Operador',
      nome: funcionario.nome.replace(/\s+/g, ' ').trim().toUpperCase(), // padrão da Argus
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

    return { ...base, status: base.pendencias.length ? StatusPlano.PENDENTE : StatusPlano.PRONTO };
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
    const candidatos = this.diretorio.usuariosPorLogin(login.loginArgus);
    const usuario = candidatos.find((u) => u.ativo && u.tipo === TipoUsuario.OPERADOR) || candidatos[0];
    if (!usuario) {
      return { ...base, status: StatusConferencia.NAO_ENCONTRADO, motivo: `Login ${login.loginArgus} não encontrado na Argus.` };
    }
    base.usuario = this.resumirUsuario(usuario);

    // Esperado: supervisor do Vanguard e o grupo dele.
    const funcionario = await this.buscarFuncionario(login.loginVanguard);
    const { supervisor, grupo, pendencias } = this.resolverSupervisorEGrupo(funcionario?.supervisor);
    base.pendencias.push(...pendencias);
    const esperado = { idGrupo: grupo?.idGrupo ?? null, idSupervisor: supervisor?.idUsuario ?? null };
    base.esperado = {
      ...esperado,
      grupo: grupo ? this.diretorio.grupo(grupo.idGrupo)?.grupoUsuarioDesc ?? null : null,
      supervisor: supervisor?.nome ?? null,
    };

    const { vinculo, divergencias } = compararCadastro(usuario, esperado);
    base.divergencias = divergencias.map((d) => this.descreverDivergencia(d));

    const divGrupo = base.divergencias.find((d) => d.campo === 'grupo');
    if (divGrupo && vinculo?.idGrupo === this.cfg.grupoUraId) {
      // Pode estar na URA pelo rodízio: não é erro de cadastro e não mexemos.
      base.divergencias = base.divergencias.filter((d) => d !== divGrupo);
      base.acoes.push('Operador está na URA agora (rodízio). Grupo não conferido para não interferir na URA.');
    } else if (divGrupo && corrigir && usuario.ramal) {
      const r = await this.discadora.transferirParaGrupo(usuario.ramal, esperado.idGrupo, { rotulo: base.esperado.grupo });
      base.acoes.push(`Transferência para o grupo ${esperado.idGrupo}: ${r.resultado}${r.erro ? ` (${r.erro})` : ''}`);
      if (r.resultado === Resultado.TRANSFERIDO || r.resultado === Resultado.SIMULADO || r.resultado === Resultado.JA_NO_DESTINO) {
        base.divergencias = base.divergencias.filter((d) => d !== divGrupo);
        base.corrigido = true;
      }
    }

    if (base.divergencias.some((d) => d.campo === 'supervisor')) {
      base.pendencias.push('Supervisor divergente: a API da Argus não altera supervisor. Ajuste no cadastro do usuário.');
    }

    let status = StatusConferencia.OK;
    if (base.divergencias.length) status = StatusConferencia.DIVERGENTE;
    else if (esperado.idGrupo == null || esperado.idSupervisor == null) status = StatusConferencia.INCONCLUSIVO;
    else if (base.corrigido) status = StatusConferencia.CORRIGIDO;
    return { ...base, status };
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
    const pendencias = [];
    if (!nomeSupervisor) {
      pendencias.push('Supervisor não informado pelo Vanguard.');
      return { supervisor: null, grupo: null, pendencias };
    }

    const { supervisor, candidatos } = this.diretorio.supervisorPorNome(nomeSupervisor);
    if (!supervisor) {
      pendencias.push(candidatos.length > 1
        ? `Supervisor "${nomeSupervisor}" ambíguo na Argus: ${candidatos.map((c) => c.nome).join(' | ')}.`
        : `Supervisor "${nomeSupervisor}" não encontrado entre os usuários administrativos ativos da Argus.`);
      return { supervisor: null, grupo: null, pendencias };
    }

    const grupo = this.diretorio.grupoDoSupervisor(supervisor);
    if (!grupo) {
      pendencias.push(`Não foi possível identificar o grupo do Ativo de ${supervisor.nome}. `
        + 'Defina-o em SUPERVISORES_GRUPOS_FILE.');
    }
    return { supervisor, grupo, pendencias };
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

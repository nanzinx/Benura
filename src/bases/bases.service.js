'use strict';
/**
 * Montagem e subida das bases (Ativo, URA, Digital).
 *
 *   1. baixa a esteira do Vanguard (robô) com os cenários da base;
 *   2. Ativo/URA: tira da base mestra quem está na esteira; Digital: a base é a esteira filtrada;
 *   3. embaralha e divide em partes iguais entre as equipes;
 *   4. grava um CSV por equipe na pasta de saída (sempre — fica de histórico);
 *   5. modo "argus": sobe cada CSV na skill da equipe e exclui o mailing anterior dela.
 *
 * Travas de segurança: sem esteira, sem base mestra ou sem ninguém para remover,
 * a base NÃO é gerada (subir uma base sem a remoção ligaria para quem já fechou).
 */

const fs = require('fs');
const path = require('path');
const {
  TipoBase, chavesDaEsteira, removerDaBase, paraLeads, leadsDaEsteira, embaralhar, dividirIgual,
  montarCsvMailing, nomeDoArquivo, horariosDoDia, horarioPendente,
} = require('../domain/bases');
const { lerTabela } = require('../utils/planilhas');
const { esperar } = require('../utils/http-client');
const { dataLocal, horaLocal, diaDaSemanaLocal } = require('../utils/datas');

const COLUNAS_PADRAO = Object.freeze({ chave: 'CPF', beneficio: 'Beneficio', nome: 'Nome' });
const COLUNAS_ESTEIRA_PADRAO = Object.freeze({ chave: 'Codigo', beneficio: 'Beneficio', nome: 'Nome' });
const CACHE_ESTEIRA_MS = 30 * 60_000;
const ESPERA_APOS_FALHA_MS = 5 * 60_000;
const TENTATIVAS_POR_HORARIO = 3;

class BaseNaoGeradaError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'BaseNaoGeradaError';
  }
}

class BasesService {
  /**
   * @param {object} deps
   * @param {{ bases: object, modo: 'arquivos'|'argus', pastaSaida: string, fusoHorario: string, dryRun: boolean,
   *           diasSemana: number[], toleranciaMin: number, pausaEntreUploadsMs: number, codificacao: string }} deps.cfg
   * @param {{ baixar(cenarios: object[], opcoes: { hoje: string }): Promise<Record<string, string>> }} deps.esteira
   * @param {{ uploadMailing: Function, excluirMailing: Function }} deps.client
   * @param {{ carregar(): object, salvar(estado: object): Promise<void> }} deps.repositorio
   * @param {{ registrar(acao: string, dados: object): Promise<object> }} deps.auditoria
   * @param {{ notificar(aviso: object): Promise<void> }} deps.notificador
   * @param {object} deps.logger
   * @param {() => number} [deps.aleatorio]
   */
  constructor({ cfg, esteira, client, repositorio, auditoria, notificador, logger, aleatorio = Math.random }) {
    Object.assign(this, { cfg, esteira, client, repositorio, auditoria, notificador, log: logger, aleatorio });
    this.cacheEsteira = new Map();
  }

  /** Chamado a cada tique: roda cada base ligada no horário dela. */
  async tique(agora = new Date()) {
    const resultados = [];
    for (const [nome, base] of Object.entries(this.cfg.bases)) {
      if (!base.ativo) continue;
      const horario = this.horarioDaVez(nome, base, agora);
      if (horario) resultados.push(await this.executarAgendada(nome, horario, agora));
    }
    return resultados;
  }

  horarioDaVez(nome, base, agora) {
    const fuso = this.cfg.fusoHorario;
    const data = dataLocal(fuso, agora);
    const estado = this.estadoDa(nome);
    const horario = horarioPendente({
      horarios: horariosDoDia(base.agenda),
      hora: horaLocal(fuso, agora),
      data,
      diaSemana: diaDaSemanaLocal(fuso, agora),
      diasSemana: this.cfg.diasSemana,
      ultima: estado.ultima,
      toleranciaMin: this.cfg.toleranciaMin,
    });
    if (!horario) return null;
    const falha = estado.falha;
    const mesmaVez = falha?.data === data && falha.horario === horario;
    if (mesmaVez && (falha.tentativas >= TENTATIVAS_POR_HORARIO || agora - falha.em < ESPERA_APOS_FALHA_MS)) return null;
    return horario;
  }

  /** Execução agendada: registra sucesso/falha para não repetir nem insistir sem fim. */
  async executarAgendada(nome, horario, agora) {
    const data = dataLocal(this.cfg.fusoHorario, agora);
    try {
      const relatorio = await this.executar(nome, { horario, agora });
      await this.atualizarEstado(nome, { ultima: { data, horario }, falha: null });
      return relatorio;
    } catch (e) {
      await this.registrarFalha(nome, { data, horario, em: agora.getTime(), erro: e.message });
      return { base: nome, horario, erro: e.message };
    }
  }

  /** Conta as tentativas do mesmo horário (para parar depois de TENTATIVAS_POR_HORARIO). */
  registrarFalha(nome, falha) {
    const anterior = this.estadoDa(nome).falha;
    const mesmaVez = anterior?.data === falha.data && anterior.horario === falha.horario;
    return this.atualizarEstado(nome, { falha: { ...falha, tentativas: mesmaVez ? anterior.tentativas + 1 : 1 } });
  }

  /**
   * Gera (e, no modo argus, sobe) uma base agora.
   * @param {string} nome - chave em bases.json
   * @param {{ horario?: string, agora?: Date, modo?: string }} [opcoes]
   */
  async executar(nome, { horario, agora = new Date(), modo = this.cfg.modo } = {}) {
    const base = this.cfg.bases[nome];
    if (!base) throw new Error(`Base "${nome}" não existe em bases.json (há: ${Object.keys(this.cfg.bases).join(', ') || 'nenhuma'}).`);
    const data = dataLocal(this.cfg.fusoHorario, agora);
    const vez = horario || horaLocal(this.cfg.fusoHorario, agora);
    try {
      const { leads, resumo } = await this.montarLeads(nome, base, data);
      const partes = dividirIgual(embaralhar(leads, this.aleatorio), base.equipes.length, base.limitePorEquipe ?? Infinity);
      const equipes = await this.entregar({ nome, base, partes, data, horario: vez, modo });
      const relatorio = { base: nome, data, horario: vez, modo: this.modoEfetivo(modo), ...resumo, equipes };
      await this.auditoria.registrar('bases.gerada', relatorio);
      await this.notificarResultado(relatorio);
      return relatorio;
    } catch (e) {
      this.log.erro(`Base ${nome} (${vez}) não gerada: ${e.message}`);
      await this.auditoria.registrar('bases.falha', { base: nome, data, horario: vez, erro: e.message });
      await this.notificador.notificar({ titulo: `Base ${nome.toUpperCase()} não gerada`, texto: e.message, nivel: 'erro' });
      throw e;
    }
  }

  modoEfetivo(modo) {
    return modo === 'argus' && this.cfg.dryRun ? 'argus (DRY_RUN)' : modo;
  }

  /** Clientes da base, conforme o tipo. */
  async montarLeads(nome, base, data) {
    const esteiras = await this.lerEsteiras(base.cenarios, data);
    if (base.tipo === TipoBase.ESTEIRA) return this.leadsDaEsteira(base, esteiras);
    return this.leadsDaBaseMestra(nome, base, esteiras);
  }

  leadsDaEsteira(base, esteiras) {
    const colunas = { ...COLUNAS_ESTEIRA_PADRAO, ...base.esteira?.colunas };
    const todos = base.cenarios.flatMap((c) => leadsDaEsteira(esteiras[c.nome], { colunas, status: c.status }));
    const leads = removerDaBase(todos, new Set());
    if (!leads.length) throw new BaseNaoGeradaError('Nenhum cliente na esteira com os status desta base.');
    return { leads, resumo: { naEsteira: leads.length } };
  }

  async leadsDaBaseMestra(nome, base, esteiras) {
    const colunaChave = base.esteira?.colunaChave || COLUNAS_ESTEIRA_PADRAO.chave;
    const remover = new Set();
    for (const c of base.cenarios) {
      for (const chave of chavesDaEsteira(esteiras[c.nome], { colunaChave, status: c.status })) remover.add(chave);
    }
    if (!remover.size && base.exigirRemocao !== false) {
      throw new BaseNaoGeradaError(`A esteira não trouxe nenhum cliente para remover (coluna "${colunaChave}"). Base não gerada por segurança.`);
    }
    const { arquivo, aba, colunas } = base.baseMestra;
    const mestra = paraLeads(await lerTabela(arquivo, { aba }), { ...COLUNAS_PADRAO, ...colunas });
    if (!mestra.length) throw new BaseNaoGeradaError(`Base mestra vazia: ${arquivo}${aba ? ` (aba ${aba})` : ''}.`);
    const leads = removerDaBase(mestra, remover);
    if (!leads.length) throw new BaseNaoGeradaError('Depois da remoção não sobrou nenhum cliente.');
    this.log.info(`Base ${nome}: mestra ${mestra.length}, a remover ${remover.size}, ficam ${leads.length}.`);
    return { leads, resumo: { baseMestra: mestra.length, paraRemover: remover.size, removidos: mestra.length - leads.length } };
  }

  /** Baixa (ou reaproveita, se baixada há pouco) a esteira de cada cenário e lê as linhas. */
  async lerEsteiras(cenarios, hoje) {
    const faltando = cenarios.filter((c) => !this.esteiraEmCache(c, hoje));
    if (faltando.length) {
      const arquivos = await this.esteira.baixar(faltando, { hoje });
      for (const c of faltando) this.cacheEsteira.set(chaveCache(c, hoje), { arquivo: arquivos[c.nome], em: Date.now() });
    }
    const linhas = {};
    for (const c of cenarios) linhas[c.nome] = await lerTabela(this.cacheEsteira.get(chaveCache(c, hoje)).arquivo);
    return linhas;
  }

  esteiraEmCache(cenario, hoje) {
    const item = this.cacheEsteira.get(chaveCache(cenario, hoje));
    return Boolean(item) && Date.now() - item.em < CACHE_ESTEIRA_MS;
  }

  /** Grava os CSVs e, no modo argus, sobe um por vez. */
  async entregar({ nome, base, partes, data, horario, modo }) {
    const pasta = path.join(this.cfg.pastaSaida, nome.toUpperCase(), data);
    fs.mkdirSync(pasta, { recursive: true });
    const resultados = [];
    for (const [i, equipe] of base.equipes.entries()) {
      const arquivo = path.join(pasta, nomeDoArquivo({ base: nome, equipe: equipe.nome, data, horario }));
      const conteudo = Buffer.from(montarCsvMailing(partes[i]), this.cfg.codificacao);
      fs.writeFileSync(arquivo, conteudo);
      const item = { equipe: equipe.nome, clientes: partes[i].length, arquivo };
      const subir = modo === 'argus' && partes[i].length > 0; // equipe sem clientes: não sobe arquivo vazio
      resultados.push(subir ? { ...item, ...(await this.subir(equipe, arquivo, conteudo, i > 0)) } : item);
    }
    return resultados;
  }

  /** Sobe o mailing novo e, só depois de aceito, exclui o anterior da mesma skill. */
  async subir(equipe, arquivo, conteudo, aguardarAntes) {
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Subiria ${path.basename(arquivo)} na skill de ${equipe.nome}.`);
      return { simulado: true };
    }
    if (aguardarAntes) await esperar(this.cfg.pausaEntreUploadsMs);
    try {
      const { idArquivo } = await this.client.uploadMailing(equipe.skillHash, { nomeArquivo: path.basename(arquivo), conteudo });
      const anterior = this.repositorio.carregar().mailings?.[equipe.skillHash];
      await this.registrarMailing(equipe.skillHash, idArquivo);
      return { idArquivo, ...(await this.excluirAnterior(equipe, anterior)) };
    } catch (e) {
      this.log.erro(`Falha ao subir a base de ${equipe.nome}: ${e.message}`);
      return { erro: e.message };
    }
  }

  async excluirAnterior(equipe, anterior) {
    if (!anterior) return {};
    try {
      await this.client.excluirMailing(equipe.skillHash, anterior);
      return { anteriorExcluido: anterior };
    } catch (e) {
      this.log.aviso(`Mailing anterior (${anterior}) de ${equipe.nome} não foi excluído: ${e.message}`);
      return { anteriorNaoExcluido: anterior, erroExclusao: e.message };
    }
  }

  registrarMailing(skillHash, idArquivo) {
    const estado = this.repositorio.carregar();
    return this.repositorio.salvar({ ...estado, mailings: { ...estado.mailings, [skillHash]: idArquivo } });
  }

  estadoDa(nome) {
    return this.repositorio.carregar().bases?.[nome] || {};
  }

  atualizarEstado(nome, mudancas) {
    const estado = this.repositorio.carregar();
    const bases = { ...estado.bases, [nome]: { ...estado.bases?.[nome], ...mudancas } };
    return this.repositorio.salvar({ ...estado, bases });
  }

  notificarResultado(r) {
    const falhas = r.equipes.filter((e) => e.erro);
    const porEquipe = r.equipes.map((e) => `${e.equipe} ${e.clientes}${e.erro ? ' (FALHOU)' : ''}`).join(', ');
    const origem = r.baseMestra ? `mestra ${r.baseMestra}, removidos ${r.removidos}` : `${r.naEsteira} na esteira`;
    const destino = r.modo === 'arquivos' ? 'CSVs gerados na pasta' : `subida na Argus: ${r.modo}`;
    return this.notificador.notificar({
      titulo: `Base ${r.base.toUpperCase()} ${r.horario}`,
      texto: `${origem}. Por equipe: ${porEquipe}. ${destino}.`,
      nivel: falhas.length ? 'erro' : 'info',
      dados: r,
    });
  }
}

const chaveCache = (cenario, hoje) => `${hoje}|${JSON.stringify([cenario.tipoData, cenario.diasAtras ?? null, cenario.etapas || []])}`;

/** Fonte de esteira a partir de arquivo(s) já exportado(s) — para testar sem o robô. */
class EsteiraDeArquivo {
  constructor(arquivo) {
    this.arquivo = arquivo;
  }

  async baixar(cenarios) {
    return Object.fromEntries(cenarios.map((c) => [c.nome, this.arquivo]));
  }
}

module.exports = { BasesService, BaseNaoGeradaError, EsteiraDeArquivo };

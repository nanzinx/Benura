'use strict';
/**
 * [NOVO] Rodízio de pessoas (benura-rodizio) e robôs (benura-robos) em dois serviços.
 *
 * O de pessoas lê a URA na Argus (como sempre) e, a cada ciclo e na hora de cada webhook de
 * atendimento, manda ao de robôs o retrato dela (POST /interno/ura). O de robôs responde com o
 * que fez (robôs ligados, pânico) e, nos dois sentidos, vão os eventos que o outro precisa:
 *   pessoas → robôs: derivações (a taxa) e callbacks do webhook (o ajuste);
 *   robôs → pessoas: pânico, encerramentos e callbacks do relatório de ligações (relatório do dia e termômetro).
 * Cada evento tem número: quem recebe ignora o repetido, e quem manda só tira da fila o confirmado.
 * Assim as consultas à Argus não aumentam: cada um só lê o que é dele.
 */

const crypto = require('crypto');

/** Mais que isso na fila (o outro lado fora do ar por muito tempo): ficam os mais novos. */
const LIMITE_DA_FILA = 5000;

/** Eventos a mandar ao outro serviço, numerados; saem só quando o outro confirma. */
class FilaDeEventos {
  constructor() {
    this.instancia = crypto.randomUUID();
    this.seq = 0;
    this.itens = [];
  }

  por(evento) {
    this.seq += 1;
    this.itens.push({ seq: this.seq, ...evento });
    if (this.itens.length > LIMITE_DA_FILA) this.itens.splice(0, this.itens.length - LIMITE_DA_FILA);
  }

  pendentes() {
    return { instancia: this.instancia, eventos: this.itens };
  }

  /** @param {{ instancia: string, seq: number }|null} ack - o último que o outro lado aplicou */
  confirmar(ack) {
    if (ack?.instancia !== this.instancia) return;
    this.itens = this.itens.filter((e) => e.seq > ack.seq);
  }
}

/** Eventos que chegaram do outro serviço: só os novos (o outro reiniciou = começa de novo). */
class EventosRecebidos {
  constructor() {
    this.instancia = null;
    this.ultimo = 0;
  }

  novos({ instancia, eventos } = {}) {
    if (!instancia || !Array.isArray(eventos)) return [];
    if (instancia !== this.instancia) {
      this.instancia = instancia;
      this.ultimo = 0;
    }
    const novos = eventos.filter((e) => Number(e?.seq) > this.ultimo);
    if (novos.length) this.ultimo = Number(novos.at(-1).seq);
    return novos;
  }

  ack() {
    return this.instancia ? { instancia: this.instancia, seq: this.ultimo } : null;
  }
}

/**
 * No de pessoas, os robôs são um espelho do que o de robôs respondeu: o relatório, os indicadores
 * e o /health continuam lendo "robôs ligados", e nenhum comando chega à Argus por aqui.
 */
class EspelhoRobos {
  constructor() {
    /** @type {Set<string>|null} */
    this.ligados = null;
    this.alvo = null;
    this.mudancasPorFora = 0;
    this.modoAtual = () => null;
  }

  atualizar({ ligadosRamais, alvo, mudancasPorFora } = {}) {
    this.ligados = Array.isArray(ligadosRamais) ? new Set(ligadosRamais.map(String)) : this.ligados;
    if (alvo !== undefined) this.alvo = alvo;
    this.mudancasPorFora = mudancasPorFora ?? this.mudancasPorFora;
  }

  situacao(total) {
    return { ligados: this.ligados ? this.ligados.size : null, total, ultimaReducao: 0, ultimoAumento: 0 };
  }

  resumo() {
    return { ligados: this.ligados ? this.ligados.size : null, alvo: this.alvo, mudancasPorFora: this.mudancasPorFora };
  }

  emOrdem(ramais) { return ramais; }

  async sincronizar() {}

  async reduzir() {}

  async aumentar() {}

  async desligar() {}

  async encerrarSemDerrubar() {}

  async reduzirPoupando() {}
}

/** O que os robôs usam do status de cada um (nada do cliente). */
function statusParaOsRobos(s) {
  const d = s.detalhe;
  return {
    classe: s.classe,
    ts: s.ts,
    livreDesde: s.livreDesde ?? null,
    emCarencia: Boolean(s.emCarencia),
    detalhe: d ? { grupo: d.grupo ?? null, origem: d.origem ?? null, nome: d.nome ?? null, statusDesde: d.statusDesde ?? null } : null,
  };
}

/**
 * O retrato da URA que o de pessoas manda. `saiEm`: quando a regra do ocioso devolve cada um
 * (só quem vai sair; fixo, travado, em atendimento e em transferência ficam de fora).
 * @param {import('./rodizio.service').RodizioService} svc
 */
function montarRetrato(svc, agora) {
  const ramais = [...svc.ramaisUra];
  return {
    ts: agora,
    ramaisUra: ramais,
    ramaisRobos: [...svc.ramaisRobos].map(String),
    permanentes: [...svc.permanentes].map(String),
    status: ramais.filter((r) => svc.statusUra.has(r)).map((r) => [r, statusParaOsRobos(svc.statusUra.get(r))]),
    saiEm: Object.fromEntries(ramais.map((r) => [r, svc.saidaPrevista(r, agora)]).filter(([, t]) => t != null)),
    limiteBaseMs: svc.limiteOciosoBaseMs(),
    statusUra: svc.statusAtualDaUra() ?? null,
    passiva: Boolean(svc.uraPassivaAgora()),
    uraCheia: Boolean(svc.emUraCheia(agora)),
    ultimoWebhookEm: svc.ultimoWebhookEm || 0,
    desligandoAutomacao: Boolean(svc.desligandoAutomacao),
  };
}

/** O de robôs passa a ver a URA pelo retrato. */
function aplicarRetrato(svc, retrato, recebidoEm) {
  if (!retrato || !Array.isArray(retrato.ramaisUra)) return;
  svc.retrato = retrato;
  svc.retratoRecebidoEm = recebidoEm;
  svc.ramaisUra = new Set(retrato.ramaisUra.map(String));
  if (Array.isArray(retrato.ramaisRobos) && retrato.ramaisRobos.length) svc.ramaisRobos = retrato.ramaisRobos.map(String);
  svc.permanentes = new Set((retrato.permanentes ?? []).map(String));
  svc.statusUra = new Map((retrato.status ?? []).map(([r, s]) => [String(r), s]));
  svc.saidas = new Map(Object.entries(retrato.saiEm ?? {}).map(([r, t]) => [String(r), Number(t)]));
  svc.ultimoWebhookEm = Math.max(svc.ultimoWebhookEm || 0, retrato.ultimoWebhookEm || 0);
  svc.desligandoAutomacao = Boolean(svc.desligandoPorPedido) || Boolean(retrato.desligandoAutomacao);
}

/** Do resumo dos robôs, o que o /health do de pessoas (e a tela) mostra. */
const CAMPOS_DO_RESUMO = ['robos', 'panico', 'ajusteRobos', 'ultimoLivreSaindo'];
function resumoParaPessoas(svc) {
  // Um erro aqui não pode derrubar a conversa (o de pessoas pararia os robôs achando que este caiu).
  try {
    const r = svc.resumoDosRobos();
    return Object.fromEntries(CAMPOS_DO_RESUMO.map((c) => [c, r[c]]));
  } catch (e) {
    svc.log?.debug?.(`Resumo dos robôs indisponível: ${e.message}`);
    return null;
  }
}

/** O que o de robôs responde: o que fez, os eventos dele e a confirmação dos recebidos. */
function montarResposta(svc) {
  return {
    robos: { ligadosRamais: svc.robos.ligados ? [...svc.robos.ligados].map(String) : null, alvo: svc.robos.alvo ?? null, mudancasPorFora: svc.robos.mudancasPorFora ?? 0 },
    panico: { tipo: svc.panicoTipo, motivo: svc.panicoMotivo, desde: svc.panicoDesde },
    livres: svc.ultimosLivres,
    ultimoSaindo: svc.ultimoSaindo,
    // o relatório do de pessoas marca as horas em que os robôs não seguiam a configuração
    modo: svc.modoDosRobos(),
    fonte: svc.calculoDosRobos()?.fonte ?? null,
    // o /health do de pessoas mostra os robôs como o de robôs os vê (o painel junta o mesmo)
    resumo: resumoParaPessoas(svc),
    ...svc.filaParaOutroLado.pendentes(),
    ack: svc.recebidosDoOutroLado.ack(),
  };
}

/** O de pessoas aplica a resposta: o espelho dos robôs, o pânico e os eventos novos. */
function aplicarResposta(svc, r) {
  if (!r || typeof r !== 'object') return;
  svc.robos.atualizar?.(r.robos ?? {});
  if (r.panico) {
    svc.panicoTipo = r.panico.tipo ?? null;
    svc.panicoMotivo = r.panico.motivo ?? null;
    svc.panicoDesde = r.panico.desde ?? null;
  }
  if (Number.isFinite(r.livres)) svc.ultimosLivres = r.livres;
  if (r.ultimoSaindo !== undefined) svc.ultimoSaindo = r.ultimoSaindo;
  if (r.modo) svc.estadoDosRobos = { modo: r.modo, fonte: r.fonte ?? null };
  if (r.resumo && typeof r.resumo === 'object') svc.resumoDosRobosRemoto = r.resumo;
  svc.filaParaOutroLado.confirmar(r.ack);
  for (const e of svc.recebidosDoOutroLado.novos(r)) svc.comCuidado(() => svc.aplicarEventoDosRobos(e), e);
}

/**
 * No de robôs, o relatório do dia e o termômetro ficam no de pessoas: o que eles receberiam
 * vira evento na fila (pânico, encerramento do relatório de ligações, callback do relatório).
 */
function estatisticasRemotas(fila) {
  return {
    registrarPanico: (tipo, ts) => fila.por({ tipo: 'panico', panico: tipo, ts }),
    registrarEncerramento: (ts, encerramento) => {
      fila.por({ tipo: 'encerramento', ts, encerramento });
      return true;
    },
    registrarDerivacao() {},
    amostrar() {},
    carregar() {},
    gravar() {},
    resumo: () => null,
  };
}

function termometroRemoto(fila) {
  return {
    registrarCallback: (ts) => fila.por({ tipo: 'callback', ts }),
    registrarDerivacao() {},
    amostrar: () => null,
    resumo: () => null,
    calma: () => false,
    estado: null,
  };
}

module.exports = {
  FilaDeEventos, EventosRecebidos, EspelhoRobos, montarRetrato, aplicarRetrato, montarResposta, aplicarResposta, estatisticasRemotas, termometroRemoto,
};

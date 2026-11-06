'use strict';
/**
 * Relatório do dia da URA (painel): quanto tempo houve gente livre, quantas
 * derivações, quanto tempo com gente livre e nenhum robô ligado (a ociosidade
 * que o pânico causa), tempo em pânico e em cada estado do termômetro, leads
 * derivados e transbordos (webhooks 4 e 5 da Argus e [NOVO] o relatório de ligações) e pausas por tipo. Tudo
 * também por hora. [NOVO] E por atendente (aba Receptivo): tempo livre, em
 * atendimento, em outro status e em cada pausa, atendimentos, pausas estouradas,
 * maior espera livre e quando foi visto na URA. Conta só o tempo no grupo da URA
 * (o rodízio só lê o status de quem está nela). Gravado em arquivo: um reinício no
 * mesmo dia continua; na virada do dia começa do zero.
 * [NOVO] Na virada (ou ao subir no dia seguinte), os totais do dia vão para o histórico:
 * o painel compara hoje com o dia anterior e com a média dos últimos 7 dias.
 */

const { dataLocal, horaLocal } = require('../utils/datas');
const { sugestoes } = require('../domain/sugestoes');
const { limitesMin: LIMITES_PAUSA } = require('../config/pausas');
const { anotar, somarMapas, chave: chaveDoMapa } = require('../domain/mapa-risco');

/** Entre dois ciclos, no máximo isto conta (o rodízio pode ter ficado parado). */
const MAX_INTERVALO_MS = 30_000;
/** [NOVO] Mapa de risco: fotos da URA guardadas (em memória) para achar a situação de quando o cliente entrou. */
const FOTOS_POR_MS = 15 * 60_000;
/** Foto mais velha que isto antes do momento não vale (o rodízio ficou parado). */
const FOTO_VALE_MS = 2 * 60_000;
const TIPOS_PANICO = ['zero', 'saindo', 'fixo'];
const ESTADOS_TERMOMETRO = ['medindo', 'calma', 'normal', 'agressiva'];
/** [NOVO] Transbordo é o "Gerou Callback" da Argus: o "sem agente" vem do discador (0 s) e não conta. */
const FORA_DOS_TRANSBORDOS = ['sem agente'];

const zerados = (chaves) => Object.fromEntries(chaves.map((k) => [k, 0]));
const hora = () => ({
  livresMs: 0, derivacoes: 0, esperaSomaMs: 0, esperaQtd: 0, ociosoSemRobosMs: 0, panicoMs: 0, calmaMs: 0, agressivaMs: 0, normalMs: 0, medindoMs: 0,
  // [NOVO] robôs ligados × tempo e o tempo medido: a média de robôs do dia (histórico)
  robosMs: 0, medidoMs: 0, leadsDerivados: 0, transbordos: 0,
});
const diaNovo = (dia) => ({
  dia,
  livresMs: 0,
  derivacoes: 0,
  // [NOVO] TME: tempo livre de cada operador antes de cada ligação (soma e quantidade)
  esperaSomaMs: 0,
  esperaQtd: 0,
  ociosoSemRobosMs: 0,
  panicoMs: zerados(TIPOS_PANICO),
  panicoVezes: zerados(TIPOS_PANICO),
  termometroMs: zerados(ESTADOS_TERMOMETRO),
  // [NOVO] ligações da URA: para um humano (lead derivado) ou não (transbordo, por motivo)
  leadsDerivados: 0,
  transbordos: 0,
  transbordosPorMotivo: {},
  filaSegSoma: 0,
  filaQtd: 0,
  // [NOVO] ligações já contadas hoje (idLigacao): o webhook e o relatório não contam em dobro,
  // nem um reinício que relê o dia desde 00:00. E a última, com a fonte.
  contadas: [],
  ultimoEncerramento: null,
  // [NOVO] mapa de risco dos robôs ("livres|robôs|status" → leads, callbacks de fila e invisíveis), domain/mapa-risco.js
  mapaRisco: {},
  semFotoNoMapa: 0,
  // [NOVO] callback do dia → célula e tipo no mapa (o raio-x pode corrigir o tipo depois)
  callbacksNoMapa: {},
  // [NOVO] tempo em pausa dos humanos da URA, por tipo (descricaoPausa da Argus)
  pausasMs: {},
  // [NOVO] por atendente (ramal → acumulados), veja atendente()
  porRamal: {},
  horas: {},
});

const atendente = () => ({
  nome: null, primeiroEm: null, ultimoEm: null, livreMs: 0, atendimentoMs: 0, outroMs: 0, pausasMs: {},
  atendimentos: 0, pausasEstouradas: 0, maiorEsperaMs: 0, pausaContada: null,
});

const minutos = (ms) => Math.round(ms / 6_000) / 10;
const DIAS_NO_HISTORICO = 120;
const DIAS_NA_SEMANA = 7;
const DIA_MS = 86_400_000;
const minutosDoDia = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const semAcento = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Limite da pausa em minutos (o nome começa com a chave de config/pausas.js), ou null. */
function limiteDaPausaMin(tipo, limites = LIMITES_PAUSA) {
  const t = semAcento(tipo || '');
  const chave = Object.keys(limites).find((k) => t.startsWith(semAcento(k)));
  return chave ? limites[chave] : null;
}

/** [NOVO] Totais de uma lista de dias do histórico: somas, TME e OPL pelas somas, TOR e TPA por dia. */
function totaisDoPeriodo(dias) {
  const somar = (lista, campo) => Math.round(lista.reduce((t, d) => t + (d[campo] ?? 0), 0) * 10) / 10;
  const total = (campo) => somar(dias, campo);
  // as médias por dia usam só os dias completos: hoje, ainda parcial, puxaria para baixo (só hoje: ele mesmo)
  const completos = dias.filter((d) => !d.hoje);
  const base = completos.length ? completos : dias;
  const porDia = (campo) => (base.length ? Math.round((somar(base, campo) / base.length) * 10) / 10 : 0);
  const derivacoes = total('derivacoes');
  const esperaQtd = total('esperaQtd');
  return {
    dias: dias.length,
    diasCompletos: completos.length,
    transbordos: total('transbordos'),
    leadsDerivados: total('leadsDerivados'),
    derivacoes,
    livresMin: total('livresMin'),
    torMin: total('torMin'),
    tpaMin: total('tpaMin'),
    torMinDia: porDia('torMin'),
    tpaMinDia: porDia('tpaMin'),
    transbordosDia: porDia('transbordos'),
    leadsDia: porDia('leadsDerivados'),
    calmaMin: total('calmaMin'),
    normalMin: total('normalMin'),
    agressivaMin: total('agressivaMin'),
    medindoMin: total('medindoMin'),
    tmeSeg: esperaQtd ? Math.round(total('esperaSomaSeg') / esperaQtd) : null,
    oplSeg: derivacoes ? Math.round((total('livresMin') * 60) / derivacoes) : null,
  };
}

/** [NOVO] Soma por atendente dos dias que guardaram o resumo (dias antigos não têm). */
function somaPorAtendente(dias) {
  const por = new Map();
  for (const d of dias) {
    for (const a of d.porAtendente ?? []) {
      const s = por.get(a.ramal) ?? { ramal: a.ramal, nome: null, dias: 0, atendimentos: 0, livreMin: 0, atendimentoMin: 0, pausaMin: 0 };
      s.nome = a.nome ?? s.nome;
      s.dias += 1;
      for (const k of ['atendimentos', 'livreMin', 'atendimentoMin', 'pausaMin']) s[k] = Math.round((s[k] + (a[k] ?? 0)) * 10) / 10;
      por.set(a.ramal, s);
    }
  }
  return [...por.values()].sort((x, y) => String(x.nome ?? x.ramal).localeCompare(String(y.nome ?? y.ramal), 'pt-BR'));
}

class EstatisticasDia {
  /**
   * @param {object} deps
   * @param {import('../utils/persistencia-json').ArquivoDeEstado} [deps.repositorio]
   * @param {string} deps.fusoHorario
   * @param {number} [deps.gravarACadaMs]
   * @param {{ inicio: string, fim: string }|null} [deps.expediente] - [NOVO] HH:MM: fora dele, o tempo não
   *        conta e o relatório não mostra a hora (sem ele, o dia todo)
   * @param {import('../utils/persistencia-json').ArquivoDeEstado} [deps.historico] - [NOVO] totais dos dias que passaram
   */
  constructor({ repositorio = null, fusoHorario, gravarACadaMs = 60_000, expediente = null, historico = null, fotoDaConfig = null }) {
    const valido = expediente?.inicio && expediente?.fim ? expediente : null;
    Object.assign(this, { repositorio, fusoHorario, gravarACadaMs, expediente: valido, historico });
    /** [NOVO] A configuração dos robôs e da URA (do .env), guardada em cada dia do histórico para as sugestões. */
    this.fotoDaConfig = fotoDaConfig;
    this.estado = diaNovo(dataLocal(fusoHorario));
    this.ultimaAmostraEm = null;
    this.gravadoEm = 0;
    /** Ligações já contadas hoje (a Argus pode reenviar o mesmo webhook). Espelho de estado.contadas. */
    this.contadas = new Set();
    /** [NOVO] As fotos da URA dos últimos 15 min ({ ts, livres, robos, status }), para o mapa de risco. */
    this.fotos = [];
    /** [NOVO] correções do raio-x que chegaram antes do encerramento (chave → invisível?) */
    this.correcoes = new Map();
  }

  /**
   * [NOVO] Havia gente livre durante toda a espera (de `inicio` a `fim`)? A foto de antes do início
   * e todas até o fim; null sem foto do início.
   */
  livresAEsperaToda(inicio, fim) {
    if (!this.fotoEm(inicio)) return null;
    let i = this.fotos.length - 1;
    while (i > 0 && this.fotos[i].ts > inicio) i--; // a última foto até o início
    for (; i < this.fotos.length && this.fotos[i].ts <= fim; i++) if (!(this.fotos[i].livres > 0)) return false;
    return true;
  }

  /** [NOVO] A foto mais recente até `instante` (null se não houver uma recente). */
  fotoEm(instante) {
    for (let i = this.fotos.length - 1; i >= 0; i--) {
      const f = this.fotos[i];
      if (f.ts <= instante) return instante - f.ts <= FOTO_VALE_MS ? f : null;
    }
    return null;
  }

  carregar(agora = Date.now()) {
    const salvo = this.repositorio?.carregar();
    if (salvo?.dia === dataLocal(this.fusoHorario, new Date(agora))) this.estado = { ...diaNovo(salvo.dia), ...salvo };
    else if (salvo?.dia) this.arquivar({ ...diaNovo(salvo.dia), ...salvo }); // parado à noite: o dia de ontem vai para o histórico
    this.contadas = new Set(Array.isArray(this.estado.contadas) ? this.estado.contadas : []);
    // O que já tinha sido contado hoje como "sem agente" sai do total (as barras por hora ficam como estavam).
    const e = this.estado;
    for (const motivo of FORA_DOS_TRANSBORDOS) {
      e.transbordos = Math.max(0, e.transbordos - (e.transbordosPorMotivo?.[motivo] ?? 0));
      delete e.transbordosPorMotivo?.[motivo];
    }
    return this;
  }

  /** Começa o dia novo se virou. @returns {object} as horas do dia, para acumular */
  doDia(agora) {
    this.virarDia(agora);
    return this.daHora(agora);
  }

  virarDia(agora) {
    const dia = dataLocal(this.fusoHorario, new Date(agora));
    if (dia === this.estado.dia) return;
    this.arquivar(this.estado);
    this.estado = diaNovo(dia);
    this.ultimaAmostraEm = null;
    this.contadas = new Set();
  }

  daHora(instante) {
    const h = horaLocal(this.fusoHorario, new Date(instante)).slice(0, 2);
    this.estado.horas[h] ??= hora();
    return this.estado.horas[h];
  }

  /**
   * Um ciclo da URA.
   * @param {number} agora
   * @param {{ livres: number|null, robosLigados: number|null, panico: string|null, termometro: string|null, pausas?: string[],
   *          operadores?: Array<{ ramal: string, nome?: string|null, classe: string|null, pausa?: string|null,
   *                               statusDesde?: number|null, livreDesde?: number|null }> }} s
   *        pausas: o tipo da pausa de cada humano da URA em pausa agora;
   *        operadores: [NOVO] cada humano da URA agora (para o relatório por atendente)
   */
  /**
   * [NOVO] Quanto do intervalo até `agora` cai no expediente: fora dele, 0; logo depois do início,
   * só desde o início (a noite não entra na primeira amostra). Sem expediente, Infinity.
   */
  noExpediente(agora) {
    if (!this.expediente) return Infinity;
    const min = minutosDoDia(horaLocal(this.fusoHorario, new Date(agora)));
    const inicio = minutosDoDia(this.expediente.inicio);
    if (min < inicio || min >= minutosDoDia(this.expediente.fim)) return 0;
    return (min - inicio) * 60_000 + (agora % 60_000);
  }

  /** [NOVO] A hora ("08") está no expediente? (o relatório só mostra essas) */
  horaNoExpediente(hora) {
    if (!this.expediente) return true;
    const min = Number(hora) * 60;
    return min + 59 >= minutosDoDia(this.expediente.inicio) && min < minutosDoDia(this.expediente.fim);
  }

  /**
   * @param {object} amostra
   * @param {boolean} [amostra.naConfig] - [NOVO] os robôs seguem a configuração (modo automático, sem
   *        robôs por livre escolhido à mão): a hora fora dela não entra nas sugestões
   */
  amostrar(agora, { livres, robosLigados, panico, termometro, pausas = [], operadores = [], naConfig = true }) {
    const h = this.doDia(agora); // virou o dia: zera, e o intervalo até a última amostra não conta
    this.fotos.push({ ts: agora, livres: livres ?? 0, robos: Number.isFinite(robosLigados) ? robosLigados : null, status: termometro ?? null });
    while (this.fotos.length && agora - this.fotos[0].ts > FOTOS_POR_MS) this.fotos.shift();
    const dt = this.ultimaAmostraEm == null ? 0 : Math.min(Math.max(agora - this.ultimaAmostraEm, 0), MAX_INTERVALO_MS, this.noExpediente(agora));
    this.ultimaAmostraEm = agora;
    if (dt > 0) {
      const e = this.estado;
      const comLivres = livres > 0;
      e.livresMs += dt * (livres || 0);
      h.livresMs += dt * (livres || 0);
      if (comLivres && robosLigados === 0) {
        e.ociosoSemRobosMs += dt;
        h.ociosoSemRobosMs += dt;
      }
      if (panico && panico in e.panicoMs) {
        e.panicoMs[panico] += dt;
        h.panicoMs += dt;
      }
      if (termometro && termometro in e.termometroMs) e.termometroMs[termometro] += dt;
      if (termometro === 'calma') h.calmaMs += dt;
      if (termometro === 'agressiva') h.agressivaMs += dt;
      // [NOVO] para a barra do status hora a hora (estado gravado por versão antiga não tem os campos)
      if (termometro === 'normal') h.normalMs = (h.normalMs ?? 0) + dt;
      if (termometro === 'medindo') h.medindoMs = (h.medindoMs ?? 0) + dt;
      if (Number.isFinite(robosLigados)) {
        h.robosMs = (h.robosMs ?? 0) + dt * robosLigados;
        h.medidoMs = (h.medidoMs ?? 0) + dt;
      }
      if (!naConfig) h.foraDaConfigMs = (h.foraDaConfigMs ?? 0) + dt;
      this.guardarConfig(e);
      for (const tipo of pausas) e.pausasMs[tipo] = (e.pausasMs[tipo] ?? 0) + dt;
    }
    for (const op of operadores) this.amostrarAtendente(agora, dt, op);
    if (agora - this.gravadoEm >= this.gravarACadaMs) this.gravar(agora);
  }

  /** [NOVO] Um humano da URA neste ciclo: soma o intervalo no status em que ele está. */
  amostrarAtendente(agora, dt, { ramal, nome = null, classe, pausa = null, statusDesde = null, livreDesde = null }) {
    if (!ramal || !classe || classe === 'offline' || classe === 'erro') return;
    const a = this.atendenteDe(ramal);
    if (nome) a.nome = nome;
    const iso = new Date(agora).toISOString();
    a.primeiroEm ??= iso;
    a.ultimoEm = iso;
    if (classe === 'livre') {
      a.livreMs += dt;
      if (livreDesde != null) a.maiorEsperaMs = Math.max(a.maiorEsperaMs, agora - livreDesde);
    } else if (classe === 'atendimento') a.atendimentoMs += dt;
    else if (pausa) {
      a.pausasMs[pausa] = (a.pausasMs[pausa] ?? 0) + dt;
      this.conferirPausaEstourada(a, agora, pausa, statusDesde);
    } else a.outroMs += dt;
  }

  /** Conta uma vez por pausa (tipo + início) quando ela passa do limite. */
  conferirPausaEstourada(a, agora, pausa, statusDesde) {
    const limite = limiteDaPausaMin(pausa);
    if (limite == null || statusDesde == null || agora - statusDesde <= limite * 60_000) return;
    const chave = `${pausa}|${statusDesde}`;
    if (a.pausaContada === chave) return;
    a.pausaContada = chave;
    a.pausasEstouradas += 1;
  }

  atendenteDe(ramal) {
    this.estado.porRamal ??= {};
    this.estado.porRamal[ramal] ??= atendente();
    return this.estado.porRamal[ramal];
  }

  /**
   * @param {string} [ramal] - [NOVO] quem atendeu (relatório por atendente)
   * @param {number|null} [esperaMs] - [NOVO] há quanto tempo estava livre (o "Tempo" da Argus): entra no TME
   */
  registrarDerivacao(agora, ramal = null, esperaMs = null) {
    const h = this.doDia(agora);
    h.derivacoes += 1;
    this.estado.derivacoes += 1;
    if (Number.isFinite(esperaMs) && esperaMs >= 0) {
      for (const alvo of [h, this.estado]) {
        alvo.esperaSomaMs = (alvo.esperaSomaMs ?? 0) + esperaMs;
        alvo.esperaQtd = (alvo.esperaQtd ?? 0) + 1;
      }
    }
    if (ramal) this.atendenteDe(String(ramal)).atendimentos += 1;
  }

  /**
   * [NOVO] Uma ligação da URA terminou (webhook 4 ou 5, ou o relatório de ligações): lead
   * derivado ou transbordo (o "Gerou Callback" da Argus: abandonou a fila ou time-out na fila).
   * @param {{ chave: string|null, derivou: boolean, motivo: string, filaSeg: number|null, quando?: number|null, fim?: number|null }} encerramento
   *        quando: a hora da ligação (relatório), para a barra da hora certa; sem ela, agora
   *        fim: [NOVO] quando a ligação terminou (relatório: início + duração); sem ele, agora
   * @param {'webhook'|'relatório'} [fonte]
   * @returns {boolean} false se já tinha sido contada (ou é de outro dia)
   */
  registrarEncerramento(agora, { chave, derivou, motivo, filaSeg, quando = null, fim = null }, fonte = 'webhook') {
    this.virarDia(agora);
    const instante = quando ?? agora;
    if (dataLocal(this.fusoHorario, new Date(instante)) !== this.estado.dia) return false;
    if (!derivou && FORA_DOS_TRANSBORDOS.includes(motivo)) return false;
    if (chave && this.contadas.has(chave)) return false;
    const h = this.daHora(instante);
    const e = this.estado;
    if (chave) {
      this.contadas.add(chave);
      (e.contadas ??= []).push(chave);
    }
    if (!e.ultimoEncerramento || instante >= Date.parse(e.ultimoEncerramento.em)) e.ultimoEncerramento = { em: new Date(instante).toISOString(), fonte };
    this.gravadoEm = 0; // grava no próximo ciclo (um reinício não conta de novo)
    if (derivou) {
      e.leadsDerivados += 1;
      h.leadsDerivados += 1;
    } else {
      e.transbordos += 1;
      h.transbordos += 1;
      e.transbordosPorMotivo[motivo] = (e.transbordosPorMotivo[motivo] ?? 0) + 1;
    }
    if (filaSeg != null) {
      e.filaSegSoma += filaSeg;
      e.filaQtd += 1;
    }
    // [NOVO] mapa de risco: a célula é a situação de quando o cliente entrou (o relatório traz o início; o
    // webhook, o fim). O callback só é invisível se havia gente livre a espera toda: a URA calma segura
    // livres, então na entrada quase sempre há alguém, e os livres podem ir a 0 antes do time-out.
    const entrou = quando ?? agora - (filaSeg ?? 0) * 1000;
    // O raio-x do callback (a ligação inteira) manda no tipo: se a correção dele já chegou, vale ela.
    const corrigido = !derivou && chave && this.correcoes.has(chave) ? this.correcoes.get(chave) : undefined;
    if (corrigido !== undefined) this.correcoes.delete(chave);
    const invisivel = derivou ? undefined : corrigido ?? this.livresAEsperaToda(entrou, Math.max(entrou, fim ?? agora)) ?? undefined;
    const foto = this.fotoEm(entrou);
    if (!anotar((e.mapaRisco ??= {}), foto, { derivou, invisivel })) e.semFotoNoMapa = (e.semFotoNoMapa ?? 0) + 1;
    else if (!derivou && chave) {
      (e.callbacksNoMapa ??= {})[chave] = { k: chaveDoMapa(foto), tipo: (invisivel ?? foto.livres > 0) ? 'invisivel' : 'fila' };
    }
    return true;
  }

  /**
   * [NOVO] O raio-x do callback (callbacks.txt) concluiu se ele foi invisível (havia livre útil a
   * ligação toda) ou não. O mapa segue a mesma conclusão: o primeiro aviso costuma ser o webhook, que
   * pode vir sem o tempo de fila e só ver o instante do fim. Muda o tipo na mesma célula; se o
   * encerramento ainda não chegou, guarda para quando chegar.
   * @returns {boolean} true se mudou o mapa
   */
  corrigirCallbackNoMapa(chave, invisivel) {
    if (!chave || typeof invisivel !== 'boolean') return false;
    const e = this.estado;
    const c = e.callbacksNoMapa?.[chave];
    if (!c) {
      if (!this.contadas.has(chave)) {
        this.correcoes.set(chave, invisivel);
        while (this.correcoes.size > 500) this.correcoes.delete(this.correcoes.keys().next().value);
      }
      return false;
    }
    const novo = invisivel ? 'invisivel' : 'fila';
    const cel = e.mapaRisco?.[c.k];
    if (c.tipo === novo || !cel) return false;
    const campo = (t) => (t === 'invisivel' ? 'invisiveis' : 'fila');
    cel[campo(c.tipo)] = Math.max(0, (cel[campo(c.tipo)] ?? 0) - 1);
    cel[campo(novo)] = (cel[campo(novo)] ?? 0) + 1;
    c.tipo = novo;
    this.gravadoEm = 0;
    return true;
  }

  /** O pânico começou (ou trocou de motivo) agora. */
  registrarPanico(tipo, agora) {
    this.doDia(agora);
    if (tipo in this.estado.panicoVezes) this.estado.panicoVezes[tipo] += 1;
  }

  gravar(agora = Date.now()) {
    this.gravadoEm = agora;
    return this.repositorio?.salvar(this.estado);
  }

  /** [NOVO] Os totais de um dia, como o painel mostra (só as horas do expediente). */
  totaisDe(e) {
    const horas = Object.entries(e.horas ?? {}).filter(([h]) => this.horaNoExpediente(h)).map(([, v]) => v);
    const soma = (campo) => horas.reduce((t, v) => t + (v[campo] ?? 0), 0);
    const livresMs = soma('livresMs');
    const derivacoes = soma('derivacoes');
    const esperaSomaSeg = Math.round(soma('esperaSomaMs') / 1000);
    const esperaQtd = soma('esperaQtd');
    return {
      dia: e.dia,
      transbordos: e.transbordos ?? 0,
      leadsDerivados: e.leadsDerivados ?? 0,
      derivacoes,
      esperaSomaSeg,
      esperaQtd,
      livresMin: minutos(livresMs),
      torMin: minutos(soma('ociosoSemRobosMs')),
      tpaMin: minutos(soma('panicoMs')),
      calmaMin: minutos(soma('calmaMs')),
      tmeSeg: esperaQtd ? Math.round(esperaSomaSeg / esperaQtd) : null,
      oplSeg: derivacoes ? Math.round(livresMs / derivacoes / 1000) : null,
      // [NOVO] para o relatório de 7 e 30 dias e as sugestões
      normalMin: minutos(soma('normalMs')),
      agressivaMin: minutos(soma('agressivaMs')),
      medindoMin: minutos(soma('medindoMs')),
      robosLigadosMedia: soma('medidoMs') ? Math.round((soma('robosMs') / soma('medidoMs')) * 10) / 10 : null,
      ...(e.config ? { config: e.config } : {}),
      ...(e.configMudou ? { configMudou: true } : {}),
      porStatus: this.porStatusDoDia(horas),
      mapaRisco: e.mapaRisco ?? {},
      semFotoNoMapa: e.semFotoNoMapa ?? 0,
      porAtendente: Object.entries(e.porRamal ?? {}).map(([ramal, a]) => ({
        ramal, nome: a.nome ?? null, atendimentos: a.atendimentos ?? 0, livreMin: minutos(a.livreMs ?? 0),
        atendimentoMin: minutos(a.atendimentoMs ?? 0), pausaMin: minutos(Object.values(a.pausasMs ?? {}).reduce((t, v) => t + v, 0)),
      })),
    };
  }

  /**
   * [NOVO] Relatório de 7 ou 30 dias (com hoje, ainda parcial): um item por dia com dados, os totais
   * (TME e OPL pelas somas; TOR e TPA também em média por dia), o período anterior do mesmo
   * tamanho, a soma por atendente e as sugestões (domain/sugestoes.js, com todo o histórico).
   */
  periodo(tamanho, agora = Date.now()) {
    const n = tamanho === 30 ? 30 : 7;
    this.virarDia(agora);
    const hoje = { ...this.totaisDe(this.estado), hoje: true };
    const historico = this.diasDoHistorico().filter((d) => d.dia < hoje.dia);
    const inicio = Date.parse(hoje.dia) - (n - 1) * DIA_MS;
    // hoje só entra com algo medido (no fim de semana, por exemplo, não vira uma linha de zeros)
    const comDados = hoje.transbordos || hoje.leadsDerivados || hoje.derivacoes || hoje.livresMin || hoje.tpaMin;
    const noPeriodo = [...historico.filter((d) => Date.parse(d.dia) >= inicio), ...(comDados ? [hoje] : [])];
    const anterior = historico.filter((d) => Date.parse(d.dia) >= inicio - n * DIA_MS && Date.parse(d.dia) < inicio);
    const linha = (d) => ({
      dia: d.dia, ...(d.hoje ? { hoje: true } : {}),
      transbordos: d.transbordos ?? 0, leadsDerivados: d.leadsDerivados ?? 0, derivacoes: d.derivacoes ?? 0,
      // o gravado no dia (das somas em ms); só recalcula em dia antigo sem ele
      tmeSeg: d.tmeSeg !== undefined ? d.tmeSeg : d.esperaQtd ? Math.round((d.esperaSomaSeg ?? 0) / d.esperaQtd) : null,
      oplSeg: d.oplSeg !== undefined ? d.oplSeg : d.derivacoes ? Math.round(((d.livresMin ?? 0) * 60) / d.derivacoes) : null,
      livresMin: d.livresMin ?? 0, torMin: d.torMin ?? 0, tpaMin: d.tpaMin ?? 0,
      calmaMin: d.calmaMin ?? 0, normalMin: d.normalMin ?? 0, agressivaMin: d.agressivaMin ?? 0, medindoMin: d.medindoMin ?? 0,
      robosLigadosMedia: d.robosLigadosMedia ?? null,
    });
    return {
      tamanho: n,
      desde: new Date(inicio).toISOString().slice(0, 10),
      dias: noPeriodo.map(linha),
      totais: totaisDoPeriodo(noPeriodo),
      anterior: anterior.length ? totaisDoPeriodo(anterior) : null,
      porAtendente: somaPorAtendente(noPeriodo),
      sugestoes: sugestoes([...historico, hoje]),
      // [NOVO] mapa de risco dos robôs do período (painel: livres × robôs)
      mapaRisco: somarMapas(noPeriodo.map((d) => d.mapaRisco)),
      semFotoNoMapa: noPeriodo.reduce((t, d) => t + (d.semFotoNoMapa ?? 0), 0),
    };
  }

  /**
   * [NOVO] A configuração do dia é a do começo dele. Se outra aparecer no meio (reinício com outro
   * .env), o dia fica marcado e as sugestões não o usam.
   */
  guardarConfig(e) {
    const agora = this.fotoDaConfig?.();
    if (!agora) return;
    if (!e.config) e.config = agora;
    else if (!e.configMudou && JSON.stringify(e.config) !== JSON.stringify(agora)) e.configMudou = true;
  }

  /**
   * [NOVO] Por status da URA (calma, normal, agressiva): cada hora conta para o status em que a URA
   * passou mais da metade do tempo medido, e não conta se a maior parte foi fora da configuração.
   * Dá o OPL e os transbordos de cada status, para comparar configurações (sugestões).
   */
  porStatusDoDia(horas) {
    const acc = Object.fromEntries(['calma', 'normal', 'agressiva'].map((s) => [s, { ms: 0, livresMs: 0, derivacoes: 0, transbordos: 0 }]));
    for (const h of horas) {
      const tempos = { calma: h.calmaMs ?? 0, normal: h.normalMs ?? 0, agressiva: h.agressivaMs ?? 0 };
      const medido = tempos.calma + tempos.normal + tempos.agressiva + (h.medindoMs ?? 0);
      if (!medido || (h.foraDaConfigMs ?? 0) * 2 > medido) continue;
      const [status, ms] = Object.entries(tempos).sort((a, b) => b[1] - a[1])[0];
      if (ms * 2 <= medido) continue;
      const a = acc[status];
      a.ms += ms;
      a.livresMs += h.livresMs ?? 0;
      a.derivacoes += h.derivacoes ?? 0;
      a.transbordos += h.transbordos ?? 0;
    }
    return Object.fromEntries(Object.entries(acc).map(([s, a]) => [s, {
      min: minutos(a.ms), livresMin: minutos(a.livresMs), derivacoes: a.derivacoes, transbordos: a.transbordos,
    }]));
  }

  /** [NOVO] Guarda os totais do dia no histórico (um por dia, os últimos DIAS_NO_HISTORICO). */
  arquivar(e) {
    if (!this.historico || !e?.dia) return;
    const t = this.totaisDe(e);
    if (!t.transbordos && !t.leadsDerivados && !t.derivacoes && !t.livresMin && !t.tpaMin) return; // dia sem nada
    const dias = this.diasDoHistorico().filter((d) => d.dia !== t.dia);
    dias.push(t);
    dias.sort((a, b) => a.dia.localeCompare(b.dia));
    this.dias = dias.slice(-DIAS_NO_HISTORICO);
    this.historico.salvar({ dias: this.dias });
  }

  /** Lido uma vez do arquivo; depois, da memória (o resumo sai a cada /health). */
  diasDoHistorico() {
    if (!this.historico) return [];
    if (!this.dias) {
      const salvo = this.historico.carregar()?.dias;
      this.dias = Array.isArray(salvo) ? salvo : [];
    }
    return this.dias;
  }

  /** [NOVO] O dia anterior com dados e a média dos últimos 7 dias (só os que tiveram dados). */
  comparacao() {
    const hoje = this.estado.dia;
    const antes = this.diasDoHistorico().filter((d) => d.dia < hoje);
    // [NOVO] sem o resumo por atendente e a configuração: o /health não precisa deles
    const { porAtendente: _p, config: _c, ...anterior } = antes.at(-1) ?? {};
    const desde = Date.parse(hoje) - DIAS_NA_SEMANA * DIA_MS;
    const semana = antes.filter((d) => Date.parse(d.dia) >= desde);
    if (!semana.length) return { anterior: anterior.dia ? anterior : null, semana: null };
    const total = (campo) => semana.reduce((t, d) => t + (d[campo] ?? 0), 0);
    const media = (campo, casas = 0) => Math.round((total(campo) / semana.length) * 10 ** casas) / 10 ** casas;
    const esperaQtd = total('esperaQtd');
    const derivacoes = total('derivacoes');
    return {
      anterior: anterior.dia ? anterior : null,
      semana: {
        dias: semana.length,
        transbordos: media('transbordos'),
        leadsDerivados: media('leadsDerivados'),
        torMin: media('torMin', 1),
        tpaMin: media('tpaMin', 1),
        calmaMin: media('calmaMin', 1),
        tmeSeg: esperaQtd ? Math.round(total('esperaSomaSeg') / esperaQtd) : null,
        oplSeg: derivacoes ? Math.round((total('livresMin') * 60) / derivacoes) : null,
      },
    };
  }

  /** Para o /health e o painel. Minutos com uma casa decimal. */
  resumo() {
    const e = this.estado;
    const porDerivacao = (livresMs, derivacoes) => (derivacoes ? Math.round(livresMs / derivacoes / 1000) : null);
    const tme = (x) => (x.esperaQtd ? Math.round(x.esperaSomaMs / x.esperaQtd / 1000) : null);
    const mapa = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, minutos(v)]));
    return {
      dia: e.dia,
      livresMin: minutos(e.livresMs),
      derivacoes: e.derivacoes,
      // OPL (Ociosidade Por Lead): tempo livre somado ÷ ligações. TME: espera de cada um antes da ligação.
      esperaPorDerivacaoSeg: porDerivacao(e.livresMs, e.derivacoes),
      tmeSeg: tme(e),
      ociosoSemRobosMin: minutos(e.ociosoSemRobosMs),
      panicoMin: mapa(e.panicoMs),
      panicoVezes: { ...e.panicoVezes },
      termometroMin: mapa(e.termometroMs),
      leadsDerivados: e.leadsDerivados,
      transbordos: e.transbordos,
      transbordosPorMotivo: { ...e.transbordosPorMotivo },
      ultimoEncerramento: e.ultimoEncerramento ? { ...e.ultimoEncerramento } : null,
      filaMediaSeg: e.filaQtd ? Math.round(e.filaSegSoma / e.filaQtd) : null,
      pausasMin: mapa(e.pausasMs),
      porAtendente: this.porAtendente(),
      comparacao: this.comparacao(),
      horas: Object.entries(e.horas).filter(([h]) => this.horaNoExpediente(h)).sort(([a], [b]) => a.localeCompare(b)).map(([h, v]) => ({
        hora: h,
        livresMin: minutos(v.livresMs),
        derivacoes: v.derivacoes,
        esperaPorDerivacaoSeg: porDerivacao(v.livresMs, v.derivacoes),
        tmeSeg: tme(v),
        esperaSomaSeg: Math.round((v.esperaSomaMs ?? 0) / 1000),
        esperaQtd: v.esperaQtd ?? 0,
        ociosoSemRobosMin: minutos(v.ociosoSemRobosMs),
        panicoMin: minutos(v.panicoMs),
        calmaMin: minutos(v.calmaMs),
        agressivaMin: minutos(v.agressivaMs),
        normalMin: minutos(v.normalMs ?? 0),
        medindoMin: minutos(v.medindoMs ?? 0),
        leadsDerivados: v.leadsDerivados ?? 0,
        transbordos: v.transbordos ?? 0,
      })),
    };
  }

  /** [NOVO] Relatório por atendente, por nome. Minutos com uma casa decimal. */
  porAtendente() {
    return Object.entries(this.estado.porRamal ?? {}).map(([ramal, a]) => {
      const pausaMs = Object.values(a.pausasMs).reduce((t, v) => t + v, 0);
      const totalMs = a.livreMs + a.atendimentoMs + a.outroMs + pausaMs;
      return {
        ramal,
        nome: a.nome,
        primeiroEm: a.primeiroEm,
        ultimoEm: a.ultimoEm,
        livreMin: minutos(a.livreMs),
        atendimentoMin: minutos(a.atendimentoMs),
        outroMin: minutos(a.outroMs),
        pausaMin: minutos(pausaMs),
        pausasMin: Object.fromEntries(Object.entries(a.pausasMs).map(([k, v]) => [k, minutos(v)])),
        pausaPct: totalMs ? Math.round((pausaMs / totalMs) * 100) : 0,
        atendimentos: a.atendimentos,
        pausasEstouradas: a.pausasEstouradas,
        maiorEsperaSeg: Math.round(a.maiorEsperaMs / 1000),
      };
    }).sort((x, y) => String(x.nome ?? x.ramal).localeCompare(String(y.nome ?? y.ramal), 'pt-BR'));
  }
}

module.exports = { EstatisticasDia, limiteDaPausaMin };

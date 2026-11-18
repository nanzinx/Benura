'use strict';
/**
 * [NOVO] Liberados da URA (aba Relatórios do painel): todo dia, no horário (padrão 08:30, nos dias
 * com operação), calcula quem pode iniciar na URA e gera o comunicado do grupo. Guarda cada geração
 * no histórico por dia da URA. Sem vendas, grava o motivo e não gera comunicado.
 *
 * A configuração (meta, fixos, horário) vem do .env e pode ser trocada no painel (supervisor):
 * o que foi trocado fica no arquivo e vale por cima do .env.
 *
 * Envio ao grupo do BenHub: só com LIBERADOS_URA_WEBHOOK_URL e depois do clique e da confirmação.
 */

const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { dataLocal, horaLocal } = require('../utils/datas');
const { lerFixos, lerDiasOperacao, diaAnteriorComOperacao, calcular, comunicado, somarDias } = require('../domain/liberados-ura');

const VERIFICAR_MS = 30_000;
const FOTO_A_CADA_MS = 10 * 60_000;
const NOVA_TENTATIVA_MS = 10 * 60_000;
/** Depois disto, a agenda desiste do dia (alguém pode gerar à mão). */
const TENTAR_ATE = '12:00';
const GUARDAR_DIAS = 90;

const minutos = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
const horaValida = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));

class LiberadosUra {
  /**
   * @param {object} deps
   * @param {{ vendasDoDia(dia: string): Promise<object>, fotografar?(): Promise<boolean> }} deps.fonte
   * @param {{ meta: number, fixos: string, horario: string, diasOperacao: string, arquivo: string }} deps.cfg
   * @param {string} deps.fuso
   * @param {{ notificar(aviso: object): Promise<{ ok: boolean, erro?: string }> }|null} [deps.grupo] - o webhook do grupo (null = desligado)
   */
  constructor({ fonte, cfg, fuso, logger, grupo = null, agora = () => new Date() }) {
    Object.assign(this, { fonte, cfgEnv: cfg, fuso, log: logger, grupo, agora });
    this.repositorio = new ArquivoDeEstado({ arquivo: cfg.arquivo, logger });
    const salvo = this.repositorio.carregar() ?? {};
    this.ajustes = salvo.config ?? {};
    this.historico = salvo.historico ?? {};
    this.ultimaTentativa = 0;
    this.gerando = null;
  }

  /** A configuração que vale: o .env com o que foi trocado no painel por cima. */
  config() {
    const c = { meta: this.cfgEnv.meta, fixos: this.cfgEnv.fixos, horario: this.cfgEnv.horario, diasOperacao: this.cfgEnv.diasOperacao, ...this.ajustes };
    return { ...c, diasOperacao: lerDiasOperacao(c.diasOperacao) };
  }

  /** PUT pelo painel. @throws {Error} valor inválido */
  definirConfig({ meta, fixos, horario }, por) {
    const novo = { ...this.ajustes };
    if (meta !== undefined) {
      if (!(Number(meta) > 0)) throw new Error('A meta deve ser maior que zero.');
      novo.meta = Number(meta);
    }
    if (fixos !== undefined) novo.fixos = String(fixos);
    if (horario !== undefined) {
      if (!horaValida(horario)) throw new Error('Horário inválido (use HH:MM).');
      novo.horario = horario;
    }
    this.ajustes = novo;
    this.salvar();
    this.log.info(`Liberados da URA: configuração trocada por ${por}: meta R$ ${novo.meta ?? this.cfgEnv.meta}, fixos "${novo.fixos ?? this.cfgEnv.fixos}", horário ${novo.horario ?? this.cfgEnv.horario}.`);
    return this.config();
  }

  salvar() {
    for (const d of Object.keys(this.historico).sort().slice(0, -GUARDAR_DIAS)) delete this.historico[d];
    this.repositorio.salvar({ config: this.ajustes, historico: this.historico });
  }

  /** Espera a gravação em andamento (testes e desligamento). */
  aguardar() {
    return this.repositorio.aguardar();
  }

  hoje() {
    return dataLocal(this.fuso, this.agora());
  }

  /**
   * Gera (ou refaz) o dia da URA. Sem vendas, grava o motivo e não gera comunicado.
   * @returns {Promise<object>} o registro gravado
   */
  async gerar({ diaUra = this.hoje(), por = 'agenda do BenURA' } = {}) {
    if (this.gerando) return this.gerando;
    this.gerando = this.gerarAgora(diaUra, por).finally(() => { this.gerando = null; });
    return this.gerando;
  }

  async gerarAgora(diaUra, por) {
    const c = this.config();
    const fixos = lerFixos(c.fixos);
    const diaVendas = diaAnteriorComOperacao(diaUra, c.diasOperacao);
    const base = { diaUra, diaVendas, meta: c.meta, fixos, geradoEm: this.agora().toISOString(), por };
    const lido = await this.fonte.vendasDoDia(diaVendas);
    let registro;
    if (!lido.vendas?.length) {
      registro = { ...base, ok: false, motivo: lido.motivo ?? 'Sem vendas para esse dia.' };
    } else if (lido.vendas.every((v) => !(Number(v.valor) > 0))) {
      // Todo mundo com R$ 0 é Carrossel com problema, não um dia sem venda: não vira comunicado.
      registro = { ...base, ok: false, motivo: `O Carrossel mandou ${lido.vendas.length} consultor(es), todos com R$ 0, para ${diaVendas.split('-').reverse().join('/')}: os dados parecem incompletos.` };
    } else {
      const r = calcular({ vendas: lido.vendas, meta: c.meta, fixos });
      registro = {
        ...base, ok: true, origem: lido.origem,
        total: r.total, ranking: r.ranking, liberados: r.liberados, bateram: r.bateram.map((x) => x.nome),
        coroa: r.coroa, fixosNaUra: r.fixosNaUra, pelaMeta: r.pelaMeta,
        texto: comunicado({ diaUra, diaVendas, meta: c.meta, fixos, bateram: r.bateram }),
      };
    }
    // Uma tentativa sem dados não apaga um comunicado bom já gerado para o mesmo dia.
    const anterior = this.historico[diaUra];
    if (registro.ok || !anterior?.ok) this.historico[diaUra] = registro;
    else this.historico[diaUra] = { ...anterior, ultimaFalha: { em: registro.geradoEm, motivo: registro.motivo } };
    this.salvar();
    this.log[registro.ok ? 'info' : 'aviso'](`Liberados da URA ${diaUra} (vendas de ${diaVendas}) por ${por}: `
      + (registro.ok ? `${registro.liberados.length} na URA (${registro.fixosNaUra} fixo(s) + ${registro.pelaMeta} pela meta), ${registro.bateram.length} bateram.` : `sem comunicado. ${registro.motivo}`));
    return this.historico[diaUra];
  }

  /** O dia pedido (padrão: hoje), a lista de dias do histórico e a configuração. */
  resumo(dia = this.hoje()) {
    return {
      dia,
      registro: this.historico[dia] ?? null,
      datas: Object.keys(this.historico).sort().reverse(),
      config: this.config(),
      envioAoGrupo: Boolean(this.grupo),
      hoje: this.hoje(),
    };
  }

  /** Envia o comunicado do dia ao grupo do BenHub (só depois da confirmação no painel). */
  async enviar(dia, por) {
    if (!this.grupo) throw Object.assign(new Error('Envio ao grupo desligado: configure LIBERADOS_URA_WEBHOOK_URL.'), { status: 409 });
    const r = this.historico[dia];
    if (!r?.ok || !r.texto) throw Object.assign(new Error('Esse dia não tem comunicado gerado.'), { status: 409 });
    const envio = await this.grupo.notificar({ titulo: `URA — Lista de hoje (${dia.slice(8, 10)}/${dia.slice(5, 7)})`, texto: r.texto, nivel: 'info', dados: { tipo: 'liberados-ura', dia } });
    r.envios = [...(r.envios ?? []), { em: this.agora().toISOString(), por, ok: envio.ok, erro: envio.erro ?? null }];
    this.salvar();
    this.log.info(`Liberados da URA ${dia}: enviado ao grupo por ${por} — ${envio.ok ? 'ok' : `falhou (${envio.erro})`}.`);
    return { ok: envio.ok, erro: envio.erro ?? null, envios: r.envios };
  }

  /** A agenda: na hora marcada (nos dias com operação) gera; sem dados, tenta de novo a cada 10 min até o meio-dia. */
  async verificar() {
    const agora = this.agora();
    const c = this.config();
    const hoje = dataLocal(this.fuso, agora);
    const semana = new Date(`${hoje}T12:00:00Z`).getUTCDay();
    if (!c.diasOperacao.includes(semana)) return null;
    const min = minutos(horaLocal(this.fuso, agora));
    if (min < minutos(c.horario) || min >= minutos(TENTAR_ATE)) return null;
    if (this.historico[hoje]?.ok || agora.getTime() - this.ultimaTentativa < NOVA_TENTATIVA_MS) return null;
    this.ultimaTentativa = agora.getTime();
    return this.gerar({ diaUra: hoje });
  }

  iniciar() {
    const laco = setInterval(() => { this.verificar().catch((e) => this.log.erro(`Liberados da URA: ${e.message}`)); }, VERIFICAR_MS);
    const foto = this.fonte.fotografar ? setInterval(() => { this.fonte.fotografar().catch(() => {}); }, FOTO_A_CADA_MS) : null;
    this.fonte.fotografar?.().catch(() => {});
    laco.unref?.();
    foto?.unref?.();
    return () => { clearInterval(laco); if (foto) clearInterval(foto); };
  }
}

module.exports = { LiberadosUra, somarDias };

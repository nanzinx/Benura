'use strict';
/** [NOVO] Relatório de 7 e 30 dias: o histórico guarda mais de cada dia, e o período soma, compara e sugere. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');

const FUSO = 'America/Sao_Paulo';
const EXPEDIENTE = { inicio: '08:00', fim: '18:00' };
const em = (dia, hora) => new Date(`${dia}T${hora}:00-03:00`).getTime();
const memoria = (inicial = null) => ({ dados: inicial, carregar() { return this.dados; }, salvar(d) { this.dados = JSON.parse(JSON.stringify(d)); } });
const CONFIG = { porLivre: 7, porStatus: { calma: { esperaS: 45, min: 20, max: 20 } }, todosComLivresCalma: 2, tempoMin: 2, cheiaLivres: { min: 4, max: 6 } };

/** `min` minutos de amostras a cada 10 s, começando em `hora`. */
function amostras(e, dia, hora, min, dados) {
  for (let t = em(dia, hora); t <= em(dia, hora) + min * 60_000; t += 10_000) e.amostrar(t, dados);
}

test('histórico: cada dia guarda os minutos de cada status, a média de robôs, a configuração e o resumo por atendente', () => {
  const historico = memoria();
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico, fotoDaConfig: () => CONFIG });
  amostras(e, '2026-11-02', '09:00', 30, { livres: 2, robosLigados: 10, termometro: 'calma', operadores: [{ ramal: '201', nome: 'Ana', classe: 'livre' }] });
  amostras(e, '2026-11-02', '09:30', 30, { livres: 1, robosLigados: 20, termometro: 'normal', operadores: [{ ramal: '201', nome: 'Ana', classe: 'atendimento' }] });
  e.registrarDerivacao(em('2026-11-02', '10:00'), '201', 60_000);
  e.amostrar(em('2026-11-03', '08:05'), { livres: 0, robosLigados: 0, termometro: 'normal' }); // virou o dia
  const [d] = historico.dados.dias;
  assert.equal(d.dia, '2026-11-02');
  assert.equal(Math.round(d.calmaMin), 30);
  assert.equal(Math.round(d.normalMin), 30);
  assert.equal(d.agressivaMin, 0);
  assert.equal(Math.round(d.robosLigadosMedia), 15, 'metade do tempo com 10, metade com 20');
  assert.deepEqual(d.config, CONFIG);
  assert.deepEqual(d.porAtendente.map((a) => [a.ramal, a.nome, Math.round(a.livreMin), Math.round(a.atendimentoMin), a.atendimentos]), [['201', 'Ana', 30, 30, 1]]);
});

test('histórico: guarda até 120 dias', () => {
  const dias = Array.from({ length: 125 }, (_, i) => ({ dia: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), transbordos: 1, leadsDerivados: 1, derivacoes: 1, livresMin: 1 }));
  const historico = memoria({ dias });
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico });
  e.carregar(em('2026-06-01', '09:00'));
  amostras(e, '2026-06-01', '09:00', 1, { livres: 1, robosLigados: 1, termometro: 'normal' });
  e.amostrar(em('2026-06-02', '08:05'), { livres: 0, robosLigados: 0, termometro: 'normal' });
  assert.equal(historico.dados.dias.length, 120);
  assert.equal(historico.dados.dias.at(-1).dia, '2026-06-01');
});

const dia = (d, x = {}) => ({ dia: d, transbordos: 2, leadsDerivados: 10, derivacoes: 10, esperaSomaSeg: 1200, esperaQtd: 10, livresMin: 30, torMin: 4, tpaMin: 6, calmaMin: 60, normalMin: 120, agressivaMin: 30, medindoMin: 5, ...x });

test('período de 7 dias: série com hoje, totais certos (TME e OPL pelas somas), período anterior e soma por atendente', () => {
  const antes = [
    dia('2026-10-20', { transbordos: 9 }), // no período anterior
    dia('2026-10-27', { porAtendente: [{ ramal: '201', nome: 'Ana', atendimentos: 3, livreMin: 10, atendimentoMin: 20, pausaMin: 5 }] }),
    dia('2026-10-30', { derivacoes: 30, livresMin: 30, esperaSomaSeg: 600, esperaQtd: 30, porAtendente: [{ ramal: '201', nome: 'Ana', atendimentos: 4, livreMin: 5, atendimentoMin: 25, pausaMin: 0 }] }),
  ];
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico: memoria({ dias: antes }) });
  e.carregar(em('2026-11-02', '09:00'));
  e.registrarDerivacao(em('2026-11-02', '09:30'), '201', 30_000);
  const p = e.periodo(7, em('2026-11-02', '12:00'));
  assert.deepEqual(p.dias.map((x) => [x.dia, Boolean(x.hoje)]), [['2026-10-27', false], ['2026-10-30', false], ['2026-11-02', true]]);
  assert.equal(p.totais.dias, 3);
  assert.equal(p.totais.transbordos, 4);
  assert.equal(p.totais.oplSeg, Math.round(((30 + 30 + 0) * 60) / (10 + 30 + 1)), 'tempo livre somado ÷ derivações somadas');
  assert.equal(p.totais.tmeSeg, Math.round((1200 + 600 + 30) / (10 + 30 + 1)));
  assert.equal(p.totais.torMinDia, 4, 'média por dia, só dos 2 dias completos');
  assert.equal(p.totais.diasCompletos, 2);
  assert.equal(p.anterior.dias, 1);
  assert.equal(p.anterior.transbordos, 9);
  assert.deepEqual(p.porAtendente.map((a) => [a.ramal, a.atendimentos, a.livreMin, a.atendimentoMin]), [['201', 8, 15, 45]], '3 + 4 dos dias guardados + 1 de hoje');
  assert.ok(Array.isArray(p.sugestoes));
});

test('período: só 7 ou 30 dias; outro valor vira 7', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico: memoria({ dias: [] }) });
  assert.equal(e.periodo(30, em('2026-11-02', '12:00')).tamanho, 30);
  assert.equal(e.periodo(99, em('2026-11-02', '12:00')).tamanho, 7);
});

test('rota GET /relatorio/periodo: lê ?dias= (7 ou 30) e responde 404 sem estatísticas', async () => {
  const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
  const pedidos = [];
  const estatisticas = { periodo: (n) => { pedidos.push(n); return { tamanho: n === 30 ? 30 : 7 }; } };
  const rota = (rodizio) => criarRotasDoRodizio({ rodizio, ciclos: {}, logger: { info() {}, aviso() {}, erro() {}, debug() {} } })
    .find((r) => r.metodo === 'GET' && r.caminho === '/relatorio/periodo');
  const r30 = await rota({ estatisticas }).handler({ req: { url: '/relatorio/periodo?dias=30' } });
  assert.equal(r30.status, 200);
  assert.equal(r30.corpo.tamanho, 30);
  await rota({ estatisticas }).handler({ req: { url: '/relatorio/periodo?dias=abc' } });
  assert.deepEqual(pedidos, [30, 7]);
  assert.equal((await rota({ estatisticas: null }).handler({ req: { url: '/relatorio/periodo' } })).status, 404);
});

test('foto da configuração (do .env de verdade): robôs por status, calma, tempo e URA cheia', () => {
  const { carregarConfig } = require('../../src/config');
  const { fotoDaConfig } = require('../../src/rodizio/app');
  const cfg = carregarConfig();
  const f = fotoDaConfig(cfg.rodizio);
  assert.deepEqual(Object.keys(f.porStatus).sort(), ['agressiva', 'calma', 'normal']);
  assert.deepEqual(Object.keys(f.porStatus.calma).sort(), ['esperaS', 'max', 'min']);
  assert.ok(Number.isFinite(f.porLivre) && Number.isFinite(f.tempoMin) && Number.isFinite(f.todosComLivresCalma));
  assert.ok(f.cheiaLivres.max >= f.cheiaLivres.min);
});

test('período: hoje sem nada medido não vira linha; a comparação do /health não leva o resumo por atendente', () => {
  const antes = [dia('2026-10-30', { porAtendente: [{ ramal: '201', nome: 'Ana', atendimentos: 4, livreMin: 5, atendimentoMin: 25, pausaMin: 0 }], config: CONFIG })];
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico: memoria({ dias: antes }) });
  e.carregar(em('2026-11-01', '09:00'));
  assert.deepEqual(e.periodo(7, em('2026-11-01', '12:00')).dias.map((x) => x.dia), ['2026-10-30']);
  const c = e.comparacao();
  assert.equal(c.anterior.dia, '2026-10-30');
  assert.equal(c.anterior.porAtendente, undefined);
  assert.equal(c.anterior.config, undefined);
});

test('histórico por status: cada hora conta para o status em que a URA passou mais da metade; horas fora da configuração não contam', () => {
  const historico = memoria();
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico, fotoDaConfig: () => CONFIG });
  amostras(e, '2026-11-02', '09:00', 59, { livres: 2, robosLigados: 10, termometro: 'calma' }); // 09h: calma
  e.registrarDerivacao(em('2026-11-02', '09:20'), null, 30_000);
  amostras(e, '2026-11-02', '10:00', 59, { livres: 1, robosLigados: 10, termometro: 'normal' }); // 10h: normal
  amostras(e, '2026-11-02', '11:00', 59, { livres: 3, robosLigados: 0, termometro: 'calma', naConfig: false }); // 11h: robôs fora do automático
  e.amostrar(em('2026-11-03', '08:05'), { livres: 0, robosLigados: 0, termometro: 'normal' });
  const [d] = historico.dados.dias;
  assert.equal(Math.round(d.porStatus.calma.min), 59, 'só a hora das 9');
  assert.equal(Math.round(d.porStatus.calma.livresMin), 118);
  assert.equal(d.porStatus.calma.derivacoes, 1);
  assert.equal(d.porStatus.normal.min, 59.5, 'inclui os 30 s da virada para normal');
  assert.equal(d.porStatus.agressiva.min, 0);
  assert.equal(d.configMudou, undefined);
});

test('histórico: a configuração que vale é a do começo do dia; se mudar no meio (reinício com outro .env), o dia fica marcado', () => {
  const historico = memoria();
  let cfg = CONFIG;
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico, fotoDaConfig: () => cfg });
  amostras(e, '2026-11-02', '09:00', 5, { livres: 2, robosLigados: 10, termometro: 'calma' });
  cfg = { ...CONFIG, porLivre: 9 };
  amostras(e, '2026-11-02', '09:06', 5, { livres: 2, robosLigados: 10, termometro: 'calma' });
  e.amostrar(em('2026-11-03', '08:05'), { livres: 0, robosLigados: 0, termometro: 'normal' });
  const [d] = historico.dados.dias;
  assert.deepEqual(d.config, CONFIG);
  assert.equal(d.configMudou, true);
});

test('período: médias por dia só com os dias completos (hoje parcial não puxa para baixo); a linha usa o OPL e o TME gravados', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico: memoria({ dias: [
    dia('2026-10-30', { transbordos: 10, oplSeg: 61, tmeSeg: 119 }), dia('2026-10-31', { transbordos: 10 }),
  ] }) });
  e.carregar(em('2026-11-02', '09:00'));
  e.registrarDerivacao(em('2026-11-02', '09:30'), null, 30_000);
  const p = e.periodo(7, em('2026-11-02', '12:00'));
  assert.equal(p.totais.dias, 3);
  assert.equal(p.totais.transbordos, 20);
  assert.equal(p.totais.transbordosDia, 10, 'hoje (0 até agora) não entra na média');
  assert.equal(p.dias[0].oplSeg, 61);
  assert.equal(p.dias[0].tmeSeg, 119);
});

test('[NOVO] mapa de risco: cada ligação cai na foto de quando o cliente entrou (com o tempo de fila); vai ao histórico e o período soma', () => {
  const historico = memoria();
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico });
  e.amostrar(em('2026-11-02', '09:00'), { livres: 2, robosLigados: 14, termometro: 'normal' });
  e.amostrar(em('2026-11-02', '09:01'), { livres: 0, robosLigados: 45, termometro: 'calma' });
  e.amostrar(em('2026-11-02', '09:02'), { livres: 1, robosLigados: 45, termometro: 'calma' });
  // lead que entrou às 09:00:30 (30 s de fila, terminou 09:01:00): foto das 09:00
  e.registrarEncerramento(em('2026-11-02', '09:01'), { chave: 'L1', derivou: true, motivo: 'derivou', filaSeg: 30 });
  e.registrarEncerramento(em('2026-11-02', '09:01'), { chave: 'L1', derivou: true, motivo: 'derivou', filaSeg: 30 }); // repetido
  // callback que entrou 09:01:20 (0 livres): de fila
  e.registrarEncerramento(em('2026-11-02', '09:02'), { chave: 'C1', derivou: false, motivo: 'abandono', filaSeg: 40 });
  // callback pelo relatório (quando = início, 09:02:10): 1 livre → invisível
  e.registrarEncerramento(em('2026-11-02', '09:05'), { chave: 'C2', derivou: false, motivo: 'abandono', filaSeg: null, quando: em('2026-11-02', '09:02') + 10_000 }, 'relatório');
  // sem agente não conta (como nos transbordos)
  e.registrarEncerramento(em('2026-11-02', '09:02'), { chave: 'S1', derivou: false, motivo: 'sem agente', filaSeg: 0 });
  assert.deepEqual(e.estado.mapaRisco, {
    '2|11-20|normal': { leads: 1, fila: 0, invisiveis: 0 },
    '0|41+|calma': { leads: 0, fila: 1, invisiveis: 0 },
    '1|41+|calma': { leads: 0, fila: 0, invisiveis: 1 },
  });

  e.amostrar(em('2026-11-03', '09:00'), { livres: 2, robosLigados: 14, termometro: 'normal' }); // virou o dia
  assert.deepEqual(historico.dados.dias[0].mapaRisco['0|41+|calma'], { leads: 0, fila: 1, invisiveis: 0 });
  e.registrarEncerramento(em('2026-11-03', '09:00') + 5000, { chave: 'L2', derivou: true, motivo: 'derivou', filaSeg: 2 });
  const p = e.periodo(7, em('2026-11-03', '10:00'));
  assert.deepEqual(p.mapaRisco['2|11-20|normal'], { leads: 2, fila: 0, invisiveis: 0 }, 'ontem + hoje');
  assert.equal(p.semFotoNoMapa, 0);
});

test('[NOVO] mapa de risco: sem foto (logo depois de subir) a ligação conta no dia, mas não no mapa', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE });
  e.registrarEncerramento(em('2026-11-02', '09:00'), { chave: 'L1', derivou: true, motivo: 'derivou', filaSeg: 2 });
  assert.equal(e.estado.leadsDerivados, 1);
  assert.deepEqual(e.estado.mapaRisco ?? {}, {});
  assert.equal(e.estado.semFotoNoMapa, 1);
});

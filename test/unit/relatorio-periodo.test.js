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
  assert.equal(p.totais.torMinDia, Math.round(((4 + 4) / 3) * 10) / 10, 'média por dia');
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

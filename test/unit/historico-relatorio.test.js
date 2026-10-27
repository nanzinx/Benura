'use strict';
/** [NOVO] Relatório do dia: guarda os totais de cada dia e compara hoje com o dia anterior e a média da semana. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');

const FUSO = 'America/Sao_Paulo';
const EXPEDIENTE = { inicio: '08:00', fim: '18:00' };
const em = (dia, hora) => new Date(`${dia}T${hora}:00-03:00`).getTime();

/** Repositório em memória, como o ArquivoDeEstado. */
const memoria = (inicial = null) => ({ dados: inicial, carregar() { return this.dados; }, salvar(d) { this.dados = JSON.parse(JSON.stringify(d)); } });

/** Um dia com `transbordos` transbordos, `leads` leads e uma derivação com `esperaSeg` de espera às 10h. */
function diaCom(e, dia, { transbordos = 0, leads = 0, esperaSeg = 60 } = {}) {
  for (let i = 0; i < transbordos; i++) e.registrarEncerramento(em(dia, '10:00'), { chave: `${dia}-t${i}`, derivou: false, motivo: 'abandonou a fila', filaSeg: 30 });
  for (let i = 0; i < leads; i++) e.registrarEncerramento(em(dia, '10:00'), { chave: `${dia}-l${i}`, derivou: true, motivo: 'derivou', filaSeg: 5 });
  e.registrarDerivacao(em(dia, '10:00'), '1001', esperaSeg * 1000);
}

test('histórico: na virada do dia guarda os totais do dia que acabou', () => {
  const historico = memoria();
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico });
  diaCom(e, '2026-10-26', { transbordos: 3, leads: 10, esperaSeg: 90 });
  e.amostrar(em('2026-10-27', '08:05'), { livres: 1, robosLigados: 0, panico: null, termometro: 'normal' });
  const [ontem] = historico.dados.dias;
  assert.equal(ontem.dia, '2026-10-26');
  assert.deepEqual([ontem.transbordos, ontem.leadsDerivados, ontem.derivacoes, ontem.tmeSeg], [3, 10, 1, 90]);
});

test('histórico: o rodízio parado à noite (agenda) não perde o dia: arquiva ao subir no dia seguinte', () => {
  const historico = memoria();
  const repositorio = memoria();
  const ontem = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico, repositorio });
  diaCom(ontem, '2026-10-26', { transbordos: 2, leads: 5 });
  ontem.gravar(em('2026-10-26', '17:59'));
  // 08:00 de terça: o processo novo lê o arquivo de segunda
  new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico, repositorio }).carregar(em('2026-10-27', '08:00'));
  assert.deepEqual(historico.dados.dias.map((d) => [d.dia, d.transbordos]), [['2026-10-26', 2]]);
});

test('histórico: o mesmo dia não entra duas vezes e guarda só os últimos 60', () => {
  const dias = Array.from({ length: 70 }, (_, i) => ({ dia: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), transbordos: i }));
  const historico = memoria({ dias });
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico });
  diaCom(e, '2026-10-26', { transbordos: 1 });
  e.virarDia(em('2026-10-27', '08:00'));
  diaCom(e, '2026-10-27', { transbordos: 1 });
  e.estado.dia = '2026-10-26'; // reinício estranho: o mesmo dia de novo
  e.virarDia(em('2026-10-27', '09:00'));
  const lista = historico.dados.dias;
  assert.equal(lista.length, 60);
  assert.equal(lista.filter((d) => d.dia === '2026-10-26').length, 1);
  assert.equal(lista.at(-1).dia, '2026-10-26');
});

test('comparação: hoje x dia anterior x média dos últimos 7 dias (TME e OPL pela soma, não pela média das médias)', () => {
  const historico = memoria({ dias: [
    { dia: '2026-10-16', transbordos: 100, leadsDerivados: 1, derivacoes: 1, esperaSomaSeg: 10, esperaQtd: 1, livresMin: 1, torMin: 0, tpaMin: 0, calmaMin: 0, tmeSeg: 10, oplSeg: 60 }, // fora dos 7 dias
    { dia: '2026-10-22', transbordos: 4, leadsDerivados: 20, derivacoes: 10, esperaSomaSeg: 600, esperaQtd: 10, livresMin: 30, torMin: 6, tpaMin: 10, calmaMin: 2, tmeSeg: 60, oplSeg: 180 },
    { dia: '2026-10-23', transbordos: 2, leadsDerivados: 30, derivacoes: 30, esperaSomaSeg: 3600, esperaQtd: 30, livresMin: 90, torMin: 2, tpaMin: 4, calmaMin: 0, tmeSeg: 120, oplSeg: 180 },
  ] });
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE, historico });
  diaCom(e, '2026-10-26', { transbordos: 1, leads: 3 });
  const c = e.resumo().comparacao;
  assert.equal(c.anterior.dia, '2026-10-23', 'segunda compara com sexta');
  assert.equal(c.anterior.transbordos, 2);
  assert.equal(c.semana.dias, 2);
  assert.equal(c.semana.transbordos, 3, 'média de 4 e 2');
  assert.equal(c.semana.tmeSeg, Math.round(4200 / 40), 'TME da semana: soma das esperas ÷ ligações');
  assert.equal(c.semana.oplSeg, Math.round((120 * 60) / 40));
});

test('comparação: sem histórico, vazia (o painel não mostra nada)', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO, expediente: EXPEDIENTE });
  diaCom(e, '2026-10-26');
  assert.deepEqual(e.resumo().comparacao, { anterior: null, semana: null });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AgendaAutomacao, POR_AGENDA } = require('../../src/painel/agenda-automacao');
const { loggerNulo } = require('../../src/utils/logger');

const FUSO = 'America/Sao_Paulo';
// 2026-10-26 é segunda-feira; 03:00 UTC a menos que Brasília.
const em = (dia, hora) => new Date(`${dia}T${hora}:00-03:00`).getTime();

/** ControleAutomacao falso: guarda o estado e quem mexeu, como o arquivo de verdade. */
function montar({ desligada = false, por = null } = {}) {
  const automacao = {
    gravado: { desligada, por },
    chamadas: [],
    estado() { return { estado: this.gravado.desligada ? 'desligada' : 'ligada', por: this.gravado.por }; },
    desligar(p) { this.chamadas.push(['desligar', p]); this.gravado = { desligada: true, por: p }; return { iniciado: true }; },
    religar(p) { this.chamadas.push(['religar', p]); this.gravado = { desligada: false, por: p }; return { iniciado: true }; },
  };
  let agora = 0;
  const agenda = new AgendaAutomacao({
    automacao, cfg: { desligarAs: '18:00', religarAs: '08:00', fuso: FUSO }, logger: loggerNulo, agora: () => agora,
  });
  return { automacao, agenda, em: (dia, hora) => { agora = em(dia, hora); return agenda.verificar(); } };
}

test('agenda: desliga às 18:00 e religa às 08:00 de segunda a sexta', () => {
  const { automacao, em: as } = montar();
  as('2026-10-26', '17:59');
  assert.deepEqual(automacao.chamadas, []);
  as('2026-10-26', '18:00');
  as('2026-10-26', '18:01');
  assert.deepEqual(automacao.chamadas, [['desligar', POR_AGENDA]], 'uma vez só');
  as('2026-10-27', '07:59');
  as('2026-10-27', '08:00');
  as('2026-10-27', '08:02');
  assert.deepEqual(automacao.chamadas.at(-1), ['religar', POR_AGENDA]);
  assert.equal(automacao.chamadas.length, 2);
});

test('agenda: fim de semana não religa; segunda às 08:00 religa', () => {
  const { automacao, em: as } = montar();
  as('2026-10-30', '18:00'); // sexta
  as('2026-10-31', '08:00'); // sábado
  as('2026-11-01', '08:00'); // domingo
  assert.deepEqual(automacao.chamadas, [['desligar', POR_AGENDA]]);
  as('2026-11-02', '08:00'); // segunda
  assert.deepEqual(automacao.chamadas.at(-1), ['religar', POR_AGENDA]);
});

test('agenda: só age na hora marcada (quem religou à mão de noite continua ligado)', () => {
  const { automacao, em: as } = montar();
  as('2026-10-26', '18:00');
  automacao.gravado = { desligada: false, por: 'ana@empresa.com' }; // hora extra: religou às 19:00
  as('2026-10-26', '19:00');
  as('2026-10-26', '23:30');
  assert.equal(automacao.chamadas.length, 1);
});

test('agenda: às 08:00 só religa o que ela mesma desligou (desligada à mão fica desligada)', () => {
  const { automacao, em: as } = montar({ desligada: true, por: 'ana@empresa.com' });
  as('2026-10-26', '18:00'); // já desligada: nada a fazer
  as('2026-10-27', '08:00');
  assert.deepEqual(automacao.chamadas, []);
});

test('agenda: sem horário no .env não faz nada', () => {
  const automacao = { estado: () => ({ estado: 'ligada' }), desligar() { throw new Error('não devia'); }, religar() { throw new Error('não devia'); } };
  const agenda = new AgendaAutomacao({ automacao, cfg: { desligarAs: '', religarAs: '', fuso: FUSO }, logger: loggerNulo, agora: () => em('2026-10-26', '18:00') });
  assert.equal(agenda.ativa, false);
  agenda.verificar();
});

test('agenda: religa pela trava dos dois PCs (com o outro PC agindo, não religa)', async () => {
  const { automacao, em: as } = montar();
  as('2026-10-26', '18:00');
  automacao.prepararParaAgir = async () => ({ ok: false, motivo: 'o PC do chefe está agindo' });
  await as('2026-10-27', '08:00');
  assert.deepEqual(automacao.chamadas.map(([c]) => c), ['desligar'], 'não religou');
});

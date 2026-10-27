'use strict';
/** [NOVO] Vigia de saúde do painel: serviço fora do ar há mais de 5 min vira aviso (uma vez), e a volta também. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { VigiaSaude } = require('../../src/painel/vigia-saude');
const { loggerNulo } = require('../../src/utils/logger');

function montar({ estado = 'ligada', agindo = true, componentes = {} } = {}) {
  let agora = Date.parse('2026-10-27T13:00:00Z'); // 10:00 em Brasília
  const online = { roteador: true, rodizio: true, rotinas: true, atualizador: true };
  const avisos = [];
  const vigia = new VigiaSaude({
    servicos: { saude: async () => Object.fromEntries(Object.entries(online).map(([k, v]) => [k, { nome: k[0].toUpperCase() + k.slice(1), online: v }])) },
    automacao: { estado: () => ({ estado, componentes }), agindoDeVerdade: () => agindo },
    notificador: { notificar: async (a) => { avisos.push(a); return { ok: true }; } },
    fuso: 'America/Sao_Paulo', logger: loggerNulo, agora: () => agora,
  });
  const passar = async (min) => { agora += min * 60_000; await vigia.verificar(); };
  return { vigia, online, avisos, passar };
}

test('vigia: fora há mais de 5 min avisa uma vez; a volta avisa também', async () => {
  const { online, avisos, passar } = montar();
  online.rodizio = false;
  await passar(0);
  await passar(4);
  assert.equal(avisos.length, 0, 'antes dos 5 min, nada');
  await passar(1.5);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].nivel, 'erro');
  assert.match(avisos[0].titulo, /Rodizio fora do ar/i);
  assert.match(avisos[0].texto, /desde 10:00/);
  await passar(10);
  assert.equal(avisos.length, 1, 'não repete a cada volta do laço');
  online.rodizio = true;
  await passar(1);
  assert.equal(avisos.length, 2);
  assert.equal(avisos[1].nivel, 'info');
  assert.match(avisos[1].texto, /16 min/);
});

test('vigia: caiu e voltou antes dos 5 min, nenhum aviso', async () => {
  const { online, avisos, passar } = montar();
  online.roteador = false;
  await passar(0);
  await passar(3);
  online.roteador = true;
  await passar(1);
  assert.equal(avisos.length, 0);
});

test('vigia: o atualizador, a automação desligada, o componente desligado e o PC que não age não avisam', async () => {
  for (const caso of [{}, { estado: 'desligada' }, { agindo: false }, { componentes: { 'benura-rodizio': { desligado: true } } }]) {
    const { online, avisos, passar } = montar(caso);
    online.atualizador = false;
    if (Object.keys(caso).length) online.rodizio = false;
    await passar(0);
    await passar(10);
    assert.equal(avisos.length, 0, JSON.stringify(caso));
  }
});

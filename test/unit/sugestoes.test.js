'use strict';
/** [NOVO] Sugestões do relatório de 7 e 30 dias: comparam configurações só com dados suficientes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sugestoes, formatarSeg } = require('../../src/domain/sugestoes');

const cfg = (min, max, todos = 2) => ({ porLivre: 7, porStatus: { calma: { esperaS: 45, min, max }, normal: { esperaS: 90, min: 4, max: 10 } }, todosComLivresCalma: todos, tempoMin: 2 });
let n = 0;
/** Um dia completo: `opl` em segundos (livresMin × 60 ÷ derivações), com 4 h de calma. */
const dia = (config, opl, transbordos = 4, x = {}) => {
  n += 1;
  const d = new Date(Date.UTC(2026, 9, 1 + n)).toISOString().slice(0, 10);
  return { dia: d, derivacoes: 60, livresMin: opl, transbordos, calmaMin: 240, normalMin: 60, agressivaMin: 0, ...(config ? { config } : {}), ...x };
};

test('sem configuração guardada: só a mensagem de que está juntando dados', () => {
  const s = sugestoes([dia(null, 200), dia(null, 300)]);
  assert.equal(s.length, 1);
  assert.equal(s[0].tipo, 'progresso');
  assert.match(s[0].texto, /Juntando dados/);
});

test('menos de 3 dias com a configuração atual: não compara, mostra o progresso', () => {
  const s = sugestoes([dia(cfg(15, 15), 280), dia(cfg(15, 15), 280), dia(cfg(15, 15), 280), dia(cfg(20, 20), 190), dia(cfg(20, 20), 190)]);
  assert.ok(!s.some((x) => x.tipo === 'comparacao' || x.tipo === 'aviso'));
  const p = s.find((x) => x.tipo === 'progresso');
  assert.match(p.texto, /2 de 3 dias/);
  assert.match(p.texto, /calma/);
});

test('com 3 dias de cada lado: compara o OPL e os transbordos e diz qual foi melhor', () => {
  const s = sugestoes([
    ...[1, 2, 3, 4].map(() => dia(cfg(15, 15), 280, 5)),
    ...[1, 2, 3, 4, 5].map(() => dia(cfg(20, 20), 190, 4)),
  ]);
  const c = s.find((x) => x.tipo === 'comparacao');
  assert.ok(c, JSON.stringify(s));
  assert.match(c.texto, /Na calma, com 20 robôs por livre/);
  assert.match(c.texto, /3 min 10 s \(5 dias\)/);
  assert.match(c.texto, /4 min 40 s com 15 robôs por livre \(4 dias\)/, 'o "todos com 2 livres" igual não se repete');
  assert.match(c.texto, /4 contra 5 por dia/);
});

test('OPL melhor mas transbordos subindo mais de 30%: avisa e não aponta vencedor', () => {
  const s = sugestoes([
    ...[1, 2, 3].map(() => dia(cfg(15, 15), 280, 4)),
    ...[1, 2, 3].map(() => dia(cfg(20, 20), 190, 8)),
  ]);
  const a = s.find((x) => x.tipo === 'aviso');
  assert.ok(a, JSON.stringify(s));
  assert.match(a.texto, /transbordos subiram de 4 para 8 por dia/);
  assert.ok(!s.some((x) => x.tipo === 'comparacao'));
});

test('dias com pouco tempo no status (menos de 2 h) e o dia de hoje (parcial) não contam', () => {
  const s = sugestoes([
    ...[1, 2, 3].map(() => dia(cfg(15, 15), 280)),
    ...[1, 2].map(() => dia(cfg(20, 20), 190)),
    dia(cfg(20, 20), 100, 4, { calmaMin: 60 }),
    dia(cfg(20, 20), 100, 4, { hoje: true }),
  ]);
  assert.ok(!s.some((x) => x.tipo === 'comparacao'));
  assert.match(s.find((x) => x.tipo === 'progresso').texto, /2 de 3 dias/);
});

test('o "todos com N livres" da calma também separa as configurações', () => {
  const s = sugestoes([
    ...[1, 2, 3].map(() => dia(cfg(20, 20, 0), 280)),
    ...[1, 2, 3].map(() => dia(cfg(20, 20, 2), 190)),
  ]);
  const c = s.find((x) => x.tipo === 'comparacao');
  assert.match(c.texto, /todos os robôs com 2 livres/);
});

test('dia da semana com o OPL mais alto, só com pelo menos 2 semanas de dados', () => {
  const semana = (inicio, oplSexta) => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 9, inicio + i)).toISOString().slice(0, 10);
    const sexta = new Date(d).getUTCDay() === 5;
    return { dia: d, derivacoes: 60, livresMin: sexta ? oplSexta : 200, transbordos: 3, calmaMin: 0, normalMin: 300 };
  });
  assert.ok(!sugestoes(semana(5, 320)).some((x) => x.tipo === 'semana'), 'uma semana só não basta');
  const s = sugestoes([...semana(5, 320), ...semana(12, 320)]);
  const w = s.find((x) => x.tipo === 'semana');
  assert.ok(w, JSON.stringify(s));
  assert.match(w.texto, /sextas têm o OPL mais alto \(5 min 20 s/);
});

test('formatarSeg', () => {
  assert.equal(formatarSeg(45), '45 s');
  assert.equal(formatarSeg(190), '3 min 10 s');
  assert.equal(formatarSeg(240), '4 min');
});

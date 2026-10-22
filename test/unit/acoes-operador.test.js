'use strict';
/** [NOVO] Aba Receptivo como painel da URA: ações por atendente, trava manual e relatório por atendente. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { EstatisticasDia, limiteDaPausaMin } = require('../../src/rodizio/estatisticas-dia');
const { TravasManuais } = require('../../src/rodizio/travas-manuais');
const { RetencaoAtivo } = require('../../src/rodizio/retencao-ativo');
const { AcoesOperador, AcaoRecusada } = require('../../src/rodizio/acoes-operador');
const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
const { ArgusError } = require('../../src/integrations/argus/argus.client');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

const FUSO = 'America/Sao_Paulo';

/** URA: 201 (fixo), 202 livre há 4 min, 900 robô. Ativo (grupo 3): 301 e 302. */
function montar({ dryRun = false, recusar = null } = {}) {
  const avisos = [];
  const logger = { ...loggerNulo, aviso: (m) => avisos.push(m), info: (m) => avisos.push(m) };
  const transferidos = [];
  const transferencias = { transferir: async (ramal, grupo) => { transferidos.push(`${ramal}→${grupo}`); return true; } };
  const chamadas = [];
  const responde = (nome, extra = {}) => async (...args) => {
    chamadas.push([nome, ...args]);
    if (recusar === nome) throw new ArgusError('recusou', { comando: nome, resposta: { codStatus: 0, descStatus: 'Operador não logado' } });
    return { codStatus: 1, descStatus: 'Sucesso', ...extra };
  };
  const client = {
    listarPausas: async (r) => { chamadas.push(['listarpausas', r]); return [{ idPausa: 1, pausaDesc: 'ALMOÇO' }, { idPausa: 2, pausaDesc: 'BANHEIRO' }]; },
    pausar: responde('pausar'), sairPausa: responde('sairpausa'), ficarDisponivel: responde('ficardisponivel'),
    deslogarOperador: responde('deslogaroperador'),
    statusOperador: async () => ({ descricaoStatus: 'Pausa', descricaoPausa: 'ALMOÇO', idGrupo: 7, nome: 'Bruno', tempoStatus: 1000 }),
  };
  const travas = new TravasManuais({ arquivo: null, fusoHorario: FUSO, logger });
  const svc = new RodizioService({
    client, transferencias, robos: { situacao: () => ({ ligados: 0 }), resumo: () => ({ ligados: 0 }), ligados: new Set() },
    repositorio: { salvar: () => {} }, logger, travas, retencao: new RetencaoAtivo({ arquivo: null, logger }),
    estatisticas: new EstatisticasDia({ fusoHorario: FUSO }),
    cfg: {
      robosModo: 'panico', pollUraMs: 5000, tempoNaUraMs: 180_000, grupoUraId: 7, concorrencia: 2, gruposAtivosIds: [3], dryRun,
      descricoesStatus: { livres: ['livre'], atendimento: ['em atendimento'] },
    },
  });
  const agora = Date.now();
  svc.ramaisUra = new Set(['201', '202', '900']);
  svc.ramaisRobos = ['900'];
  svc.permanentes = new Set(['201']);
  svc.movidos['202'] = { origemGrupoId: 3, entrouEm: agora };
  svc.gruposAtivos = [{ idGrupoUsuario: 3, grupoUsuarioDesc: 'ATIVO JOÃO', ramaisOperadores: ['301', '302'] }];
  svc.statusUra.set('201', { classe: Classe.LIVRE, ts: agora, livreDesde: agora - 60_000, detalhe: { nome: 'Ana Fixa' } });
  svc.statusUra.set('202', { classe: Classe.LIVRE, ts: agora, livreDesde: agora - 4 * 60_000, detalhe: { nome: 'Bruno' } });
  svc.statusUra.set('900', { classe: Classe.LIVRE, ts: agora, livreDesde: agora, detalhe: { nome: 'OPER VIRTUAL 1' } });
  svc.avaliarRobos = async () => {};
  const acoes = new AcoesOperador({ client, rodizio: svc, cfg: { dryRun }, logger });
  return { svc, acoes, travas, chamadas, transferidos, avisos };
}

test('ações: cada uma chama o comando certo da Argus, loga quem pediu e relê o status de quem está na URA', async () => {
  const { acoes, chamadas, avisos, svc } = montar();
  assert.deepEqual(await acoes.pausasDisponiveis('202'), [{ idPausa: 1, pausaDesc: 'ALMOÇO' }, { idPausa: 2, pausaDesc: 'BANHEIRO' }]);
  await acoes.pausasDisponiveis('202');
  assert.equal(chamadas.filter(([n]) => n === 'listarpausas').length, 1, 'lista de pausas em cache');

  assert.deepEqual(await acoes.pausar('202', 1, 'ana@x.com'), { ok: true, simulado: false, descStatus: 'Sucesso' });
  assert.deepEqual(chamadas.at(-1), ['pausar', '202', 1]);
  assert.ok(avisos.some((m) => /Pausa ALMOÇO no ramal 202 pelo painel \(ana@x\.com\)/.test(m)));
  assert.equal(svc.statusUra.get('202').detalhe.pausa, 'ALMOÇO', 'status relido na hora');

  await acoes.sairPausa('202', 'ana');
  await acoes.ficarDisponivel('301', 'ana');
  await acoes.deslogar('301', 'ana');
  assert.deepEqual(chamadas.slice(-3).map(([n, r]) => `${n}:${r}`), ['sairpausa:202', 'ficardisponivel:301', 'deslogaroperador:301']);
});

test('ações: robô, operador virtual e ramal desconhecido são recusados; recusa da Argus vira 409', async () => {
  const { acoes, chamadas } = montar({ recusar: 'sairpausa' });
  await assert.rejects(acoes.pausar('900', 1), (e) => e instanceof AcaoRecusada && e.status === 400);
  await assert.rejects(acoes.deslogar('555'), /não é um atendente/);
  await assert.rejects(acoes.pausar('202', 'x'), /informe a pausa/);
  await assert.rejects(acoes.sairPausa('202'), (e) => e.status === 409 && /Operador não logado/.test(e.message));
  assert.equal(chamadas.filter(([n]) => n === 'pausar' || n === 'deslogaroperador').length, 0);
});

test('ações em DRY_RUN: não chamam a Argus (nem movem de verdade), só simulam', async () => {
  const { acoes, chamadas, avisos } = montar({ dryRun: true });
  assert.deepEqual(await acoes.pausar('202', 2, 'ana'), { ok: true, simulado: true });
  assert.deepEqual(await acoes.deslogar('202', 'ana'), { ok: true, simulado: true });
  assert.equal(chamadas.filter(([n]) => n !== 'listarpausas').length, 0);
  assert.ok(avisos.some((m) => /\[DRY_RUN\] Deslogar o ramal 202/.test(m)));
});

test('trava manual: mandar para o Ativo trava lá; o rodízio não traz de volta até liberarem', async () => {
  const { acoes, svc, travas, transferidos } = montar();
  assert.deepEqual(await acoes.mover('202', 'ativo', 'ana'), { ok: true, simulado: false, jaEstava: false });
  assert.deepEqual(transferidos, ['202→3']);
  assert.equal(travas.onde('202'), 'ativo');
  svc.vigiarNoAtivo('202', 3);
  assert.ok(!svc.operadoresDoAtivo().some((o) => o.ramal === '202'), 'o ciclo do Ativo não sobe quem está travado no Ativo');
  assert.equal(svc.noAtivoAgora().find((o) => o.ramal === '202').travado, 'ativo');

  assert.deepEqual(await acoes.liberar('202', 'ana'), { ok: true, estavaTravado: true });
  assert.ok(svc.operadoresDoAtivo().some((o) => o.ramal === '202'), 'liberado: o rodízio volta a decidir');
  await assert.rejects(acoes.mover('202', 'lua'), /ativo.*ura/);
});

test('trava manual: trazer para a URA trava lá; o ocioso não devolve e o "Alocar todos" pula', async () => {
  const { acoes, svc, travas, transferidos } = montar();
  await acoes.mover('301', 'ura', 'ana');
  assert.deepEqual(transferidos, ['301→7']);
  assert.equal(travas.onde('301'), 'ura');
  svc.statusUra.set('301', { classe: Classe.LIVRE, ts: Date.now(), livreDesde: Date.now() - 10 * 60_000, detalhe: { nome: 'Caio' } });
  assert.equal(svc.deveDevolver('301', Date.now()), false, 'travado na URA: ocioso não devolve');
  assert.equal(svc.deveDevolver('202', Date.now()), true, 'quem não está travado segue a regra');
  const r = await svc.transferirUraParaAtivo('ana');
  assert.deepEqual(r.ignorados.map((i) => `${i.ramal}:${i.motivo}`).sort(), ['201:fixo', '301:travado']);
});

test('trava manual: vale só no dia', async () => {
  const travas = new TravasManuais({ arquivo: null, fusoHorario: FUSO, logger: loggerNulo });
  await travas.travar('202', 'ativo', 'ana', new Date('2026-10-22T15:00:00Z'));
  assert.equal(travas.onde('202', new Date('2026-10-22T20:00:00Z')), 'ativo');
  assert.equal(travas.onde('202', new Date('2026-10-23T12:00:00Z')), null, 'virou o dia: liberada');
  await assert.rejects(travas.travar('202', 'lua'), /inválida/);
});

test('rotas: ramal no corpo, erros viram 400/409/502 e a lista de pausas é POST', async () => {
  const { acoes } = montar({ recusar: 'pausar' });
  const rotas = criarRotasDoRodizio({ rodizio: { resumo: () => ({}) }, acoes, ciclos: {}, logger: loggerNulo });
  const rota = (caminho) => rotas.find((r) => r.caminho === caminho && r.metodo === 'POST');
  for (const c of ['pausas', 'pausar', 'sair-pausa', 'ficar-disponivel', 'deslogar', 'mover', 'liberar']) {
    assert.equal(rota(`/operadores/${c}`).protegida, true, c);
  }
  assert.deepEqual((await rota('/operadores/pausas').handler({ corpo: { ramal: '202' } })).corpo.pausas.length, 2);
  assert.equal((await rota('/operadores/pausar').handler({ corpo: { ramal: '202', idPausa: 1 } })).status, 409);
  assert.equal((await rota('/operadores/deslogar').handler({ corpo: {} })).status, 400);
  acoes.client.ficarDisponivel = async () => { throw new Error('timeout'); };
  assert.equal((await rota('/operadores/ficar-disponivel').handler({ corpo: { ramal: '202' } })).status, 502);
});

test('relatório por atendente: soma livre, atendimento, outro e pausa; conta atendimentos e a pausa estourada uma vez', () => {
  const e = new EstatisticasDia({ fusoHorario: FUSO });
  const t0 = new Date('2026-10-22T13:00:00Z').getTime();
  const amostra = (t, ops) => e.amostrar(t, { livres: 1, robosLigados: 0, operadores: ops });
  amostra(t0, [{ ramal: '202', nome: 'Bruno', classe: 'livre', livreDesde: t0 - 30_000 }]);
  amostra(t0 + 20_000, [{ ramal: '202', nome: 'Bruno', classe: 'livre', livreDesde: t0 - 30_000 }]);
  e.registrarDerivacao(t0 + 20_000, '202');
  amostra(t0 + 40_000, [{ ramal: '202', nome: 'Bruno', classe: 'atendimento' }]);
  const inicioPausa = t0 + 40_000 - 6 * 60_000; // banheiro (limite 5 min) já há 6 min
  amostra(t0 + 60_000, [{ ramal: '202', classe: 'outro', pausa: 'BANHEIRO', statusDesde: inicioPausa }]);
  amostra(t0 + 80_000, [{ ramal: '202', classe: 'outro', pausa: 'BANHEIRO', statusDesde: inicioPausa }]);
  amostra(t0 + 100_000, [{ ramal: '202', classe: 'outro', pausa: null }, { ramal: '203', classe: 'offline' }]);
  const [a, ...resto] = e.resumo().porAtendente;
  assert.equal(resto.length, 0, 'offline não entra');
  assert.deepEqual(
    [a.ramal, a.nome, a.livreMin, a.atendimentoMin, a.pausaMin, a.pausasMin.BANHEIRO, a.outroMin, a.atendimentos, a.pausasEstouradas, a.maiorEsperaSeg],
    ['202', 'Bruno', 0.3, 0.3, 0.7, 0.7, 0.3, 1, 1, 50],
  );
  assert.equal(a.primeiroEm, new Date(t0).toISOString());
  assert.equal(a.pausaPct, 40);
});

test('limite da pausa: casa pelo começo do nome, sem acento nem maiúscula', () => {
  assert.equal(limiteDaPausaMin('ALMOCO 1'), 60);
  assert.equal(limiteDaPausaMin('Banheiro'), 5);
  assert.equal(limiteDaPausaMin('TREINAMENTO'), null);
});

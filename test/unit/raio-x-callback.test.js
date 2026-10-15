'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { raioXDoCallback, instanteLocal, Conclusao } = require('../../src/domain/raio-x-callback');
const { Classe, interpretarCallback } = require('../../src/domain/rodizio');
const { VigiaCallbacks } = require('../../src/rodizio/vigia-callbacks');
const { loggerNulo } = require('../../src/utils/logger');

const FUSO = 'America/Sao_Paulo';
const T = (hhmmss) => instanteLocal(`2026-10-15T${hhmmss}`, FUSO);
const URA = 7;
const foto = (hhmmss, ura, robos = { ligados: 7, alvo: 7 }) => ({ ts: T(hhmmss), robos, ura });
const op = (ramal, classe, extra = {}) => ({ ramal, nome: null, classe, grupo: URA, emCarencia: false, trocouEm: null, movidoEm: null, ...extra });

test('instanteLocal: hora do relatório (local, sem offset) no fuso; formato brasileiro também', () => {
  assert.equal(new Date(T('08:42:18')).toISOString(), '2026-10-15T11:42:18.000Z');
  assert.equal(instanteLocal('15/10/2026 08:42:18', FUSO), T('08:42:18'));
  assert.equal(instanteLocal('2026-10-15 08:42', FUSO), T('08:42:00'));
  assert.equal(instanteLocal('ontem', FUSO), null);
  assert.equal(instanteLocal(null, FUSO), null);
});

test('raio-x: caso da Jamily (15/10) — livre só na carência da troca de grupo', () => {
  const jamily = (classe, carencia) => op('2266423', classe, { nome: 'Jamily', emCarencia: carencia, trocouEm: T('08:41:41'), movidoEm: T('08:41:04') });
  const r = raioXDoCallback({
    fotos: [foto('08:42:10', [jamily(Classe.LIVRE, true)]), foto('08:42:30', [jamily(Classe.LIVRE, true)]), foto('08:42:50', [jamily(Classe.LIVRE, false)])],
    inicio: T('08:42:18'), fim: T('08:42:52'), grupoUraId: URA, fuso: FUSO, robo: 'Oper Virtual 11',
  });
  assert.equal(r.conclusao, Conclusao.CARENCIA);
  assert.match(r.linha, /^CALLBACK 08:42:18 Oper Virtual 11, 34 s \| livre ainda na carência/);
  assert.match(r.linha, /2266423 Jamily \(grupo 7, telefonia na URA há \d+ s, movido pelo BenURA às 08:41:04, carência\)/);
  assert.match(r.linha, /robôs 7\/7$/);
});

test('raio-x: livre útil o tempo todo = INVISÍVEL; o livre atendeu outra = derivações juntas; ninguém = URA sem livre', () => {
  const base = { inicio: T('09:00:00'), fim: T('09:00:40'), grupoUraId: URA, fuso: FUSO };
  const invisivel = raioXDoCallback({ ...base, fotos: [foto('09:00:05', [op('1', Classe.LIVRE)]), foto('09:00:35', [op('1', Classe.LIVRE)])] });
  assert.equal(invisivel.conclusao, Conclusao.INVISIVEL);

  const juntas = raioXDoCallback({ ...base, fotos: [foto('09:00:05', [op('1', Classe.LIVRE)]), foto('09:00:20', [op('1', Classe.ATENDIMENTO)])] });
  assert.equal(juntas.conclusao, Conclusao.DERIVACOES_JUNTAS);
  assert.match(juntas.linha, /às 09:00:20: livres nenhum \| em atendimento: 1/);

  const semLivre = raioXDoCallback({ ...base, fotos: [foto('09:00:05', [op('1', Classe.LIVRE)]), foto('09:00:20', [op('1', Classe.OUTRO)])] });
  assert.equal(semLivre.conclusao, Conclusao.URA_SEM_LIVRE);

  const outroGrupo = raioXDoCallback({ ...base, fotos: [foto('09:00:05', [op('1', Classe.LIVRE, { grupo: 9 })])] });
  assert.notEqual(outroGrupo.conclusao, Conclusao.INVISIVEL, 'telefonia em outro grupo não é livre útil');

  const semFoto = raioXDoCallback({ ...base, fotos: [foto('08:00:00', [op('1', Classe.LIVRE)])] });
  assert.equal(semFoto.conclusao, Conclusao.SEM_HISTORICO);
  assert.equal(semFoto.fotos, 0);
});

test('webhook e relatório usam a mesma chave (idLigacao): o callback não conta duas vezes', () => {
  const webhook = interpretarCallback({ idTipoWebhook: 5, idConclusaoDerivacao: 2, idLigacao: 99, telefone: '11999990000' });
  assert.equal(webhook.chave, 'ligacao:99');
  assert.ok(!webhook.chave.includes('1199999'), 'telefone fora da chave quando há idLigacao');
});

test('vigia: só lê com robô ligado; a 1ª leitura só marca; callback novo vai uma vez, sem dado de cliente', async () => {
  let ligacoes = [{ idLigacao: 1, dataHoraLigacao: '2026-10-15T08:30:00', resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA', tempoSegundos: 30, dddTelefone: '11999990000' }];
  const pedidos = [];
  const entregues = [];
  let roboLigado = false;
  const vigia = new VigiaCallbacks({
    client: {
      listarCampanhas: async () => [{ idCampanha: 3, ativo: true }],
      ligacoesDetalhadas: async (filtro) => { pedidos.push(filtro); return ligacoes; },
    },
    rodizio: { teveRoboLigado: () => roboLigado, registrarCallbackDoRelatorio: (c) => entregues.push(c) },
    cfg: { gruposRobosIds: [3], fuso: FUSO },
    logger: loggerNulo,
  });

  await vigia.verificar();
  assert.equal(pedidos.length, 0, 'sem robô ligado, não lê');
  roboLigado = true;
  await vigia.verificar();
  assert.deepEqual(pedidos[0], { idCampanha: 3, idGrupoUsuario: 3, ultimosMinutos: 5 });
  assert.equal(entregues.length, 0, 'callback de antes de vigiar não conta');

  ligacoes = [...ligacoes,
    { idLigacao: 2, usuarioOperador: 'Oper Virtual 11', dataHoraLigacao: '2026-10-15T08:42:18', resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA', tempoSegundos: 34, dddTelefone: '11988887777' },
    { idLigacao: 3, dataHoraLigacao: '2026-10-15T08:43:00', resultadoLigacao: 'ATENDIMENTO', tempoSegundos: 60 }];
  await vigia.verificar();
  await vigia.verificar();
  assert.equal(entregues.length, 1);
  assert.deepEqual(entregues[0], {
    motivo: 'oper. virtual - abandono em fila', chave: 'ligacao:2', inicio: T('08:42:18'), fim: T('08:42:52'), robo: 'Oper Virtual 11',
  });
  assert.ok(!JSON.stringify(entregues).includes('1198888'));
});

test('vigia: relatório fora do ar avisa uma vez e não derruba o ciclo', async () => {
  const avisos = [];
  const vigia = new VigiaCallbacks({
    client: { listarCampanhas: async () => [{ idCampanha: 3 }], ligacoesDetalhadas: async () => { throw new Error('HTTP 500'); } },
    rodizio: { teveRoboLigado: () => true, registrarCallbackDoRelatorio: () => {} },
    cfg: { gruposRobosIds: [3], fuso: FUSO },
    logger: { ...loggerNulo, aviso: (m) => avisos.push(m) },
  });
  await vigia.verificar();
  await vigia.verificar();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /HTTP 500/);
});

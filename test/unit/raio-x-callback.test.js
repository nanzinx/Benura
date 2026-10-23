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

test('vigia: reinício logo depois de um callback — a 1ª leitura entrega o que começou depois de o BenURA subir', async () => {
  const ligacao = (id, hora) => ({ idLigacao: id, dataHoraLigacao: `2026-10-15T${hora}`, resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA', tempoSegundos: 30 });
  const entregues = [];
  const vigia = new VigiaCallbacks({
    client: { listarCampanhas: async () => [{ idCampanha: 3 }], ligacoesDetalhadas: async () => [ligacao(1, '09:44:00'), ligacao(2, '09:46:56')] },
    rodizio: { iniciadoEm: T('09:46:30'), teveRoboLigado: () => true, registrarCallbackDoRelatorio: (c) => entregues.push(c) },
    cfg: { gruposRobosIds: [6], fuso: FUSO },
    logger: loggerNulo,
  });
  await vigia.verificar();
  assert.deepEqual(entregues.map((c) => c.chave), ['ligacao:2'], 'o de antes de subir não conta; o de depois sim');
  await vigia.verificar();
  assert.equal(entregues.length, 1, 'não repete');
});

test('[NOVO] vigia: leads derivados e transbordos pelo relatório; lê o dia desde 00:00 ao subir; não conta em dobro', async () => {
  const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');
  const agora = T('10:13:00');
  const gravado = {};
  const repositorio = { carregar: () => gravado.estado, salvar: (e) => { gravado.estado = JSON.parse(JSON.stringify(e)); } };
  const montar = () => new EstatisticasDia({ repositorio, fusoHorario: FUSO }).carregar(agora);
  let estatisticas = montar();
  const ligacoes = [
    { idLigacao: 10, dataHoraLigacao: '2026-10-15T08:01:00', resultadoLigacao: 'ATENDIMENTO' },
    { idLigacao: 11, dataHoraLigacao: '2026-10-15T08:05:00', resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA' },
    { idLigacao: 12, dataHoraLigacao: '2026-10-15T09:10:00', resultadoLigacao: 'SEM AGENTE' },
    { idLigacao: 13, dataHoraLigacao: '2026-10-15T09:20:00', resultadoLigacao: 'OPER. VIRTUAL - ABANDONO' },
  ];
  const pedidos = [];
  const entregues = [];
  const montarVigia = () => new VigiaCallbacks({
    client: { listarCampanhas: async () => [{ idCampanha: 3, ativo: true }], ligacoesDetalhadas: async (f, o = {}) => { pedidos.push({ ...f, maxPaginas: o.maxPaginas }); if (o.aoReceber) { o.aoReceber(ligacoes); return []; } return ligacoes; } },
    rodizio: {
      teveRoboLigado: () => false,
      registrarCallbackDoRelatorio: (c) => entregues.push(c),
      registrarEncerramentoDoRelatorio: (e) => estatisticas.registrarEncerramento(agora, e, 'relatório'),
    },
    cfg: { gruposRobosIds: [3], fuso: FUSO },
    logger: loggerNulo,
  });
  const vigia = montarVigia();
  await vigia.verificar(agora);
  assert.deepEqual(pedidos[0], { idCampanha: 3, idGrupoUsuario: 3, ultimosMinutos: 10 * 60 + 13 + 1, maxPaginas: 200 }, 'desde 00:00, mesmo sem robô ligado');
  assert.equal(entregues.length, 0, 'o dia antigo não vira ajuste nem raio-x');
  let r = estatisticas.resumo();
  assert.deepEqual([r.leadsDerivados, r.transbordos, r.transbordosPorMotivo], [1, 2, { 'abandonou a fila': 1, 'sem agente': 1 }]);
  assert.deepEqual(r.ultimoEncerramento, { em: new Date(T('09:10:00')).toISOString(), fonte: 'relatório' });
  assert.deepEqual(r.horas.map((h) => [h.hora, h.leadsDerivados, h.transbordos]), [['08', 1, 1], ['09', 0, 1]], 'na hora da ligação');

  await vigia.verificar(agora);
  assert.equal(pedidos.length, 1, 'o dia só é lido uma vez');
  assert.equal(estatisticas.registrarEncerramento(agora, { chave: 'ligacao:10', derivou: true, motivo: 'derivou', filaSeg: 5 }, 'webhook'), false, 'o webhook da mesma ligação não conta de novo');

  estatisticas.gravar(agora);
  estatisticas = montar(); // reinício: relê o dia e não conta em dobro
  await montarVigia().verificar(agora);
  r = estatisticas.resumo();
  assert.deepEqual([r.leadsDerivados, r.transbordos], [1, 2]);
});

test('[NOVO] vigia: o dia com dezenas de milhares de ligações não estoura a pilha; falhou, só tenta de novo em 5 min', async () => {
  const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');
  const agora = T('13:05:00');
  const estatisticas = new EstatisticasDia({ fusoHorario: FUSO }).carregar(agora);
  const pagina = (n, desde) => Array.from({ length: n }, (_, i) => ({
    idLigacao: desde + i, dataHoraLigacao: '2026-10-15T09:00:00', resultadoLigacao: i % 100 === 0 ? 'ATENDIMENTO' : 'OPER. VIRTUAL - ABANDONO',
  }));
  let falhar = true;
  let pedidosDoDia = 0;
  const avisos = [];
  const vigia = new VigiaCallbacks({
    client: {
      listarCampanhas: async () => [{ idCampanha: 3, ativo: true }],
      ligacoesDetalhadas: async (f, { aoReceber } = {}) => {
        if (aoReceber) pedidosDoDia += 1;
        if (aoReceber && falhar) throw new Error('HTTP 500');
        if (aoReceber) { for (let p = 0; p < 3; p += 1) aoReceber(pagina(60_000, p * 60_000)); return []; }
        return [];
      },
    },
    rodizio: { teveRoboLigado: () => false, registrarCallbackDoRelatorio: () => {}, registrarEncerramentoDoRelatorio: (e) => estatisticas.registrarEncerramento(agora, e, 'relatório') },
    cfg: { gruposRobosIds: [3], fuso: FUSO },
    logger: { ...loggerNulo, aviso: (m) => avisos.push(m) },
  });
  await vigia.verificar(agora);
  assert.match(avisos[0], /não foi possível ler o dia desde 00:00 \(HTTP 500\)\. Tenta de novo em 5 min/);
  falhar = false;
  await vigia.verificar(agora + 60_000);
  assert.equal(pedidosDoDia, 1, 'antes de 5 min não tenta de novo');
  await vigia.verificar(agora + 5 * 60_000);
  assert.equal(pedidosDoDia, 2);
  assert.equal(estatisticas.resumo().leadsDerivados, 1800, '180.000 ligações lidas, 1 em cada 100 derivou');
});

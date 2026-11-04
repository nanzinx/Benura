'use strict';
/** [NOVO] Diagnóstico de ligações derivadas mudas ou que caem no pós-chamada: cruza a Argus com os logs do BenURA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { lerEventosDoLog, cruzar } = require('../../src/domain/diagnostico-mudas');

const LOG = [
  '08:00:00 === npm run rodizio ===',
  '09:00:05 [INFO] [rodizio] ATIVO→URA ramal=1004 origem=3',
  '09:10:00 [INFO] [rodizio] URA→ATIVO ramal=1004 destino=3 (motivo: livre há 3 min)',
  '09:20:00 [INFO] [rodizio] Ramal 1005 relogado no grupo 7 (estava logado em "MAYSA - COMERCIAL" (3)).',
  '09:30:00 [AVISO] [rodizio] Ramal 1006 → URA à mão pelo painel (Ana): o rodízio não mexe nele até liberarem.',
  '09:40:00 [INFO] [rodizio] Ramal 1007: telefonia na URA; conta como livre para os robôs em 15 s.',
  '09:50:00 [INFO] [robos] ROBÔS AUMENTADOS para 40 (URA calma com 1 livre: 40 robôs): +33/33 | ligados agora: 40',
  '09:51:00 [INFO] [robos] ROBÔS AUMENTADOS para 9 (2 livre(s) na URA × 4): +2/2 | ligados agora: 9',
  '09:55:00 [INFO] [rodizio] [DRY_RUN] Transferiria ramal 1008 → grupo 7',
  'linha qualquer sem hora',
];

test('eventos do log: troca de grupo, relogin, à mão, telefonia na URA e rajada de robôs (DRY_RUN e o resto ficam de fora)', () => {
  const ev = lerEventosDoLog(LOG);
  assert.deepEqual(ev.map((e) => [e.hora, e.tipo, e.ramal]), [
    ['09:00:05', 'paraUra', '1004'],
    ['09:10:00', 'paraAtivo', '1004'],
    ['09:20:00', 'relogin', '1005'],
    ['09:30:00', 'aMao', '1006'],
    ['09:40:00', 'telefoniaNaUra', '1007'],
    ['09:50:00', 'rajada', null],
  ]);
  assert.equal(ev[5].robos, 33, '+33 robôs de uma vez');
  assert.ok(!ev.some((e) => e.hora === '09:51:00'), '+2 não é rajada (menos de 10)');
  assert.equal(lerEventosDoLog(LOG, { rajadaMin: 2 }).filter((e) => e.tipo === 'rajada').length, 2);
});

const lig = (hora, operador, tempoSegundos, extra = {}) => ({
  dataHoraLigacao: `2026-11-03T${hora}`, usuarioOperador: operador, tempoSegundos, resultadoLigacao: 'ATENDIMENTO',
  nomeCliente: 'CLIENTE TESTE', dddTelefone: '11999990000', cpfCnpj: '123', ...extra,
});
const ramalPorNome = (nome) => ({ 'ANA SOUZA': '1004', 'BIA LIMA': '1005', 'CAIO': '1009' }[nome] ?? null);

test('cruzar: a ligação curta com troca de grupo ou relogin do mesmo ramal por perto; as normais como base; sem dado de cliente', () => {
  const eventos = lerEventosDoLog(LOG);
  const ligacoes = [
    lig('09:00:12', 'ANA SOUZA', 3), // curta, 7 s depois de subir para a URA
    lig('09:20:10', 'BIA LIMA', 0, { resultadoLigacao: 'POS-CHAMADA' }), // curta, 10 s depois do relogin
    lig('09:25:00', 'CAIO', 2), // curta, sem nada por perto
    lig('09:50:05', 'CAIO', 1), // curta, na rajada de robôs
    lig('09:10:10', 'ANA SOUZA', 300), // normal, perto da volta ao Ativo
    lig('10:00:00', 'BIA LIMA', 200), // normal, nada por perto
    lig('10:05:00', 'SEM CADASTRO', 1), // curta, sem ramal
  ];
  const r = cruzar({ ligacoes, eventos, ramalPorNome, ateSeg: 15, janelaSeg: 20 });

  assert.deepEqual(r.curtas, { total: 5, comEventoDoRamal: 2, naRajada: 1, semRamal: 1, porTipo: { paraUra: 1, relogin: 1 } });
  assert.deepEqual(r.normais, { total: 2, comEventoDoRamal: 1, naRajada: 0, semRamal: 0, porTipo: { paraAtivo: 1 } });
  assert.deepEqual(r.resultadosDasCurtas, { ATENDIMENTO: 4, 'POS-CHAMADA': 1 });
  assert.deepEqual(r.lista.map((l) => [l.hora, l.ramal, l.tempoSegundos, l.eventos.map((e) => `${e.tipo} ${e.difSeg}`)]), [
    ['09:00:12', '1004', 3, ['paraUra -7']],
    ['09:20:10', '1005', 0, ['relogin -10']],
    ['09:25:00', '1009', 2, []],
    ['09:50:05', '1009', 1, ['rajada -5']],
    ['10:05:00', null, 1, []],
  ]);
  assert.doesNotMatch(JSON.stringify(r), /CLIENTE TESTE|11999990000|cpfCnpj/, 'sem dado de cliente');
});

test('cruzar: fora da janela não conta; evento depois da ligação conta com diferença positiva', () => {
  const eventos = lerEventosDoLog(LOG);
  const r = cruzar({ ligacoes: [lig('09:00:30', 'ANA SOUZA', 2), lig('09:09:50', 'ANA SOUZA', 2)], eventos, ramalPorNome, ateSeg: 15, janelaSeg: 20 });
  assert.deepEqual(r.lista.map((l) => l.eventos.map((e) => `${e.tipo} ${e.difSeg}`)), [[], ['paraAtivo 10']]);
});

test('leitura: muito mais evento nas curtas que nas normais aponta o BenURA; parecido aponta a Argus ou a rede', () => {
  const { leitura } = require('../../src/domain/diagnostico-mudas');
  assert.match(leitura({ curtas: { total: 40, comEventoDoRamal: 17 }, normais: { total: 300, comEventoDoRamal: 6 } }), /BenURA provavelmente/);
  assert.match(leitura({ curtas: { total: 40, comEventoDoRamal: 2 }, normais: { total: 300, comEventoDoRamal: 12 } }), /Argus, na operadora ou na rede/);
  assert.match(leitura({ curtas: { total: 0, comEventoDoRamal: 0 }, normais: { total: 3, comEventoDoRamal: 0 } }), /Nenhuma ligação curta/);
});

test('script: lê a Argus (só o dia de hoje), o nome → ramal e os logs de hoje; nome repetido fica sem ramal', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { diagnosticarMudas, mapaDeRamais } = require('../../scripts/diagnostico-mudas');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'mudas-'));
  fs.mkdirSync(path.join(pasta, '2026-11-03'));
  fs.writeFileSync(path.join(pasta, '2026-11-03', 'rodizio.txt'), LOG.join('\n'));
  const pedidos = [];
  const client = {
    listarCampanhas: async () => [{ idCampanha: 3, campanhaDesc: 'X', ativo: true }],
    listarUsuarios: async () => [{ nome: 'Ana Souza', ramal: '1004' }, { nome: 'Bia Lima', ramal: '1005' }],
    ligacoesDetalhadas: async (filtro) => {
      pedidos.push(filtro);
      return [lig('09:00:12', 'ANA SOUZA', 3), lig('09:20:10', 'BIA LIMA', 1), { ...lig('09:00:12', 'ANA SOUZA', 3), dataHoraLigacao: '2026-11-02T09:00:12' }];
    },
  };
  const r = await diagnosticarMudas({ client, grupoUraId: 7, minutos: 600, pastaLogs: pasta, dia: '2026-11-03' });
  assert.deepEqual(pedidos, [{ idCampanha: 3, idGrupoUsuario: 7, ultimosMinutos: 600 }]);
  assert.equal(r.curtas.total, 2, 'a de ontem fica de fora');
  assert.deepEqual(r.curtas.porTipo, { paraUra: 1, relogin: 1 });
  assert.equal(r.eventosNoLog, 6);

  const ramal = mapaDeRamais([{ nome: 'Joao', ramal: '1' }, { nome: 'JOÃO', ramal: '2' }, { nome: 'Maria', ramal: '3' }]);
  assert.equal(ramal('joão'), null, 'dois ramais com o mesmo nome: não chuta');
  assert.equal(ramal('MARIA'), '3');
});

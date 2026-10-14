'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { resumirLigacoes, semDadosDeCliente, minutosDesdeMeiaNoite, minutoDoDia } = require('../../src/domain/diagnostico-callbacks');
const { ArgusClient } = require('../../src/integrations/argus/argus.client');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Classe } = require('../../src/domain/rodizio');
const { diagnosticar } = require('../../scripts/diagnostico-callbacks');
const { loggerNulo } = require('../../src/utils/logger');

/** Ligação no formato real do relatório (campos vistos em produção), com dados de cliente que não podem sair. */
const ligacao = (resultado, hora = '09:03:12', extra = {}) => ({
  idLigacao: 1, idLote: 9, lote: 'EXPORTAR-INSS-B', nrLead: 555, codCliente: 'C1', nomeCliente: 'CLIENTE TESTE', cpfCnpj: '00000000000',
  dddTelefone: '11987654321', camposCRM: [{ campo: 'CPF', valor: '00000000000' }], historico: 'ligou para CLIENTE TESTE',
  usuarioOperador: 'Oper Virtual 11', dataHoraLigacao: `2026-10-14T${hora}`, resultadoLigacao: resultado,
  statusAtendimento: '', tempoSegundos: 42, ...extra,
});

test('diagnóstico: nenhum dado de cliente sai do resumo (nem camposCRM e histórico)', () => {
  const limpa = semDadosDeCliente(ligacao('ATENDIMENTO'));
  for (const campo of ['nrLead', 'codCliente', 'nomeCliente', 'cpfCnpj', 'dddTelefone', 'camposCRM', 'historico']) {
    assert.ok(!(campo in limpa), `${campo} não pode sair`);
  }
  assert.equal(limpa.usuarioOperador, 'Oper Virtual 11', 'o robô continua (é operador, não cliente)');
  assert.ok(!('x' in semDadosDeCliente({ x: { cpf: '1' } })), 'objeto aninhado nunca sai');
});

test('diagnóstico: "abandono em fila" e "sem agente" são os callbacks; "ATENDIMENTO" é o derivou', () => {
  const r = resumirLigacoes([
    ligacao('OPER. VIRTUAL - ABANDONO EM FILA', '09:03:12'), ligacao('SEM AGENTE', '09:04:00'),
    ligacao('ATENDIMENTO', '09:20:00'), ligacao('OPER. VIRTUAL - ABANDONO', '09:21:00'), ligacao('CAIXA POSTAL / MSG', '09:22:00'),
  ]);
  assert.equal(r.total, 5);
  assert.equal(r.resultados.resultadoLigacao['SEM AGENTE'], 1);
  assert.equal(r.callbacks.length, 2);
  assert.deepEqual(r.callbacks[0], {
    idLigacao: 1, usuarioOperador: 'Oper Virtual 11', dataHoraLigacao: '2026-10-14T09:03:12',
    resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA', tempoSegundos: 42,
  });
  assert.deepEqual(r.linhaDoTempo, [
    { janela: '09:00', total: 2, callback: 2, derivou: 0, abandonoNaUra: 0 },
    { janela: '09:15', total: 3, callback: 0, derivou: 1, abandonoNaUra: 1 },
  ]);
  assert.ok(!JSON.stringify(r).includes('CLIENTE TESTE'));
  assert.ok(!JSON.stringify(r).includes('00000000000'));
});

test('diagnóstico: hora da ligação em ISO ou no formato brasileiro', () => {
  assert.equal(minutoDoDia('2026-10-14T09:03:12'), 543);
  assert.equal(minutoDoDia('2026-10-14 09:03'), 543);
  assert.equal(minutoDoDia('14/10/2026 09:03:12'), 543);
  assert.equal(minutoDoDia('2026-10-14'), null);
});

test('diagnóstico: "ultimosMinutos" cobre o dia desde a meia-noite', () => {
  assert.equal(minutosDesdeMeiaNoite('09:14'), 554);
  assert.equal(minutosDesdeMeiaNoite('00:00'), 1);
});

test('ArgusClient.ligacoesDetalhadas: /apiargus/report e paginação até endOfTable', async () => {
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const dados = JSON.parse(corpo);
      recebidas.push({ url: req.url, dados });
      const primeira = !dados.ultimoId;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        codStatus: 1, endOfTable: !primeira, idProxPagina: primeira ? 77 : 0, ligacoesDetalhadas: [{ idLigacao: primeira ? 1 : 2 }],
      }));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/apiargus`;
    const client = new ArgusClient({ baseUrl: `${base}/cmd`, baseMailing: base, token: 'tk', timeoutMs: 2000, tentativas: 1 }, loggerNulo);
    const ligacoes = await client.ligacoesDetalhadas({ idCampanha: 1, idGrupoUsuario: 6, ultimosMinutos: 60 });
    assert.deepEqual(ligacoes.map((l) => l.idLigacao), [1, 2]);
    assert.deepEqual(recebidas.map((r) => r.url), ['/apiargus/report/ligacoesdetalhadas', '/apiargus/report/ligacoesdetalhadas']);
    assert.equal(recebidas[1].dados.ultimoId, 77);
    assert.equal(recebidas[1].dados.idGrupoUsuario, 6);
  } finally {
    servidor.close();
  }
});

test('diagnosticar: usa a única campanha ativa; com várias, pede --campanha', async () => {
  const pedidos = [];
  const client = (campanhas) => ({
    listarCampanhas: async () => campanhas,
    ligacoesDetalhadas: async (filtro) => { pedidos.push(filtro); return [ligacao('SEM AGENTE')]; },
  });
  const r = await diagnosticar({ client: client([{ idCampanha: 4, ativo: true }, { idCampanha: 5, ativo: false }]), gruposRobos: [6], minutos: 30 });
  assert.equal(r.idCampanha, 4);
  assert.deepEqual(pedidos, [{ idCampanha: 4, idGrupoUsuario: 6, ultimosMinutos: 30 }]);
  assert.equal(r.porGrupo[6].callbacks.length, 1);

  const duas = client([{ idCampanha: 4, campanhaDesc: 'A' }, { idCampanha: 5, campanhaDesc: 'B' }]);
  await assert.rejects(diagnosticar({ client: duas, gruposRobos: [6], minutos: 30 }), /--campanha/);
  assert.equal((await diagnosticar({ client: duas, gruposRobos: [6], minutos: 30, campanha: '5' })).idCampanha, 5);
});

test('linha do tempo da URA: uma linha só quando o número de livres muda', () => {
  const linhas = [];
  const svc = new RodizioService({
    client: {}, transferencias: {}, repositorio: {}, cfg: {},
    robos: { situacao: () => ({ ligados: 14 }) },
    logger: { ...loggerNulo, info: (m) => linhas.push(m) },
  });
  svc.ramaisUra = new Set(['201', '202', '203']);
  svc.statusUra.set('201', { classe: Classe.LIVRE }).set('202', { classe: Classe.ATENDIMENTO }).set('203', { classe: Classe.OFFLINE });

  svc.ultimosLivres = 2;
  svc.registrarMudancaDeLivres(1, 7);
  svc.ultimosLivres = 1;
  svc.registrarMudancaDeLivres(1, 7);
  assert.deepEqual(linhas, ['URA: livres 2→1 | humanos 2 | robôs ligados 14 (alvo 7)']);
});

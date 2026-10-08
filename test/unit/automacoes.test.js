'use strict';
/** Rodada de automações Argus: retorno de quem desistiu da fila e fim de expediente limpo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Acao, normalizarTelefone, codClienteDoRetorno, interpretarEncerramentoUra, jaTemRetorno, limparExpirados, montarLead,
} = require('../../src/domain/retorno-fila');
const {
  Situacao, horarioComMargem, deveExecutar, operadoresParaVerificar, quemFicouLogado,
} = require('../../src/domain/fim-expediente');
const { Classe } = require('../../src/domain/rodizio');
const { RetornoFilaService, Resultado } = require('../../src/retorno-fila/retorno-fila.service');
const { FimExpedienteService } = require('../../src/rotinas/fim-expediente.service');
const { ArgusMockClient } = require('../../src/integrations/argus/argus.mock-client');
const { NotificadorLog } = require('../../src/notificacoes/notificador-log');
const { loggerNulo } = require('../../src/utils/logger');

const HORA = 3_600_000;
const DESC = { livres: ['livre'], atendimento: ['em atendimento'] };
const abandono = (extra = {}) => ({ idTipoWebhook: 5, idConclusaoDerivacao: 2, telefone: '5511987654321', ...extra });

/** Repositório e trilha em memória. */
function memoria(inicial = {}) {
  const repo = { estado: inicial, carregar: () => structuredClone(repo.estado), salvar: async (e) => { repo.estado = e; } };
  const trilha = { eventos: [], registrar: async (acao, dados) => { trilha.eventos.push({ acao, ...dados }); } };
  return { repo, trilha };
}

// ───────────── Retorno da fila: regras puras ─────────────

test('normalizarTelefone: aceita DDD + número, remove 55 e zeros, recusa inválidos', () => {
  assert.equal(normalizarTelefone('+55 (11) 98765-4321'), '11987654321');
  assert.equal(normalizarTelefone('011987654321'), '11987654321');
  assert.equal(normalizarTelefone('1133334444'), '1133334444');
  assert.equal(normalizarTelefone('anonymous'), null);
  assert.equal(normalizarTelefone('12345'), null);
  assert.equal(normalizarTelefone('9999999999'), null);
  assert.equal(normalizarTelefone(undefined), null);
});

test('interpretarEncerramentoUra: abandono, sem agente e time-out viram retorno', () => {
  const d = interpretarEncerramentoUra(abandono({ servicoDesc: 'CONSIGNADO', dataInicioUra: '2026-10-08T10:00:00' }));
  assert.deepEqual(d, {
    acao: Acao.INCLUIR, telefone: '11987654321', motivo: 'ABANDONOU_FILA', servico: 'CONSIGNADO',
    quando: '2026-10-08T10:00:00', foraHorario: false,
  });
  assert.equal(interpretarEncerramentoUra(abandono({ idConclusaoDerivacao: 3 })).motivo, 'SEM_AGENTE');
  assert.equal(interpretarEncerramentoUra(abandono({ idConclusaoDerivacao: undefined, FidConclusaoDerivacao: 4 })).motivo, 'TIMEOUT_FILA');
});

test('interpretarEncerramentoUra: derivou remove; outros tipos e telefones inválidos são ignorados', () => {
  assert.equal(interpretarEncerramentoUra(abandono({ idConclusaoDerivacao: 1 })).acao, Acao.REMOVER);
  assert.equal(interpretarEncerramentoUra(abandono({ idTipoWebhook: 1 })), null);
  assert.equal(interpretarEncerramentoUra(abandono({ idConclusaoDerivacao: 99 })), null);
  assert.equal(interpretarEncerramentoUra(abandono({ telefone: '' })), null);
  assert.equal(interpretarEncerramentoUra(null), null);
});

test('deduplicação e expiração dentro da janela', () => {
  const agora = Date.now();
  const pendentes = { 11987654321: { incluidoEm: agora - HORA }, 1133334444: { incluidoEm: agora - 5 * HORA } };
  assert.equal(jaTemRetorno(pendentes, '11987654321', agora, 4 * HORA), true);
  assert.equal(jaTemRetorno(pendentes, '1133334444', agora, 4 * HORA), false);
  assert.deepEqual(Object.keys(limparExpirados(pendentes, agora, 4 * HORA)), ['11987654321']);
});

test('montarLead e codClienteDoRetorno', () => {
  const cod = codClienteDoRetorno('11987654321', '2026-10-08');
  assert.equal(cod, 'RETORNO-11987654321-20261008');
  const lead = montarLead({ telefone: '11987654321', motivo: 'SEM_AGENTE' }, { codCliente: cod, origem: 'RETORNO_URA' });
  assert.equal(lead.telefone1, '11987654321');
  assert.equal(lead.origem, 'RETORNO_URA');
  assert.equal(lead.info0, 'SEM_AGENTE');
  assert.equal('data0' in lead, false);
});

// ───────────── Retorno da fila: serviço ─────────────

function montarRetorno(cfg = {}, inicial = {}) {
  const client = new ArgusMockClient(loggerNulo);
  const { repo, trilha } = memoria(inicial);
  const servico = new RetornoFilaService({
    client,
    cfg: {
      ativo: true, skillHash: 'h', janelaHoras: 4, incluirForaHorario: true, origem: 'RETORNO_URA',
      dryRun: false, fusoHorario: 'America/Sao_Paulo', ...cfg,
    },
    repositorio: repo,
    auditoria: trilha,
    logger: loggerNulo,
  }).inicializar();
  return { client, repo, trilha, servico };
}

test('RetornoFilaService: inclui, deduplica e remove quando o cliente é atendido', async () => {
  const { client, repo, trilha, servico } = montarRetorno();
  const r1 = await servico.processar(abandono());
  assert.equal(r1.resultado, Resultado.INCLUIDO);
  assert.equal(client.leads.length, 1);
  assert.equal(client.leads[0].origem, 'RETORNO_URA');
  assert.ok(repo.estado['11987654321']);

  assert.equal((await servico.processar(abandono({ idConclusaoDerivacao: 3 }))).resultado, Resultado.DUPLICADO);
  assert.equal(client.leads.length, 1);

  const r3 = await servico.processar(abandono({ idConclusaoDerivacao: 1 }));
  assert.equal(r3.resultado, Resultado.REMOVIDO);
  assert.equal(client.leads.length, 0);
  assert.deepEqual(repo.estado, {});
  assert.deepEqual(trilha.eventos.map((e) => e.acao), ['retorno.incluido', 'retorno.duplicado', 'retorno.removido']);
});

test('RetornoFilaService: rajada do mesmo telefone vira um lead só (fila serializada)', async () => {
  const { client, servico } = montarRetorno();
  const resultados = await Promise.all([servico.processar(abandono()), servico.processar(abandono()), servico.processar(abandono())]);
  assert.deepEqual(resultados.map((r) => r.resultado), [Resultado.INCLUIDO, Resultado.DUPLICADO, Resultado.DUPLICADO]);
  assert.equal(client.leads.length, 1);
});

test('RetornoFilaService: desligado, DRY_RUN, fora do horário e sem pendente', async () => {
  const desligado = montarRetorno({ ativo: false });
  assert.equal(await desligado.servico.processar(abandono()), null);
  assert.equal(desligado.trilha.eventos.length, 0);

  const simulado = montarRetorno({ dryRun: true });
  assert.equal((await simulado.servico.processar(abandono())).resultado, Resultado.SIMULADO);
  assert.equal(simulado.client.leads.length, 0);

  const semForaHorario = montarRetorno({ incluirForaHorario: false });
  assert.equal((await semForaHorario.servico.processar(abandono({ foraHorario: true }))).resultado, Resultado.FORA_DO_HORARIO);

  const semPendente = montarRetorno();
  assert.equal((await semPendente.servico.processar(abandono({ idConclusaoDerivacao: 1 }))).resultado, Resultado.SEM_PENDENTE);
});

test('RetornoFilaService: falha na Argus é registrada e não trava a fila', async () => {
  const { client, servico } = montarRetorno();
  client.incluirLead = async () => { throw new Error('Argus fora'); };
  const r = await servico.processar(abandono());
  assert.equal(r.resultado, Resultado.FALHA);
  assert.match(r.erro, /Argus fora/);
  assert.equal((await servico.processar(abandono({ telefone: '1133334444' }))).resultado, Resultado.FALHA);
});

test('RetornoFilaService: pendências expiradas somem ao inicializar', () => {
  const { servico } = montarRetorno({}, { 11987654321: { incluidoEm: Date.now() - 5 * HORA, codCliente: 'x' } });
  assert.deepEqual(servico.pendentes, {});
});

// ───────────── Fim de expediente: regras puras ─────────────

test('horarioComMargem e deveExecutar', () => {
  assert.equal(horarioComMargem('18:00', 10), '18:10');
  assert.equal(horarioComMargem('17:55', 10), '18:05');
  assert.equal(horarioComMargem('23:55', 30), '23:59');
  assert.equal(deveExecutar({ hora: '18:09', data: '2026-10-08', horarioAlvo: '18:10' }), false);
  assert.equal(deveExecutar({ hora: '18:10', data: '2026-10-08', horarioAlvo: '18:10' }), true);
  assert.equal(deveExecutar({ hora: '19:00', data: '2026-10-08', horarioAlvo: '18:10', ultimaExecucao: '2026-10-08' }), false);
  assert.equal(deveExecutar({ hora: '19:00', data: '2026-10-09', horarioAlvo: '18:10', ultimaExecucao: '2026-10-08' }), true);
});

test('operadoresParaVerificar: só operadores ativos com ramal, sem robôs nem exceções', () => {
  const usuarios = [
    { ramal: '1', tipo: 2, ativo: true },
    { ramal: '2', tipo: 2, ativo: false },
    { ramal: null, tipo: 2, ativo: true },
    { ramal: '3', tipo: 1, ativo: true },
    { ramal: '4', tipo: 2, ativo: true },
    { ramal: '5', tipo: 2, ativo: true },
  ];
  const r = operadoresParaVerificar(usuarios, { ignorarRamais: ['4'], ramaisRobos: [5] });
  assert.deepEqual(r.map((u) => u.ramal), ['1']);
});

test('quemFicouLogado: offline e erro ficam de fora; em atendimento nunca é deslogado', () => {
  const r = quemFicouLogado([
    { ramal: '1', classe: Classe.OFFLINE },
    { ramal: '2', classe: Classe.ERRO },
    { ramal: '3', classe: Classe.LIVRE },
    { ramal: '4', classe: Classe.OUTRO },
    { ramal: '5', classe: Classe.ATENDIMENTO },
  ]);
  assert.deepEqual(r.map((o) => [o.ramal, o.situacao]), [
    ['3', Situacao.DESLOGAR], ['4', Situacao.DESLOGAR], ['5', Situacao.EM_ATENDIMENTO],
  ]);
});

// ───────────── Fim de expediente: serviço ─────────────

function montarFim(cfg = {}, inicial = {}) {
  const client = new ArgusMockClient(loggerNulo);
  const { repo, trilha } = memoria(inicial);
  const avisos = memoria().trilha;
  const servico = new FimExpedienteService({
    client,
    cfg: {
      ativo: true, acao: 'relatar', margemMin: 10, ignorarRamais: [], horarioFim: '18:00', fusoHorario: 'America/Sao_Paulo',
      grupoRobosId: 0, descricoesStatus: DESC, concorrencia: 5, dryRun: false, ...cfg,
    },
    repositorio: repo,
    auditoria: trilha,
    notificador: new NotificadorLog({ trilha: avisos, logger: loggerNulo }),
    logger: loggerNulo,
  });
  return { client, repo, trilha, avisos, servico };
}

const ramais = (lista) => lista.map((o) => o.ramal).sort();

test('FimExpediente relatar: lista quem ficou logado e não desloga ninguém', async () => {
  const { client, trilha, avisos, servico } = montarFim();
  const r = await servico.executar();
  assert.deepEqual(ramais(r.logados), ['1001', '1002', '1008']);
  assert.deepEqual(ramais(r.emAtendimento), ['1002']);
  assert.equal(r.deslogados.length, 0);
  assert.equal(client.status.size, 3);
  assert.equal(trilha.eventos[0].acao, 'fim-expediente');
  assert.match(avisos.eventos[0].texto, /3 operador\(es\) ainda logado/);
});

test('FimExpediente deslogar: desloga quem está fora de atendimento e respeita exceções', async () => {
  const { client, servico } = montarFim({ acao: 'deslogar', ignorarRamais: ['1008'] });
  const r = await servico.executar();
  assert.deepEqual(ramais(r.deslogados), ['1001']);
  assert.deepEqual([...client.status.keys()].sort(), ['1002', '1008']);
});

test('FimExpediente deslogar em DRY_RUN não desloga; falha individual é relatada', async () => {
  const simulado = montarFim({ acao: 'deslogar', dryRun: true });
  assert.equal((await simulado.servico.executar()).deslogados.length, 0);
  assert.equal(simulado.client.status.size, 3);

  const comFalha = montarFim({ acao: 'deslogar' });
  comFalha.client.deslogarOperador = async () => { throw new Error('recusado'); };
  const r = await comFalha.servico.executar();
  assert.equal(r.falhas.length, 2);
  assert.equal(comFalha.avisos.eventos[0].acao, 'notificacao.erro');
});

test('FimExpediente tique: roda uma vez por dia, só depois do horário', async () => {
  const { repo, servico } = montarFim();
  const em = (hhmm) => new Date(`2026-10-08T${hhmm}:00-03:00`);
  assert.equal(await servico.tique(em('18:05')), null);
  assert.ok(await servico.tique(em('18:10')));
  assert.equal(repo.estado.ultimaExecucao, '2026-10-08');
  assert.equal(await servico.tique(em('18:30')), null);

  const desligado = montarFim({ ativo: false });
  assert.equal(await desligado.servico.tique(em('19:00')), null);
});

test('FimExpediente: todos deslogados → aviso de tudo certo', async () => {
  const { client, avisos, servico } = montarFim();
  client.status.clear();
  const r = await servico.executar();
  assert.equal(r.logados.length, 0);
  assert.match(avisos.eventos[0].texto, /Todos os operadores deslogaram/);
});

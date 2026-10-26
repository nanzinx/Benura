'use strict';
/** [NOVO] Painel do receptivo: leads derivados/transbordos, status da URA, pausas e "Alocar Todos no Ativo". */
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { StatusUra } = require('../../src/rodizio/status-ura');
const { TermometroUra } = require('../../src/rodizio/termometro-ura');
const { EstatisticasDia } = require('../../src/rodizio/estatisticas-dia');
const { RetencaoAtivo } = require('../../src/rodizio/retencao-ativo');
const { Classe, interpretarEncerramentoUra } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

test('encerramento de URA: tipo 5 e tipo 4 (numerações diferentes) viram lead derivado ou transbordo', () => {
  assert.deepEqual(interpretarEncerramentoUra({ idTipoWebhook: 5, FidConclusaoDerivacao: 1, tempoFilaSegundos: 12, telefone: 'x', dataInicioUra: 'd' }),
    { chave: 'x|d', derivou: true, motivo: 'derivou', filaSeg: 12 });
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 5, idConclusaoDerivacao: 3 }).motivo, 'sem agente');
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 4, idConclusaoDerivacao: 5, idLigacao: 77 }).motivo, 'time-out na fila');
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 4, idConclusaoDerivacao: 4, idLigacao: 77 }).chave, 'ligacao:77');
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 4, idConclusaoDerivacao: 4, acionouDerivacao: false }), null, 'recusa: não é ligação para humano');
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 1, codUsuarioIntegracao: '200' }), null);
  assert.equal(interpretarEncerramentoUra({ idTipoWebhook: 5, idConclusaoDerivacao: 9 }), null);
});

test('relatório do dia: cada ligação conta uma vez (lead ou transbordo) e as pausas somam por tipo', () => {
  const e = new EstatisticasDia({ fusoHorario: 'America/Sao_Paulo' });
  const t0 = new Date('2026-10-22T13:00:00Z').getTime();
  assert.equal(e.registrarEncerramento(t0, { chave: 'a', derivou: true, motivo: 'derivou', filaSeg: 10 }), true);
  assert.equal(e.registrarEncerramento(t0, { chave: 'a', derivou: true, motivo: 'derivou', filaSeg: 10 }), false, 'reenviado: não conta de novo');
  e.registrarEncerramento(t0, { chave: 'b', derivou: false, motivo: 'abandonou a fila', filaSeg: 50 });
  e.registrarEncerramento(t0, { chave: 'c', derivou: false, motivo: 'time-out na fila', filaSeg: null });
  assert.equal(e.registrarEncerramento(t0, { chave: null, derivou: false, motivo: 'sem agente', filaSeg: null }), false, 'transbordo = Gerou Callback: sem agente não conta');
  e.amostrar(t0, { livres: 1, robosLigados: 1, pausas: ['ALMOÇO'] });
  e.amostrar(t0 + 30_000, { livres: 1, robosLigados: 1, pausas: ['ALMOÇO', 'BANHEIRO'] });
  const r = e.resumo();
  assert.deepEqual([r.leadsDerivados, r.transbordos], [1, 2]);
  assert.deepEqual(r.transbordosPorMotivo, { 'abandonou a fila': 1, 'time-out na fila': 1 });
  assert.equal(r.filaMediaSeg, 30);
  assert.deepEqual(r.pausasMin, { 'ALMOÇO': 0.5, BANHEIRO: 0.5 });
  assert.deepEqual([r.horas[0].leadsDerivados, r.horas[0].transbordos], [1, 2]);
});

test('[NOVO] relatório do dia: o "sem agente" já contado hoje sai dos transbordos ao subir', () => {
  const salvo = { dia: '2026-10-22', transbordos: 23, transbordosPorMotivo: { 'sem agente': 15, 'abandonou a fila': 8 } };
  const e = new EstatisticasDia({ fusoHorario: 'America/Sao_Paulo', repositorio: { carregar: () => salvo } })
    .carregar(new Date('2026-10-22T16:00:00Z').getTime());
  const r = e.resumo();
  assert.deepEqual([r.transbordos, r.transbordosPorMotivo], [8, { 'abandonou a fila': 8 }]);
});

test('status da URA: manual vence o termômetro até voltar ao automático; gravado em arquivo', () => {
  let gravado = null;
  const s = new StatusUra({ arquivo: null, logger: loggerNulo });
  s.repositorio = { carregar: () => gravado, salvar: (x) => { gravado = x; } };
  const termometro = { estado: 'agressiva', resumo: () => ({ estado: 'agressiva', desde: '2026-10-22T13:00:00.000Z' }) };
  assert.equal(s.atual(termometro), 'agressiva');
  assert.deepEqual(s.definir({ status: 'calma', modo: 'manual' }, 'ana@x.com'), { mudou: true });
  assert.deepEqual(s.definir({ status: 'calma', modo: 'manual' }), { mudou: false });
  const r = s.resumo(termometro);
  assert.deepEqual([r.status, r.modo, r.por, r.automatico.estado], ['calma', 'manual', 'ana@x.com', 'agressiva']);
  assert.equal(new StatusUra({ arquivo: null, logger: loggerNulo }).carregar.call(Object.assign(new StatusUra({ arquivo: null, logger: loggerNulo }), { repositorio: { carregar: () => gravado } })).atual(termometro), 'calma', 'reinício mantém');
  s.definir({ modo: 'automatico' });
  assert.equal(s.atual(termometro), 'agressiva');
  assert.throws(() => s.definir({ modo: 'turbo' }), /modo deve ser/);
});

/** Rodízio com 4 humanos na URA (201 fixo), um robô na lista e a URA cheia ligada. */
function montar({ elegiveis = null } = {}) {
  const avisos = [];
  const logger = { ...loggerNulo, aviso: (m) => avisos.push(m), info: () => {} };
  const transferidos = [];
  const transferencias = { transferir: async (ramal, grupo) => { transferidos.push(`${ramal}→${grupo}`); return ramal !== '204'; } };
  let cheia = true;
  const uraCheia = {
    ativa: () => cheia, desligar: () => { const mudou = cheia; cheia = false; return mudou; }, ligar: () => { const mudou = !cheia; cheia = true; return mudou; },
    resumo: () => ({ ligada: cheia }),
  };
  const retencao = new RetencaoAtivo({ arquivo: null, logger });
  const svc = new RodizioService({
    client: {}, transferencias, robos: { situacao: () => ({ ligados: 0 }), resumo: () => ({ ligados: 0 }), ligados: new Set() },
    repositorio: { salvar: () => {} }, logger, uraCheia, termometro: new TermometroUra({ logger }), statusDaUra: new StatusUra({ arquivo: null, logger }),
    estatisticas: new EstatisticasDia({ fusoHorario: 'America/Sao_Paulo' }), retencao,
    elegiveis: elegiveis && { atualizar: async () => {}, permite: (r) => elegiveis.includes(String(r)), resumo: () => ({}) },
    cfg: { robosModo: 'panico', pollUraMs: 5000, tempoNaUraMs: 180_000, grupoUraId: 7, concorrencia: 2 },
  });
  const agora = Date.now();
  svc.ramaisUra = new Set(['201', '202', '203', '204', '900']);
  svc.ramaisRobos = ['900'];
  svc.permanentes = new Set(['201']);
  for (const r of ['202', '203', '204']) svc.movidos[r] = { origemGrupoId: 3, entrouEm: agora };
  const st = (classe, nome, extra = {}) => ({ classe, ts: agora, detalhe: { nome, pausa: null, statusDesde: agora - 60_000, ...extra } });
  svc.statusUra.set('201', st(Classe.LIVRE, 'Ana Fixa'));
  svc.statusUra.get('201').livreDesde = agora - 90_000;
  svc.statusUra.set('202', st(Classe.OUTRO, 'Bruno', { pausa: 'ALMOÇO', statusDesde: agora - 70 * 60_000 }));
  svc.statusUra.set('203', st(Classe.ATENDIMENTO, 'Carla'));
  svc.statusUra.set('204', st(Classe.LIVRE, 'Diego'));
  svc.statusUra.get('204').livreDesde = agora - 40_000;
  svc.statusUra.set('900', st(Classe.LIVRE, 'OPER VIRTUAL 1'));
  return { svc, avisos, transferidos, retencao };
}

test('alocar todos no Ativo: o filtro é do rodízio (sem fixo, sem robô); desliga a URA cheia antes; erros voltam', async () => {
  const { svc, avisos, transferidos } = montar();
  assert.deepEqual(svc.resumo().transferenciaUraAtivo, { elegiveis: 3, fixos: 1, uraCheiaLigada: true });

  const r = await svc.transferirUraParaAtivo('ana@empresa.com (1.2.3.4)');
  assert.deepEqual(r.movidos, ['202', '203']);
  assert.deepEqual(r.ignorados, [{ ramal: '201', nome: 'Ana Fixa', motivo: 'fixo' }]);
  assert.deepEqual(r.erros, [{ ramal: '204', nome: 'Diego', erro: 'a transferência não foi aceita agora' }]);
  assert.equal(r.uraCheiaDesligada, true);
  assert.deepEqual(transferidos, ['202→3', '203→3', '204→3'], 'o robô 900 nem é tentado');
  assert.ok(avisos.some((m) => /Alocar todos no Ativo \(ana@empresa.com \(1.2.3.4\)\): 2 movido\(s\), 1 mantido\(s\) na URA \(fixo ou travado\), 1 erro\(s\); URA cheia desligada/.test(m)));
  assert.deepEqual([...svc.ramaisUra].sort(), ['201', '204', '900']);
});

test('receptivo: uraAgora traz pausa, desde quando no status e virtual; métricas de hoje vêm dos webhooks', () => {
  const { svc } = montar();
  const ura = Object.fromEntries(svc.uraAgora().map((u) => [u.ramal, u]));
  assert.equal(ura['202'].pausa, 'ALMOÇO');
  assert.ok(Date.now() - new Date(ura['202'].statusDesde).getTime() >= 70 * 60_000 - 1000, 'tempoStatus da Argus');
  assert.ok(Math.abs(Date.now() - new Date(ura['201'].statusDesde).getTime() - 60_000) < 1000, '[NOVO] livre também pelo tempoStatus da Argus (não pelo relógio do rodízio)');
  assert.deepEqual([ura['900'].virtual, ura['201'].virtual, ura['201'].fixo], [true, false, true]);
  assert.equal(ura['203'].pausa, null);
  assert.ok(svc.resumo().pausasLimitesMin['almoço'] === 60);

  svc.registrarEncerramentoUra({ chave: 'l1', derivou: true, motivo: 'derivou', filaSeg: 5 });
  svc.registrarEncerramentoUra({ chave: 'l2', derivou: false, motivo: 'abandonou a fila', filaSeg: 40 });
  const m = svc.metricasHoje();
  assert.deepEqual([m.leadsDerivadosHoje, m.transbordosHoje, m.emFilaAgora], [1, 1, null]);
  assert.ok(m.ultimoWebhookEncerramento);
});

test('receptivo: a espera de quem atende entra no termômetro (o tempo que ficou livre)', () => {
  const { svc } = montar();
  svc.registrarAtendimento('204'); // livre desde ts: atendeu agora
  svc.amostrarDia(Date.now());
  const t = svc.termometro.resumo();
  assert.equal(t.atendimentos, 1);
  assert.ok(t.livresAgora >= 1, 'o fixo 201 continua livre');
});

test('[NOVO] alocar todos no Ativo segura todos lá: o ciclo do Ativo não sobe ninguém; URA cheia recusada', async () => {
  const { svc, transferidos } = montar({ elegiveis: ['202', '203'] });
  await svc.transferirUraParaAtivo('ana@empresa.com');
  assert.equal(svc.resumo().retencaoAtivo.ativa, true);
  assert.equal(svc.resumo().retencaoAtivo.por, 'ana@empresa.com');

  // Os movidos voltaram ao grupo 3 do Ativo e atenderam lá (normalmente subiriam).
  svc.gruposAtivos = [{ idGrupoUsuario: 3, ramaisOperadores: ['202', '203'] }];
  svc.atenderamNoAtivo.add('202');
  svc.lerStatus = async () => ({ classe: Classe.LIVRE, status: { idGrupo: 3 } });
  transferidos.length = 0;
  await svc.cicloAtivo();
  assert.deepEqual(transferidos, [], 'ninguém sobe enquanto está pausado');
  assert.throws(() => svc.ligarUraCheia(), /retome o rodízio/);
  assert.equal(svc.resumo().retencaoAtivo.elegiveisParaVoltar, 2);
});

test('[NOVO] retomar o rodízio: quem é elegível volta para a URA na hora; os outros ficam; sem lista, ninguém é movido', async () => {
  const { svc, transferidos, avisos } = montar({ elegiveis: ['202'] });
  await svc.transferirUraParaAtivo();
  svc.gruposAtivos = [{ idGrupoUsuario: 3, ramaisOperadores: ['202', '203'] }];
  transferidos.length = 0;
  const r = await svc.retomarRodizio('bia@empresa.com');
  assert.deepEqual([r.movidos, r.erros, r.semLista, r.mudou], [['202'], [], false, true]);
  assert.deepEqual(transferidos, ['202→7'], 'só o elegível vai para a URA');
  assert.equal(svc.resumo().retencaoAtivo.ativa, false);
  assert.ok(svc.ramaisUra.has('202') && !svc.ramaisUra.has('203'));
  assert.ok(avisos.some((m) => /Retomar rodízio da URA \(bia@empresa.com\): 1 voltaram para a URA/.test(m)));

  const semLista = montar();
  await semLista.svc.transferirUraParaAtivo();
  const r2 = await semLista.svc.retomarRodizio();
  assert.deepEqual([r2.semLista, r2.movidos], [true, []]);
  assert.equal(semLista.svc.resumo().retencaoAtivo.ativa, false);
});

test('[NOVO] retenção gravada em arquivo: um reinício continua pausado', async () => {
  let gravado = null;
  const logger = loggerNulo;
  const a = new RetencaoAtivo({ arquivo: null, logger });
  a.repositorio = { carregar: () => gravado, salvar: (x) => { gravado = x; }, aguardar: async () => {} };
  assert.equal(await a.ligar('ana'), true);
  assert.equal(await a.ligar('ana'), false);
  const b = new RetencaoAtivo({ arquivo: null, logger });
  b.repositorio = { carregar: () => gravado };
  assert.equal(b.carregar().ativa, true);
  assert.equal(await a.desligar(), true);
  assert.deepEqual(gravado, { ativa: false, desde: null, por: null });
});

test('[NOVO] receptivo: sem tempoStatus da Argus, o livre usa o que o rodízio mediu', () => {
  const { svc } = montar();
  svc.statusUra.get('204').detalhe.statusDesde = null;
  const ura = Object.fromEntries(svc.uraAgora().map((u) => [u.ramal, u]));
  assert.ok(Math.abs(Date.now() - new Date(ura['204'].statusDesde).getTime() - 40_000) < 1000);
});

test('[NOVO] ociosidade: logo depois de subir, o livre já na URA conta pelo tempoStatus; quem o BenURA moveu conta do zero', async () => {
  const { svc } = montar();
  const status = { idGrupo: 7, descricaoStatus: 'Livre', tempoStatus: 4 * 60_000, nome: 'Eva' };
  svc.lerStatus = async () => ({ classe: Classe.LIVRE, status });
  svc.statusUra.delete('201');
  await svc.atualizarStatusUra('201');
  assert.ok(Math.abs(Date.now() - svc.statusUra.get('201').livreDesde - 4 * 60_000) < 1000, 'reinício não zera os 4 min livres');

  // Movido pelo BenURA agora: já tem leitura (OUTRO), o tempo livre no Ativo não entra.
  svc.statusUra.set('205', { classe: Classe.OUTRO, ts: Date.now() });
  await svc.atualizarStatusUra('205');
  assert.ok(Date.now() - svc.statusUra.get('205').livreDesde < 1000);

  // Fora da subida (BenURA no ar há mais de 1 min): quem aparece na URA conta do zero.
  svc.iniciadoEm = Date.now() - 5 * 60_000;
  svc.statusUra.delete('206');
  await svc.atualizarStatusUra('206');
  assert.ok(Date.now() - svc.statusUra.get('206').livreDesde < 1000);
});

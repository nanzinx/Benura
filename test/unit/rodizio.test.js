'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {
  Classe, AcaoRobos, classificarStatus, deveIrParaUra, deveVoltarAoAtivo, decidirRobos, alvoDeRobos, escolherParaDesligar, ultimoLivreQueSai,
  reconciliarMovidos, interpretarWebhook, jaEstavaDeslogado,
} = require('../../src/domain/rodizio');
const { adquirirTrava, TravaOcupadaError } = require('../../src/utils/trava-processo');
const { mapearComLimite } = require('../../src/utils/concorrencia');
const { GravadorJsonAtomico, lerComBackup } = require('../../src/utils/persistencia-json');
const { ArgusClient, ArgusError, ArgusLimiteError } = require('../../src/integrations/argus/argus.client');
const { ControleRobos } = require('../../src/rodizio/controle-robos');
const { Transferencias } = require('../../src/rodizio/transferencias');
const { loggerNulo } = require('../../src/utils/logger');

const DESC = { livres: ['livre', 'disponivel'], atendimento: ['em atendimento', 'falando'] };
const tmp = (prefixo) => fs.mkdtempSync(path.join(os.tmpdir(), prefixo));

// ───────────── Regras puras ─────────────

test('classificarStatus com o padrão da config entende os textos da Argus real', () => {
  const salvo = process.env.STATUS_ATENDIMENTO;
  delete process.env.STATUS_ATENDIMENTO;
  try {
    const { descricoesStatus } = require('../../src/config').carregarConfig().rodizio;
    assert.equal(classificarStatus({ descricaoStatus: 'Atendimento' }, descricoesStatus), Classe.ATENDIMENTO);
    assert.equal(classificarStatus({ descricaoStatus: 'Livre' }, descricoesStatus), Classe.LIVRE);
    assert.equal(classificarStatus({ descricaoStatus: 'Pausado', descricaoPausa: 'Banheiro' }, descricoesStatus), Classe.OUTRO);
    assert.equal(classificarStatus({ descricaoStatus: 'Deslogado' }, descricoesStatus), Classe.OFFLINE, 'robô desligado');
  } finally {
    if (salvo !== undefined) process.env.STATUS_ATENDIMENTO = salvo;
  }
});

test('classificarStatus', () => {
  assert.equal(classificarStatus(null, DESC), Classe.OFFLINE);
  assert.equal(classificarStatus({ descricaoStatus: ' Em Atendimento ' }, DESC), Classe.ATENDIMENTO);
  assert.equal(classificarStatus({ descricaoStatus: 'Livre' }, DESC), Classe.LIVRE);
  assert.equal(classificarStatus({ descricaoStatus: 'Livre', descricaoPausa: 'Almoço' }, DESC), Classe.OUTRO);
  assert.equal(classificarStatus({ descricaoStatus: 'Tabulando' }, DESC), Classe.OUTRO);
  assert.equal(classificarStatus({ descricaoStatus: ' DESLOGADO ' }, DESC), Classe.OFFLINE, 'padrão vale sem a lista na config');
});

test('ida para a URA e volta ao Ativo', () => {
  assert.ok(deveIrParaUra(Classe.LIVRE, true));
  assert.ok(!deveIrParaUra(Classe.LIVRE, false));
  assert.ok(!deveIrParaUra(Classe.ATENDIMENTO, true));

  const base = { livreDesde: 0, ociosoMs: 180_000 };
  assert.ok(!deveVoltarAoAtivo({ ...base, classe: Classe.LIVRE, agora: 120_000 }), 'livre há 2 min fica');
  assert.ok(deveVoltarAoAtivo({ ...base, classe: Classe.LIVRE, agora: 180_000 }), 'livre há 3 min volta, movido ou não');
  assert.ok(!deveVoltarAoAtivo({ ...base, classe: Classe.ATENDIMENTO, agora: 900_000 }), 'em atendimento fica');
  assert.ok(!deveVoltarAoAtivo({ ...base, classe: Classe.OUTRO, agora: 900_000 }), 'em pausa fica');
  assert.ok(!deveVoltarAoAtivo({ ...base, livreDesde: undefined, classe: Classe.LIVRE, agora: 900_000 }), 'sem marca de ocioso não volta');
  assert.ok(deveVoltarAoAtivo({ ...base, classe: Classe.OFFLINE, agora: 1, movido: { origemGrupoId: 1 } }), 'movido offline volta na hora');
  assert.ok(!deveVoltarAoAtivo({ ...base, classe: Classe.OFFLINE, agora: 1 }), 'quem não foi movido e está offline é ignorado');
});

test('movido offline só volta se continuar offline por offlineMs (o status pisca na troca de grupo)', () => {
  const movido = { origemGrupoId: 9 };
  const offline = { classe: Classe.OFFLINE, ociosoMs: 180_000, movido, offlineDesde: 0, offlineMs: 60_000 };
  assert.ok(!deveVoltarAoAtivo({ ...offline, agora: 42_000 }), 'offline há 42 s: ainda pode ser a troca');
  assert.ok(deveVoltarAoAtivo({ ...offline, agora: 60_000 }), 'offline há 60 s: volta');
});

test('alvoDeRobos: livre ainda na carência da troca de grupo não liga robô', () => {
  const agora = 10_000;
  const cfg = { porLivre: 7 };
  const status = (emCarencia) => new Map([['201', { classe: Classe.LIVRE, ts: agora, emCarencia }]]);
  assert.deepEqual(alvoDeRobos({ ramaisUra: ['201'], status: status(true), agora, total: 58, cfg }),
    { alvo: 0, livres: 0, motivo: 'livre(s) na URA ainda na carência da troca de grupo' });
  assert.equal(alvoDeRobos({ ramaisUra: ['201'], status: status(false), agora, total: 58, cfg }).alvo, 7);
});

test('decidirRobos: robôs proporcionais aos livres; reduzir é imediato, aumentar espera', () => {
  const agora = 100_000;
  const st = (pares) => new Map(Object.entries(pares).map(([r, classe]) => [r, { classe, ts: agora }]));
  const cfg = { reativar: true, minDesligadoMs: 3000, porLivre: 7 };
  const robos = (ligados, ultimaReducao = 0, total = 58) => ({ ligados, total, ultimaReducao });
  const d = (ramaisUra, status, r = robos(7), c = cfg) => decidirRobos({ ramaisUra, status, agora, robos: r, cfg: c });

  assert.deepEqual(alvoDeRobos({ ramaisUra: ['1'], status: st({ 1: 'livre' }), agora, total: 58, cfg }).alvo, 7);
  // Poll de 5 s: status com 8 s ainda vale se a validade acompanha o intervalo; com o padrão (6 s) não.
  const velho = new Map([['1', { classe: 'livre', ts: agora - 8000 }]]);
  assert.equal(alvoDeRobos({ ramaisUra: ['1'], status: velho, agora, total: 58, cfg }).motivo, 'sem visibilidade da Argus');
  assert.equal(alvoDeRobos({ ramaisUra: ['1'], status: velho, agora, total: 58, cfg: { ...cfg, validadeStatusMs: 11_000 } }).alvo, 7);
  assert.equal(d(['1', '2'], st({ 1: 'livre', 2: 'livre' })).alvo, 14);
  assert.equal(d(['1', '2'], st({ 1: 'livre', 2: 'livre' })).acao, AcaoRobos.RELIGAR, '7 ligados, alvo 14 → aumenta');
  assert.equal(d(['1', '2'], st({ 1: 'atendimento', 2: 'livre' })).acao, AcaoRobos.NENHUMA, 'alvo 7 = ligados 7');
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(20)).acao, AcaoRobos.DESLIGAR, '20 ligados, alvo 7 → reduz');
  const muitos = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), 'livre']));
  assert.equal(d(Object.keys(muitos), st(muitos)).alvo, 58, 'teto no total de robôs');
  assert.equal(d(Object.keys(muitos), st(muitos), robos(7), { ...cfg, maximo: 30 }).alvo, 30, 'ROBOS_MAXIMO');

  assert.equal(d(['1', '2'], st({ 1: 'atendimento', 2: 'outro' })).acao, AcaoRobos.DESLIGAR, 'ninguém livre');
  assert.equal(d([], new Map()).acao, AcaoRobos.DESLIGAR, 'URA vazia');
  assert.equal(d(['1'], st({ 1: 'offline' })).acao, AcaoRobos.DESLIGAR, 'todos offline');
  assert.equal(d(['1'], new Map()).acao, AcaoRobos.DESLIGAR, 'sem status');
  assert.equal(d(['1'], new Map([['1', { classe: 'livre', ts: agora - 7000 }]])).acao, AcaoRobos.DESLIGAR, 'status velho');
  assert.equal(d(['1'], st({ 1: 'atendimento' }), robos(0)).acao, AcaoRobos.NENHUMA, 'já desligados');
  assert.equal(d(['1'], st({ 1: 'atendimento' }), robos(null)).acao, AcaoRobos.DESLIGAR, 'desconhecido + ninguém livre → desliga');
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(null)).acao, AcaoRobos.NENHUMA, 'aguarda ler os robôs');
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(0, agora - 1000)).acao, AcaoRobos.NENHUMA, 'cedo para aumentar');
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(0, agora - 3000)).acao, AcaoRobos.RELIGAR);
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(0), { ...cfg, reativar: false }).acao, AcaoRobos.NENHUMA, 'REATIVAR_ROBOS=false');
  assert.equal(d(['1'], st({ 1: 'livre' }), robos(5, 0, 0)).acao, AcaoRobos.NENHUMA, 'nenhum robô conhecido');
});

test('escolherParaDesligar: nunca quem está em ligação (nem quem não foi lido) numa redução parcial', () => {
  const ligados = [
    { ramal: 'a', classe: 'atendimento' }, { ramal: 'b', classe: 'livre' }, { ramal: 'c', classe: 'outro' }, { ramal: 'd', classe: 'erro' },
  ];
  assert.deepEqual(escolherParaDesligar(ligados, 2), ['b', 'c']);
  assert.deepEqual(escolherParaDesligar(ligados, 4), ['b', 'c'], 'o robô em ligação e o não lido ficam até o próximo ciclo');
});

test('ControleRobos: redução parcial poupa robô em ligação até terminar; alvo 0 desliga todos', async () => {
  const status = { 900: 'em atendimento', 901: 'em atendimento', 902: 'livre' };
  const deslogados = [];
  const client = {
    async statusOperador(r) { return { descricaoStatus: status[r] || 'Deslogado' }; },
    async deslogarOperador(r) { deslogados.push(r); status[r] = null; },
  };
  const ramais = ['900', '901', '902'];
  const robos = new ControleRobos({ client, cfg: { dryRun: false, concorrencia: 5, descricoesStatus: DESC_ROBOS }, logger: loggerNulo });
  await robos.sincronizar(ramais);

  await robos.reduzir(ramais, 1, 'teste'); // excesso 2, mas só o 902 está ocioso
  assert.deepEqual(deslogados, ['902']);
  assert.equal(robos.situacao(3).ligados, 2, 'os dois em ligação continuam contados');

  status['900'] = 'livre'; // a ligação do 900 terminou
  await robos.reduzir(ramais, 1, 'teste');
  assert.deepEqual(deslogados, ['902', '900']);
  assert.equal(robos.situacao(3).ligados, 1);

  await robos.reduzir(ramais, 0, 'ninguém livre');
  assert.ok(deslogados.includes('901'), 'com alvo 0, o robô em ligação também sai');
});

test('reconciliarMovidos: carência, ausências e retorno à URA', () => {
  const agora = 1_000_000;
  const movidos = {
    novo: { origemGrupoId: 1, entrouEm: agora - 10_000 },
    sumiu1x: { origemGrupoId: 1, entrouEm: 0 },
    sumiu2x: { origemGrupoId: 1, entrouEm: 0, ausentes: 1 },
    voltou: { origemGrupoId: 1, entrouEm: 0, ausentes: 1 },
  };
  const r = reconciliarMovidos(movidos, new Set(['voltou']), agora);
  assert.deepEqual(r.esquecidos, ['sumiu2x']);
  assert.equal(r.movidos.novo.ausentes, undefined, 'carência de 60s');
  assert.equal(r.movidos.sumiu1x.ausentes, 1);
  assert.equal(r.movidos.voltou.ausentes, 0);
  assert.equal(movidos.sumiu1x.ausentes, undefined, 'não altera o original');
});

test('interpretarWebhook', () => {
  assert.deepEqual(interpretarWebhook({ idTipoWebhook: 1, codUsuarioIntegracao: 200 }), { ramal: '200' });
  assert.deepEqual(interpretarWebhook({ idTipoWebhook: 5, idConclusaoDerivacao: 1, codUsuarioIntegracao: '7' }), { ramal: '7' });
  assert.deepEqual(interpretarWebhook({ idTipoWebhook: 5, FidConclusaoDerivacao: 1, codUsuarioIntegracao: '7' }), { ramal: '7' });
  assert.equal(interpretarWebhook({ idTipoWebhook: 5, idConclusaoDerivacao: 2, codUsuarioIntegracao: '7' }), null);
  assert.equal(interpretarWebhook({ idTipoWebhook: 2, codUsuarioIntegracao: '7' }), null);
  assert.equal(interpretarWebhook({ idTipoWebhook: 1 }), null);
  assert.equal(interpretarWebhook(null), null);
});

test('jaEstavaDeslogado aceita com e sem acento', () => {
  assert.ok(jaEstavaDeslogado('Já deslogado do sistema'));
  assert.ok(jaEstavaDeslogado('Operador nao esta logado'));
  assert.ok(jaEstavaDeslogado('Operador não está logado'));
  assert.ok(!jaEstavaDeslogado('Erro interno'));
});

// ───────────── Utilitários ─────────────

test('trava: reaproveita trava de processo morto e respeita processo vivo', () => {
  const pasta = tmp('trava-');
  const caminho = path.join(pasta, 'argus.lock');

  const t1 = adquirirTrava(caminho);
  assert.equal(t1.reaproveitouOrfa, false);
  t1.liberar();
  assert.ok(!fs.existsSync(caminho));

  const { pid: morto } = require('child_process').spawnSync(process.execPath, ['-e', '0']);
  fs.writeFileSync(caminho, String(morto));
  const t2 = adquirirTrava(caminho);
  assert.equal(t2.reaproveitouOrfa, true);
  assert.equal(t2.pidAnterior, morto);
  t2.liberar();

  fs.writeFileSync(caminho, String(process.ppid)); // processo vivo (o pai do teste)
  assert.throws(() => adquirirTrava(caminho), TravaOcupadaError);
  fs.rmSync(pasta, { recursive: true });
});

test('mapearComLimite respeita o limite e a ordem', async () => {
  let simultaneos = 0;
  let pico = 0;
  const r = await mapearComLimite([5, 1, 4, 2, 3], 2, async (n) => {
    pico = Math.max(pico, ++simultaneos);
    await new Promise((res) => setTimeout(res, n * 5));
    simultaneos--;
    return n * 10;
  });
  assert.deepEqual(r, [50, 10, 40, 20, 30]);
  assert.equal(pico, 2);
  assert.deepEqual(await mapearComLimite([], 5, async () => 1), []);
});

test('GravadorJsonAtomico agrupa gravações em rajada e grava a mais recente', async () => {
  const arquivo = path.join(tmp('grav-'), 's.json');
  const g = new GravadorJsonAtomico(arquivo, loggerNulo);
  await Promise.all([1, 2, 3, 4].map((n) => g.salvar({ n })));
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, 'utf8')), { n: 4 });
  assert.ok(fs.existsSync(`${arquivo}.bak`));

  fs.writeFileSync(arquivo, '{quebrado');
  assert.deepEqual(lerComBackup(arquivo), { dados: { n: 4 }, origem: 'backup', erro: lerComBackup(arquivo).erro });
});

// ───────────── Cliente Argus ─────────────

function servidor(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let corpo = '';
      req.on('data', (c) => { corpo += c; });
      req.on('end', () => {
        const [status, resposta] = handler(req.url.split('/').pop(), corpo ? JSON.parse(corpo) : {});
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(resposta));
      });
    }).listen(0, () => resolve({
      srv,
      client: new ArgusClient({
        baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 't', timeoutMs: 2000, tentativas: 2, pausaLimiteMs: 300,
      }, loggerNulo),
    }));
  });
}

test('statusOperador: logado, não logado (codStatus 0 ou HTTP 500) e erro (codStatus -1, 403)', async (t) => {
  const respostas = {
    1: [200, { codStatus: 1, statusOperador: { descricaoStatus: 'Livre' } }],
    2: [200, { codStatus: 0, descStatus: 'não logado' }],
    3: [200, { codStatus: -1, descStatus: 'erro' }],
    4: [500, { codStatus: -1, descStatus: 'Erro interno' }],
    5: [403, {}],
  };
  const { srv, client } = await servidor((cmd, corpo) => respostas[corpo.ramal]);
  t.after(() => srv.close());
  assert.equal((await client.statusOperador('1')).descricaoStatus, 'Livre');
  assert.equal(await client.statusOperador('2'), null);
  await assert.rejects(client.statusOperador('3'), ArgusError);
  assert.equal(await client.statusOperador('4'), null, 'a Argus real responde 500 para quem não está logado');
  await assert.rejects(client.statusOperador('5'), ArgusError);
});

test('429: pausa global sem re-tentativa; deslogar continua permitido', async (t) => {
  const chamadas = [];
  let limitar = true;
  const { srv, client } = await servidor((cmd) => {
    chamadas.push(cmd);
    if (limitar && cmd !== 'deslogaroperador') return [429, {}];
    return [200, { codStatus: 1, grupos: [] }];
  });
  t.after(() => srv.close());

  await assert.rejects(client.listarGrupos(), ArgusLimiteError);
  assert.equal(chamadas.length, 1, '429 não é re-tentado');
  await assert.rejects(client.listarGrupos(), ArgusLimiteError);
  assert.equal(chamadas.length, 1, 'durante a pausa nada é enviado');
  await client.deslogarOperador('900');
  assert.deepEqual(chamadas, ['listargrupos', 'deslogaroperador'], 'emergência passa');

  limitar = false;
  await new Promise((r) => setTimeout(r, 350));
  assert.deepEqual(await client.listarGrupos(), []);
});

// ───────────── Robôs e transferências ─────────────

const DESC_ROBOS = { livres: ['livre'], atendimento: ['em atendimento'] };

test('ControleRobos: re-tenta falhas, aceita "já deslogado" e mantém ligado quem resistir', async () => {
  const tentativas = {};
  const client = {
    async deslogarOperador(ramal) {
      tentativas[ramal] = (tentativas[ramal] || 0) + 1;
      if (ramal === '901' && tentativas[ramal] < 2) throw new Error('timeout');
      if (ramal === '902') throw Object.assign(new ArgusError('x'), { resposta: { descStatus: 'Já deslogado' } });
      if (ramal === '903') throw new Error('sempre falha');
      return { codStatus: 1 };
    },
  };
  const robos = new ControleRobos({ client, cfg: { dryRun: false, concorrencia: 5, descricoesStatus: DESC_ROBOS }, logger: loggerNulo });

  await robos.reduzir(['900', '901', '902'], 0, 'teste');
  assert.equal(robos.situacao(3).ligados, 0);
  assert.equal(tentativas['901'], 2);

  await robos.reduzir(['903'], 0, 'teste');
  assert.equal(robos.situacao(1).ligados, 1, '903 continua contado como ligado');
  assert.equal(tentativas['903'], 3);
});

test('ControleRobos: sincroniza, aumenta só os que faltam e reduz poupando quem está em ligação', async () => {
  const status = { 900: 'livre', 901: 'em atendimento', 902: null, 903: null, 904: null };
  const chamadas = [];
  const client = {
    // Como a Argus real: robô desligado responde sucesso com o status "Deslogado".
    async statusOperador(r) { return { descricaoStatus: status[r] || 'Deslogado' }; },
    async logarOperadorVirtual(r) { chamadas.push(`+${r}`); status[r] = 'livre'; },
    async deslogarOperador(r) { chamadas.push(`-${r}`); status[r] = null; },
  };
  const ramais = ['900', '901', '902', '903', '904'];
  const robos = new ControleRobos({ client, cfg: { dryRun: false, concorrencia: 5, descricoesStatus: DESC_ROBOS }, logger: loggerNulo });

  assert.equal(robos.situacao(5).ligados, null);
  await robos.sincronizar(ramais);
  assert.equal(robos.situacao(5).ligados, 2);

  await robos.aumentar(ramais, 4, 'teste');
  assert.deepEqual(chamadas, ['+902', '+903']);
  assert.equal(robos.situacao(5).ligados, 4);

  chamadas.length = 0;
  await robos.reduzir(ramais, 1, 'teste');
  assert.equal(chamadas.length, 3);
  assert.equal(chamadas.includes('-901'), false, 'o robô em ligação fica');
  assert.equal(robos.situacao(5).ligados, 1);

  const simulado = new ControleRobos({ client, cfg: { dryRun: true, concorrencia: 5, descricoesStatus: DESC_ROBOS }, logger: loggerNulo });
  await simulado.sincronizar(ramais);
  chamadas.length = 0;
  await simulado.aumentar(ramais, 5, 'teste');
  assert.deepEqual(chamadas, [], 'DRY_RUN não chama a Argus');
});

test('Transferencias: recusa da Argus esfria o ramal; falha de rede não', async () => {
  let modo = 'recusa';
  const client = {
    async transferirOperador() {
      if (modo === 'recusa') throw new ArgusError('não vinculado', { resposta: { codStatus: -1 } });
      if (modo === 'rede') throw new ArgusError('timeout');
      return {};
    },
  };
  const t = new Transferencias({ client, cfg: { dryRun: false }, logger: loggerNulo });

  assert.equal(await t.transferir('1', 2), false);
  assert.ok(t.emEspera('1'));
  modo = 'ok';
  assert.equal(await t.transferir('1', 2), false, 'em espera, nem tenta');

  modo = 'rede';
  assert.equal(await t.transferir('2', 2), false);
  assert.ok(!t.emEspera('2'));
  modo = 'ok';
  assert.equal(await t.transferir('2', 2), true);
});

test('ControleRobos: avisa robôs mexidos por fora, mas não os que acabamos de comandar', async () => {
  const avisos = [];
  const logger = { ...loggerNulo, aviso: (m) => avisos.push(m) };
  const status = { 900: 'livre', 901: 'livre', 902: null };
  const client = {
    async statusOperador(r) { return { descricaoStatus: status[r] || 'Deslogado' }; },
    async logarOperadorVirtual(r) { status[r] = 'livre'; },
    async deslogarOperador(r) { status[r] = null; },
  };
  const ramais = ['900', '901', '902'];
  const robos = new ControleRobos({ client, cfg: { dryRun: false, concorrencia: 5, descricoesStatus: DESC_ROBOS }, logger });
  await robos.sincronizar(ramais);
  await robos.aumentar(ramais, 3, 'teste'); // 902 ligado por nós
  await robos.sincronizar(ramais);
  assert.equal(robos.resumo().mudancasPorFora, 0, 'comando nosso não conta');

  status['900'] = null; // alguém desligou no painel
  await robos.sincronizar(ramais);
  assert.equal(robos.resumo().mudancasPorFora, 1);
  assert.match(avisos.join(), /mexidos por fora/);
});

test('URA em alerta: com 1 a LIVRES_ALERTA livres a URA é lida mais rápido', () => {
  const { RodizioService } = require('../../src/rodizio/rodizio.service');
  const svc = new RodizioService({
    client: {}, transferencias: {}, robos: {}, repositorio: {}, logger: loggerNulo,
    cfg: { pollUraMs: 5000, pollUraAlertaMs: 1000, livresAlerta: 2 },
  });
  const intervalo = (livres) => { svc.ultimosLivres = livres; return svc.intervaloUraMs(); };
  assert.equal(intervalo(null), 5000, 'antes da primeira decisão');
  assert.equal(intervalo(0), 5000, 'ninguém livre: robôs já desligados, sem risco');
  assert.equal(intervalo(1), 1000);
  assert.equal(intervalo(2), 1000);
  assert.equal(intervalo(3), 5000);
});

test('executarPeriodicamente aceita intervalo recalculado a cada rodada', async () => {
  const { executarPeriodicamente } = require('../../src/utils/periodico');
  let rodadas = 0;
  const ciclo = executarPeriodicamente({
    nome: 't', intervaloMs: () => (rodadas < 3 ? 5 : 60_000), tarefa: async () => { rodadas++; }, logger: loggerNulo,
  });
  await new Promise((r) => setTimeout(r, 200));
  await ciclo.parar();
  assert.equal(rodadas, 3, 'três rodadas rápidas e depois espera o intervalo longo');
});

test('429 recebido por um processo pausa os outros (arquivo de pausa compartilhado)', async (t) => {
  const arquivoPausa = path.join(tmp('pausa-'), 'argus-pausa.json');
  const chamadas = [];
  const srv = http.createServer((req, res) => {
    chamadas.push(req.url);
    res.writeHead(chamadas.length === 1 ? 429 : 200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ codStatus: 1, grupos: [] }));
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const cfg = { baseUrl: `http://127.0.0.1:${srv.address().port}`, token: 't', timeoutMs: 2000, tentativas: 1, pausaLimiteMs: 60_000, arquivoPausa };
  const roteador = new ArgusClient(cfg, loggerNulo);
  const rodizio = new ArgusClient(cfg, loggerNulo);

  await assert.rejects(roteador.listarGrupos(), ArgusLimiteError);
  await assert.rejects(rodizio.listarGrupos(), ArgusLimiteError, 'o outro processo respeita a pausa');
  assert.equal(chamadas.length, 1, 'nada foi enviado durante a pausa');
});

test('config: avisa valores antigos do .env que anulam correções', () => {
  const { validarConfig, carregarConfig } = require('../../src/config');
  const base = carregarConfig({ argus: { token: 't', gruposAtivosIds: [1] } });
  const comAntigos = {
    ...base,
    rodizio: {
      ...base.rodizio,
      grupoUraDefinido: true,
      gruposRobosIds: [6],
      pollUraMs: 500,
      minRobosDesligadosMs: 3000,
      descricoesStatus: { livres: ['livre'], atendimento: ['em atendimento'], offline: [] },
    },
  };
  const { avisos } = validarConfig(comAntigos, { escopo: 'rodizio' });
  for (const nome of ['POLL_URA_MS', 'MIN_ROBOS_OFF_MS', 'STATUS_ATENDIMENTO', 'STATUS_OFFLINE']) {
    assert.ok(avisos.some((a) => a.startsWith(nome)), `aviso de ${nome}`);
  }

  const deslogarSemPlantao = { ...base, rotinas: { ...base.rotinas, fimExpediente: { ...base.rotinas.fimExpediente, ativo: true, acao: 'deslogar', ignorarRamais: [] } } };
  assert.match(validarConfig(deslogarSemPlantao, { escopo: 'rotinas' }).avisos.join(), /plantão/);
});

test('URA → Ativo: não movido volta ao grupo do supervisor; sem grupo, fica e avisa uma vez', async () => {
  const { RodizioService } = require('../../src/rodizio/rodizio.service');
  const avisos = [];
  const transferidos = [];
  const grupos = { 201: 1 };
  const svc = new RodizioService({
    client: {},
    transferencias: { async transferir(ramal, destino) { transferidos.push(`${ramal}→${destino}`); return true; } },
    robos: {},
    repositorio: { salvar: async () => {} },
    logger: { ...loggerNulo, aviso: (m) => avisos.push(m) },
    cfg: { tempoNaUraMs: 180_000 },
    diretorio: { atualizar: async () => {}, grupoAtivoDoOperador: (r) => grupos[r] ?? null },
  });
  const ocioso = { classe: Classe.LIVRE, ts: Date.now(), livreDesde: Date.now() - 200_000 };
  svc.statusUra.set('201', ocioso).set('202', ocioso);
  svc.ramaisUra = new Set(['201', '202']);
  svc.movidos = { 203: { origemGrupoId: 3, entrouEm: 0 } };
  svc.statusUra.set('203', ocioso);

  for (const r of ['201', '202', '203']) assert.ok(svc.deveDevolver(r, Date.now()), `${r} ocioso há mais de 3 min`);
  for (const r of ['201', '202', '202', '203']) await svc.devolverAoAtivo(r);
  assert.deepEqual(transferidos, ['201→1', '203→3'], 'supervisor para o 201, origem para o movido 203');
  assert.equal(avisos.length, 1, '202 sem grupo: um aviso só');
  assert.ok(svc.ramaisUra.has('202'));
});

test('decidirRobos: como na operação manual — redução parcial só confirmada, alvo 0 na hora, subida em degraus', () => {
  const agora = 100_000;
  const st = (pares) => new Map(Object.entries(pares).map(([r, classe]) => [r, { classe, ts: agora }]));
  const cfg = { reativar: true, minDesligadoMs: 0, porLivre: 7, reduzirAposMs: 10_000, intervaloSubidaMs: 10_000 };
  const d = (status, robos) => decidirRobos({ ramaisUra: Object.keys(status), status: st(status), agora, robos: { total: 58, ultimaReducao: 0, ...robos }, cfg });

  // 1 livre (alvo 7) com 20 ligados: excesso recém-surgido espera; confirmado há 10 s reduz.
  assert.equal(d({ 1: 'livre' }, { ligados: 20, excessoDesde: null }).acao, AcaoRobos.NENHUMA);
  assert.equal(d({ 1: 'livre' }, { ligados: 20, excessoDesde: agora - 5_000 }).acao, AcaoRobos.NENHUMA);
  assert.equal(d({ 1: 'livre' }, { ligados: 20, excessoDesde: agora - 10_000 }).acao, AcaoRobos.DESLIGAR);
  assert.ok(d({ 1: 'livre' }, { ligados: 20, excessoDesde: null }).excesso);

  // Ninguém livre: desliga na hora, sem esperar.
  assert.equal(d({ 1: 'atendimento' }, { ligados: 20, excessoDesde: null }).acao, AcaoRobos.DESLIGAR);

  // Subida: só depois do intervalo desde o último aumento.
  assert.equal(d({ 1: 'livre', 2: 'livre' }, { ligados: 7, ultimoAumento: agora - 5_000 }).acao, AcaoRobos.NENHUMA);
  assert.equal(d({ 1: 'livre', 2: 'livre' }, { ligados: 7, ultimoAumento: agora - 10_000 }).acao, AcaoRobos.RELIGAR);
});

test('ControleRobos.aumentar: sobe no máximo um degrau por vez', async () => {
  const logados = [];
  const client = { async logarOperadorVirtual(r) { logados.push(r); } };
  const ramais = Array.from({ length: 20 }, (_, i) => String(900 + i));
  const robos = new ControleRobos({ client, cfg: { dryRun: false, concorrencia: 5, descricoesStatus: DESC_ROBOS, degrauSubida: 7 }, logger: loggerNulo });
  robos.ligados = new Set();

  await robos.aumentar(ramais, 20, 'teste');
  assert.equal(logados.length, 7);
  await robos.aumentar(ramais, 20, 'teste');
  await robos.aumentar(ramais, 20, 'teste');
  assert.equal(logados.length, 20, '7 + 7 + 6');
  assert.ok(robos.situacao(20).ultimoAumento > 0);
});

test('ultimoLivreQueSai: se todos os livres vão sair, o último é o ocioso há menos tempo; havendo outro livre, ninguém', () => {
  const status = new Map([
    ['1', { classe: Classe.LIVRE, livreDesde: 0 }],
    ['2', { classe: Classe.LIVRE, livreDesde: 10_000 }],
    ['3', { classe: Classe.ATENDIMENTO }],
    ['4', { classe: Classe.OFFLINE }],
  ]);
  const ramaisUra = ['1', '2', '3', '4'];
  assert.equal(ultimoLivreQueSai({ saindo: ['1', '2', '4'], ramaisUra, status }), '2', 'todos os livres sairiam: o último é o de menor ociosidade');
  assert.equal(ultimoLivreQueSai({ saindo: ['1'], ramaisUra, status }), null, 'o 2 continua livre na URA');
  assert.equal(ultimoLivreQueSai({ saindo: ['4'], ramaisUra: ['3', '4'], status }), null, 'offline não conta');
  assert.equal(ultimoLivreQueSai({ saindo: [], ramaisUra, status }), null);
});

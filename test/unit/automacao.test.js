'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lerAutomacao, gravarAutomacao, aguardarAutomacaoLigada, lerSimulacao } = require('../../src/utils/automacao');
const { carregarConfig } = require('../../src/config');
const { ControleAutomacao } = require('../../src/painel/automacao');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const arquivoTemp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'automacao-')), 'state-automacao.json');

test('automação: sem arquivo está ligada; desligada espera (sem tocar em nada) até religar', async () => {
  const arquivo = arquivoTemp();
  assert.equal(lerAutomacao(arquivo).desligada, false);
  await aguardarAutomacaoLigada({ arquivo }, loggerNulo, 'teste'); // ligada: volta na hora

  await gravarAutomacao(arquivo, { desligada: true, desde: '2026-10-21T11:00:00.000Z', por: '192.168.0.5' }, loggerNulo);
  assert.deepEqual(lerAutomacao(arquivo), { desligada: true, desde: '2026-10-21T11:00:00.000Z', por: '192.168.0.5', componentes: {} });
  const avisos = [];
  let esperas = 0;
  await aguardarAutomacaoLigada({ arquivo, intervaloMs: 1 }, { ...loggerNulo, aviso: (m) => avisos.push(m) }, 'rodízio', {
    esperar: async () => { if (++esperas === 3) await gravarAutomacao(arquivo, { desligada: false }, loggerNulo); },
  });
  assert.equal(esperas, 3);
  assert.match(avisos[0], /^Automação desligada pelo painel em 2026-10-21T11:00:00.000Z \(192.168.0.5\): o rodízio espera/);
  assert.match(avisos[1], /religada/);
});

/** Painel com rodízio e PM2 falsos. */
function montarControle({ ligadosPorChamada = [2, 1, 0], rodizioFora = false, esperaRobosMs = 60_000, dryRunPeloEnv = false } = {}) {
  const arquivo = arquivoTemp();
  const arquivoSimulacao = path.join(path.dirname(arquivo), 'state-simulacao.json');
  const chamadas = [];
  let relogio = 0;
  let n = 0;
  const servicos = {
    chamar: async (servico, caminho, { corpo }) => {
      chamadas.push(`${servico} ${caminho} ${corpo}`);
      if (rodizioFora) return { status: 0, corpo: { erro: 'Rodízio e robôs fora do ar' } };
      const ligados = JSON.parse(corpo).derrubar ? 0 : ligadosPorChamada[Math.min(n++, ligadosPorChamada.length - 1)];
      return { status: 200, corpo: { ligados } };
    },
  };
  const executar = async (comando, args) => { chamadas.push(`$ ${comando} ${args.join(' ')}`); return { ok: true, saida: '' }; };
  const controle = new ControleAutomacao({
    cfg: { arquivo, esperaRobosMs, arquivoSimulacao, dryRunPeloEnv }, servicos, executar, logger: loggerNulo, agora: () => relogio, esperar: async (ms) => { relogio += ms; },
  });
  const terminar = async () => { while (controle.andamento) await new Promise((r) => setImmediate(r)); };
  return { controle, chamadas, arquivo, arquivoSimulacao, terminar };
}

test('desligar: marca, desliga os robôs (esperando os em ligação) e só então para os serviços; religar sobe de novo', async () => {
  const { controle, chamadas, arquivo, terminar } = montarControle();
  assert.equal(controle.estado().estado, 'ligada');
  assert.deepEqual(controle.desligar('10.0.0.7'), { iniciado: true });
  assert.equal(controle.estado().estado, 'desligando');
  assert.equal(controle.desligar('10.0.0.7').iniciado, false, 'não desliga duas vezes ao mesmo tempo');
  await terminar();

  assert.deepEqual(chamadas, [
    'rodizio /automacao/encerrar-robos {"derrubar":false}',
    'rodizio /automacao/encerrar-robos {"derrubar":false}',
    'rodizio /automacao/encerrar-robos {"derrubar":false}',
    '$ npx pm2 stop benura-roteador benura-rodizio benura-rotinas',
  ]);
  assert.equal(lerAutomacao(arquivo).desligada, true);
  assert.equal(controle.estado().estado, 'desligada');
  assert.equal(controle.estado().por, '10.0.0.7');
  assert.equal(controle.desligar('x').motivo, 'A automação já está desligada.');

  chamadas.length = 0;
  controle.religar('10.0.0.7');
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 startOrRestart ecosystem.config.js --only benura-roteador,benura-rodizio,benura-rotinas']);
  assert.equal(lerAutomacao(arquivo).desligada, false);
  assert.equal(controle.estado().estado, 'ligada');
});

test('desligar: robô que não sai até o prazo é derrubado; rodízio fora do ar só avisa e os serviços param mesmo assim', async () => {
  const lento = montarControle({ ligadosPorChamada: [3, 3, 3, 3], esperaRobosMs: 10_000 });
  lento.controle.desligar('x');
  await lento.terminar();
  assert.ok(lento.chamadas.includes('rodizio /automacao/encerrar-robos {"derrubar":true}'), 'derruba depois do prazo');
  assert.equal(lento.chamadas.at(-1), '$ npx pm2 stop benura-roteador benura-rodizio benura-rotinas');

  const fora = montarControle({ rodizioFora: true });
  fora.controle.desligar('x');
  await fora.terminar();
  assert.match(fora.controle.estado().aviso, /desligue os robôs pelo painel da Argus/);
  assert.equal(fora.chamadas.at(-1), '$ npx pm2 stop benura-roteador benura-rodizio benura-rotinas');
});

test('rodízio: ao desligar a automação, para de mover gente e de decidir robôs; desliga os parados ou derruba todos', async () => {
  const chamadas = [];
  const robos = {
    ligados: new Set(['900', '901']),
    async sincronizar() { chamadas.push('sincronizar'); },
    async encerrarSemDerrubar(m) { chamadas.push(`encerrar (${m})`); this.ligados.delete('900'); },
    async desligar(r, m) { chamadas.push(`desligar ${r.join(',')} (${m})`); this.ligados.clear(); },
  };
  const svc = new RodizioService({ client: {}, transferencias: {}, robos, repositorio: {}, logger: loggerNulo, cfg: { robosModo: 'panico' } });
  svc.ramaisRobos = ['900', '901'];
  assert.deepEqual(await svc.encerrarRobosParaDesligar(), { ligados: 1 });
  assert.equal(await svc.cicloAtivo(), undefined, 'não move ninguém');
  assert.equal(await svc.aplicarDecisaoDosRobos(), undefined);
  assert.deepEqual(await svc.encerrarRobosParaDesligar({ derrubar: true }), { ligados: 0 });
  assert.deepEqual(chamadas, [
    'sincronizar', 'encerrar (automação desligada pelo painel)', 'sincronizar', 'desligar 901 (automação desligada pelo painel)',
  ]);
});

test('simulação: o arquivo do painel liga o DRY_RUN; o .env com DRY_RUN=1 continua valendo sozinho', async () => {
  const arquivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'simulacao-')), 'state-simulacao.json');
  const antes = { ...process.env };
  try {
    Object.assign(process.env, { SIMULACAO_FILE: arquivo, DRY_RUN: '0' });
    assert.equal(carregarConfig().argus.dryRun, false);
    await gravarAutomacao(arquivo, { ligada: true }, loggerNulo);
    assert.equal(carregarConfig().argus.dryRun, true, 'ligado pelo painel');
    assert.equal(carregarConfig().argus.dryRunPeloEnv, false);
    await gravarAutomacao(arquivo, { ligada: false }, loggerNulo);
    process.env.DRY_RUN = '1';
    assert.equal(carregarConfig().argus.dryRun, true, 'o .env vence o arquivo desligado');
  } finally {
    for (const k of ['SIMULACAO_FILE', 'DRY_RUN']) { if (k in antes) process.env[k] = antes[k]; else delete process.env[k]; }
  }
});

test('simulação pelo painel: grava e reinicia os serviços; com a automação desligada só grava; fixa pelo .env não desliga', async () => {
  const { controle, chamadas, arquivo, arquivoSimulacao, terminar } = montarControle();
  assert.deepEqual(controle.definirSimulacao(true, '10.0.0.7'), { iniciado: true });
  assert.equal(controle.estado().estado, 'reiniciando');
  assert.equal(controle.desligar('x').iniciado, false, 'um de cada vez');
  await terminar();
  assert.equal(lerSimulacao(arquivoSimulacao).ligada, true);
  assert.deepEqual(chamadas, ['$ npx pm2 startOrRestart ecosystem.config.js --only benura-roteador,benura-rodizio,benura-rotinas']);
  assert.deepEqual(controle.estado().simulacao, { escolhida: true, fixaPeloEnv: false, desde: lerSimulacao(arquivoSimulacao).desde, por: '10.0.0.7' });
  assert.match(controle.definirSimulacao(true, 'x').motivo, /já está ligada/);

  chamadas.length = 0;
  await gravarAutomacao(arquivo, { desligada: true }, loggerNulo);
  controle.definirSimulacao(false, 'x');
  await terminar();
  assert.equal(lerSimulacao(arquivoSimulacao).ligada, false);
  assert.deepEqual(chamadas, [], 'automação desligada: só grava');

  const fixa = montarControle({ dryRunPeloEnv: true });
  await gravarAutomacao(fixa.arquivoSimulacao, { ligada: true }, loggerNulo);
  assert.match(fixa.controle.definirSimulacao(false, 'x').motivo, /fixa pelo \.env/);
});

// ---------------------------------------------------------------------------
// [NOVO] Cada componente (roteador, rodízio, rotinas) liga e desliga sozinho.
// ---------------------------------------------------------------------------
const { componenteAtivo } = require('../../src/utils/automacao');

test('componente: arquivo antigo (sem componentes) = tudo ligado; a regra única é global E componente', async () => {
  const arquivo = arquivoTemp();
  await gravarAutomacao(arquivo, { desligada: false }, loggerNulo);
  const e = lerAutomacao(arquivo);
  assert.deepEqual(e.componentes, {});
  assert.equal(componenteAtivo(e, 'benura-rodizio'), true);
  assert.equal(componenteAtivo({ desligada: false, componentes: { 'benura-rodizio': { desligado: true } } }, 'benura-rodizio'), false);
  assert.equal(componenteAtivo({ desligada: false, componentes: { 'benura-rodizio': { desligado: true } } }, 'benura-roteador'), true);
  assert.equal(componenteAtivo({ desligada: true, componentes: {} }, 'benura-roteador'), false);
});

test('componente: desligar o rodízio desliga os robôs antes e para só ele; religar sobe só ele', async () => {
  const { controle, chamadas, arquivo, terminar } = montarControle({ ligadosPorChamada: [0] });
  assert.deepEqual(controle.desligarComponente('benura-rodizio', 'ana@e.com'), { iniciado: true });
  await terminar();
  assert.deepEqual(chamadas, ['rodizio /automacao/encerrar-robos {"derrubar":false}', '$ npx pm2 stop benura-rodizio']);
  const e = controle.estado();
  assert.equal(e.estado, 'ligada', 'a automação continua ligada');
  assert.equal(e.componentes['benura-rodizio'].desligado, true);
  assert.equal(e.componentes['benura-rodizio'].por, 'ana@e.com');
  assert.equal(controle.desligarComponente('benura-rodizio', 'x').iniciado, false, 'já está desligado');

  chamadas.length = 0;
  assert.deepEqual(controle.religarComponente('benura-rodizio', 'ana@e.com'), { iniciado: true });
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 startOrRestart ecosystem.config.js --only benura-rodizio']);
  assert.equal(lerAutomacao(arquivo).componentes['benura-rodizio'], undefined);
});

test('componente: roteador e rotinas param sem mexer nos robôs; app fora da lista é recusado', async () => {
  const { controle, chamadas, terminar } = montarControle();
  controle.desligarComponente('benura-roteador', 'x');
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 stop benura-roteador']);
  assert.equal(controle.desligarComponente('benura-painel', 'x').iniciado, false);
  assert.equal(controle.desligarComponente('qualquer', 'x').iniciado, false);
});

test('componente: desligar e religar a automação toda mantém quem foi desligado à mão', async () => {
  const { controle, chamadas, arquivo, terminar } = montarControle({ ligadosPorChamada: [0] });
  controle.desligarComponente('benura-rotinas', 'x');
  await terminar();
  controle.desligar('agenda do BenURA');
  await terminar();
  assert.equal(lerAutomacao(arquivo).componentes['benura-rotinas'].desligado, true, 'o desligar global não apaga a marca');
  chamadas.length = 0;
  controle.religar('agenda do BenURA');
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 startOrRestart ecosystem.config.js --only benura-roteador,benura-rodizio'], 'as rotinas continuam paradas');
  assert.equal(lerAutomacao(arquivo).desligada, false);
  assert.equal(lerAutomacao(arquivo).componentes['benura-rotinas'].desligado, true);
});

test('componente: com a automação toda desligada, religar um componente só tira a marca (sobe ao religar tudo)', async () => {
  const { controle, chamadas, arquivo, terminar } = montarControle({ ligadosPorChamada: [0] });
  controle.desligarComponente('benura-rotinas', 'x');
  await terminar();
  controle.desligar('x');
  await terminar();
  chamadas.length = 0;
  assert.equal(controle.religarComponente('benura-rotinas', 'x').iniciado, true);
  await terminar();
  assert.deepEqual(chamadas, [], 'nada sobe com a automação desligada');
  assert.equal(lerAutomacao(arquivo).componentes['benura-rotinas'], undefined);
});

test('componente: a simulação reinicia só os ligados; com os três desligados, este PC não age de verdade', async () => {
  const { controle, chamadas, terminar } = montarControle({ ligadosPorChamada: [0] });
  controle.desligarComponente('benura-roteador', 'x');
  await terminar();
  chamadas.length = 0;
  controle.definirSimulacao(true, 'x');
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 startOrRestart ecosystem.config.js --only benura-rodizio,benura-rotinas']);
  controle.definirSimulacao(false, 'x');
  await terminar();
  assert.equal(controle.agindoDeVerdade(), true);
  for (const app of ['benura-rodizio', 'benura-rotinas']) {
    controle.desligarComponente(app, 'x');
    await terminar();
  }
  assert.equal(controle.agindoDeVerdade(), false, 'os três parados: solta a trava dos dois PCs');
});

test('componente: o serviço desligado à mão espera ao subir (pm2 start all, reinício do PC)', async () => {
  const arquivo = arquivoTemp();
  await gravarAutomacao(arquivo, { desligada: false, componentes: { 'benura-rodizio': { desligado: true, desde: '2026-10-27T13:00:00.000Z', por: 'ana' } } }, loggerNulo);
  const avisos = [];
  let esperas = 0;
  await aguardarAutomacaoLigada({ arquivo, intervaloMs: 1 }, { ...loggerNulo, aviso: (m) => avisos.push(m) }, 'rodízio', {
    app: 'benura-rodizio',
    esperar: async () => { if (++esperas === 2) await gravarAutomacao(arquivo, { desligada: false, componentes: {} }, loggerNulo); },
  });
  assert.equal(esperas, 2);
  assert.match(avisos[0], /rodízio desligado pelo painel/i);
  await aguardarAutomacaoLigada({ arquivo }, loggerNulo, 'roteador', { app: 'benura-roteador' }); // outro componente não espera
});

test('componente: rodízio já desligado à mão, desligar tudo não chama o rodízio (os robôs saíram antes)', async () => {
  const { controle, chamadas, terminar } = montarControle({ ligadosPorChamada: [0] });
  controle.desligarComponente('benura-rodizio', 'x');
  await terminar();
  chamadas.length = 0;
  controle.desligar('x');
  await terminar();
  assert.deepEqual(chamadas, ['$ npx pm2 stop benura-roteador benura-rodizio benura-rotinas']);
  assert.equal(controle.estado().aviso, null, 'sem o aviso de "rodízio sem resposta"');
});

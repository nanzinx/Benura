'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lerAutomacao, gravarAutomacao, aguardarAutomacaoLigada } = require('../../src/utils/automacao');
const { ControleAutomacao } = require('../../src/painel/automacao');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { loggerNulo } = require('../../src/utils/logger');

const arquivoTemp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'automacao-')), 'state-automacao.json');

test('automação: sem arquivo está ligada; desligada espera (sem tocar em nada) até religar', async () => {
  const arquivo = arquivoTemp();
  assert.equal(lerAutomacao(arquivo).desligada, false);
  await aguardarAutomacaoLigada({ arquivo }, loggerNulo, 'teste'); // ligada: volta na hora

  await gravarAutomacao(arquivo, { desligada: true, desde: '2026-10-21T11:00:00.000Z', por: '192.168.0.5' }, loggerNulo);
  assert.deepEqual(lerAutomacao(arquivo), { desligada: true, desde: '2026-10-21T11:00:00.000Z', por: '192.168.0.5' });
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
function montarControle({ ligadosPorChamada = [2, 1, 0], rodizioFora = false, esperaRobosMs = 60_000 } = {}) {
  const arquivo = arquivoTemp();
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
    cfg: { arquivo, esperaRobosMs }, servicos, executar, logger: loggerNulo, agora: () => relogio, esperar: async (ms) => { relogio += ms; },
  });
  const terminar = async () => { while (controle.andamento) await new Promise((r) => setImmediate(r)); };
  return { controle, chamadas, arquivo, terminar };
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

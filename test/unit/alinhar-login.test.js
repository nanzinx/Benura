'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { alinharLogin, Alinhamento } = require('../../src/integrations/argus/alinhar-login');
const { loggerNulo } = require('../../src/utils/logger');
const { montarArgusMock } = require('./helpers');

/**
 * Argus mínima: `grupoLogado` é onde a telefonia está; `vinculo`, o grupo da lista.
 * `logarMuda`: se logaroperador leva a sessão para o vínculo (senão, só deslogar+logar leva).
 */
function argus({ status = 'Livre', pausa = '', grupoLogado = 19, vinculo = 7, logarMuda = true, falhar = false } = {}) {
  const chamadas = [];
  const estado = { logado: status !== null, grupoLogado };
  return {
    chamadas,
    estado,
    async statusOperador() {
      if (falhar) throw new Error('timeout');
      return estado.logado ? { descricaoStatus: status, descricaoPausa: pausa, idGrupo: estado.grupoLogado, grupo: `G${estado.grupoLogado}` } : null;
    },
    async logarOperador(ramal) {
      chamadas.push(['logar', ramal]);
      if (logarMuda || !estado.logado) estado.grupoLogado = vinculo;
      estado.logado = true;
    },
    async deslogarOperador(ramal) {
      chamadas.push(['deslogar', ramal]);
      estado.logado = false;
    },
  };
}

const alinhar = (client, extra = {}) => alinharLogin({ client, ramal: '2266688', idGrupo: 7, log: loggerNulo, esperaMs: 0, ...extra });

test('alinharLogin: já no grupo certo ou deslogado → não mexe', async () => {
  const certo = argus({ grupoLogado: 7 });
  assert.equal(await alinhar(certo), Alinhamento.OK);
  const fora = argus({ status: null });
  assert.equal(await alinhar(fora), Alinhamento.DESLOGADO);
  assert.deepEqual([...certo.chamadas, ...fora.chamadas], []);
});

test('alinharLogin: em ligação ou em pausa → espera (não derruba ninguém)', async () => {
  const emLigacao = argus({ status: 'Atendimento' });
  const pausado = argus({ status: 'Livre', pausa: 'Almoço' });
  assert.equal(await alinhar(emLigacao), Alinhamento.AGUARDANDO);
  assert.equal(await alinhar(pausado), Alinhamento.AGUARDANDO);
  assert.deepEqual([...emLigacao.chamadas, ...pausado.chamadas], []);
});

test('alinharLogin: livre em outro grupo → loga de novo e confere (o caso do Pedro)', async () => {
  const a = argus();
  assert.equal(await alinhar(a), Alinhamento.RELOGADO);
  assert.deepEqual(a.chamadas, [['logar', '2266688']]);
  assert.equal(a.estado.grupoLogado, 7);
});

test('alinharLogin: se só logar não muda a sessão, desloga e loga (como o operador faria)', async () => {
  const a = argus({ logarMuda: false });
  assert.equal(await alinhar(a), Alinhamento.RELOGADO);
  assert.deepEqual(a.chamadas, [['logar', '2266688'], ['deslogar', '2266688'], ['logar', '2266688']]);
});

test('alinharLogin: vínculo diferente do esperado → não insiste nem desloga', async () => {
  const a = argus({ vinculo: 3 });
  assert.equal(await alinhar(a), Alinhamento.OUTRO_VINCULO);
  assert.deepEqual(a.chamadas, [['logar', '2266688']]);
});

test('alinharLogin: DRY_RUN só registra; erro da Argus vira FALHOU com aviso', async () => {
  const linhas = [];
  const a = argus();
  assert.equal(await alinhar(a, { dryRun: true, log: { ...loggerNulo, info: (m) => linhas.push(m) } }), Alinhamento.SIMULADO);
  assert.deepEqual(a.chamadas, []);
  assert.match(linhas[0], /\[DRY_RUN\] Relogaria ramal 2266688 no grupo 7 \(hoje logado em "G19" \(19\)\)/);

  const avisos = [];
  assert.equal(await alinhar(argus({ falhar: true }), { log: { ...loggerNulo, aviso: (m) => avisos.push(m) } }), Alinhamento.FALHOU);
  assert.match(avisos[0], /deslogar e logar/);
});

test('roteador: depois de transferir, alinha o login (e não alinha com a opção desligada)', async () => {
  for (const alinharLoginLigado of [true, false]) {
    const { discadora, client } = montarArgusMock({ cfg: { alinharLogin: alinharLoginLigado, esperaLoginMs: 0 } });
    const logados = [];
    client.statusOperador = async () => ({ descricaoStatus: 'Livre', idGrupo: logados.length ? 2 : 1 });
    client.logarOperador = async (ramal) => { logados.push(ramal); };
    const r = await discadora.moverPara('1001', 'URA');
    assert.equal(r.resultado, 'TRANSFERIDO');
    assert.deepEqual(logados, alinharLoginLigado ? ['1001'] : []);
    assert.equal(r.login, alinharLoginLigado ? Alinhamento.RELOGADO : null);
  }
});

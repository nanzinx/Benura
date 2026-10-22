'use strict';
/** [NOVO] DADOS_DIR: com ela, estado, chaves, logs e os JSON da esteira vão para a pasta dos dados (Docker: /dados). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

function config(env) {
  const antes = { ...process.env };
  Object.assign(process.env, { BENURA_SEM_DOTENV: '1', ...env });
  delete require.cache[require.resolve('../../src/config')];
  try {
    return require('../../src/config').carregarConfig();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
}

test('DADOS_DIR: sem ela, tudo fica onde sempre ficou; com ela, vai para a pasta dos dados', () => {
  const raiz = path.resolve(__dirname, '..', '..');
  const padrao = config({ DADOS_DIR: '' });
  assert.equal(padrao.rodizio.arquivoEstado, path.join(raiz, 'state.json'));
  assert.equal(padrao.arquivoSupervisoresGrupos, path.join(process.cwd(), 'supervisores-grupos.json'));

  const dados = path.resolve('/dados');
  const c = config({ DADOS_DIR: '/dados' });
  for (const arquivo of [c.rodizio.arquivoEstado, c.painel.arquivoSegredo, c.automacao.arquivoTravas, c.arquivoSupervisoresGrupos, c.rotinas.arquivoEstado]) {
    assert.equal(path.dirname(arquivo), dados, arquivo);
  }
  assert.equal(c.logs.pasta, path.join(dados, 'logs'));
  assert.equal(config({ DADOS_DIR: '/dados', RODIZIO_STATE_FILE: '/outro/state.json' }).rodizio.arquivoEstado, '/outro/state.json', 'o arquivo específico vence');
});

'use strict';
/**
 * Testes da configuração de grupos de robôs (IDs e Nomes).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarConfig, validarConfig } = require('../../src/config');

function carregar(env = {}) {
  const antes = { ...process.env };
  Object.assign(process.env, {
    BENURA_SEM_DOTENV: '1',
    ARGUS_TOKEN: 'teste-token',
    GRUPO_URA_ID: '2',
    GRUPOS_ATIVOS_IDS: '1',
  });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../../src/config')];
  try {
    const config = require('../../src/config');
    const cfg = config.carregarConfig();
    const validacao = config.validarConfig(cfg, { escopo: 'rodizio' });
    return { cfg, ...validacao };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
}

test('config: padrão de gruposRobosNomes é ["URA PORT"]', () => {
  const { cfg } = carregar({ GRUPOS_ROBOS_URA_NOMES: undefined });
  assert.deepEqual(cfg.rodizio.gruposRobosNomes, ['URA PORT']);
});

test('config: GRUPOS_ROBOS_URA_NOMES vazio resulta em []', () => {
  const { cfg } = carregar({ GRUPOS_ROBOS_URA_NOMES: '', GRUPOS_ROBOS_URA_IDS: '6' });
  assert.deepEqual(cfg.rodizio.gruposRobosNomes, []);
});

test('config: só nomes é válido (sem GRUPOS_ROBOS_URA_IDS)', () => {
  const { fatais, cfg } = carregar({
    GRUPOS_ROBOS_URA_IDS: '',
    GRUPO_ROBOS_URA_ID: '',
    GRUPOS_ROBOS_URA_NOMES: 'URA PORT',
  });
  assert.equal(cfg.rodizio.gruposRobosIds.length, 0);
  assert.deepEqual(cfg.rodizio.gruposRobosNomes, ['URA PORT']);
  assert.deepEqual(fatais, [], 'nenhum erro fatal quando há nomes');
});

test('config: sem nomes e sem IDs é inválido', () => {
  const { fatais } = carregar({
    GRUPOS_ROBOS_URA_IDS: '',
    GRUPO_ROBOS_URA_ID: '',
    GRUPOS_ROBOS_URA_NOMES: '',
  });
  assert.ok(fatais.some((f) => f.includes('GRUPOS_ROBOS_URA_IDS ou GRUPOS_ROBOS_URA_NOMES')));
});

test('config: o grupo da URA entre os robôs continua proibido', () => {
  const { fatais } = carregar({
    GRUPO_URA_ID: '2',
    GRUPOS_ROBOS_URA_IDS: '2,6',
    GRUPOS_ROBOS_URA_NOMES: '',
  });
  assert.ok(fatais.some((f) => f.includes('GRUPOS_ROBOS_URA_IDS não pode conter o GRUPO_URA_ID')));
});

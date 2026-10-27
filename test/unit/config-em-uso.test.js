'use strict';
/** [NOVO] "Configuração em uso" do painel: o que o BenURA leu do .env e o padrão de cada opção, sem segredos. */
const test = require('node:test');
const assert = require('node:assert/strict');

function emUso(env) {
  const antes = { ...process.env };
  Object.assign(process.env, { BENURA_SEM_DOTENV: '1', ...env });
  delete require.cache[require.resolve('../../src/config')];
  try {
    const config = require('../../src/config');
    config.carregarConfig();
    return config.opcoesEmUso();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
}
const achar = (lista, nome) => lista.find((o) => o.nome === nome);

test('config em uso: mostra o padrão e, quando veio do .env, o valor lido', () => {
  const opcoes = emUso({ TEMPO_MIN: '', AGENDA_DESLIGAR: '17:30' });
  assert.deepEqual(achar(opcoes, 'TEMPO_MIN'), { nome: 'TEMPO_MIN', valor: '2', padrao: '2', doEnv: false });
  assert.deepEqual(achar(opcoes, 'AGENDA_DESLIGAR'), { nome: 'AGENDA_DESLIGAR', valor: '17:30', padrao: '18:00', doEnv: true });
  assert.deepEqual(opcoes.map((o) => o.nome), [...opcoes.map((o) => o.nome)].sort(), 'em ordem de nome');
});

test('config em uso: segredo nunca aparece, só se está definido', () => {
  const opcoes = emUso({ ARGUS_TOKEN: 'abc123segredo', WEBHOOK_TOKEN: '', PAINEL_SENHA: 'senha-forte-123', TRAVA_ACCESS_CLIENT_SECRET: 'xyz-segredo-2' });
  assert.equal(achar(opcoes, 'ARGUS_TOKEN').valor, 'definido');
  assert.equal(achar(opcoes, 'WEBHOOK_TOKEN').valor, 'vazio');
  const json = JSON.stringify(opcoes);
  for (const s of ['abc123segredo', 'senha-forte-123', 'xyz-segredo-2']) assert.ok(!json.includes(s), s);
  assert.equal(achar(emUso({ NOTIFICACOES_WEBHOOK_URL: 'https://hooks.exemplo.com/T0/B0/segredo-no-caminho' }), 'NOTIFICACOES_WEBHOOK_URL').valor, 'definido', 'URL de webhook leva o segredo no caminho');
  assert.equal(achar(emUso({ ARGUS_BASE: 'https://ana:minha-senha@argus.exemplo.com/api' }), 'ARGUS_BASE').valor, 'https://***@argus.exemplo.com/api', 'senha dentro do endereço também não sai');
});

test('config em uso: carregar de novo não acumula o que foi lido antes', () => {
  const antes = { ...process.env };
  Object.assign(process.env, { BENURA_SEM_DOTENV: '1' });
  delete require.cache[require.resolve('../../src/config')];
  try {
    const config = require('../../src/config');
    config.carregarConfig();
    const n = config.opcoesEmUso().length;
    config.carregarConfig();
    assert.equal(config.opcoesEmUso().length, n);
  } finally {
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
});

test('faxina: VERIFICAR_NOVO_DIA_MS (nunca usada) não é mais lida', () => {
  assert.equal(achar(emUso({}), 'VERIFICAR_NOVO_DIA_MS'), undefined);
});

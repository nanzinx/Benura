'use strict';
/** [NOVO] Respostas da Argus viram fixtures de teste sem nenhum dado pessoal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Sanitizador, dadosPessoais } = require('../../src/domain/sanitizar-argus');

const ligacao = {
  idLigacao: '20261027100312000045', dataHoraLigacao: '2026-10-27 10:03:12', resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA',
  usuarioOperador: 'Maria Aparecida Souza', ramal: '2266423', tempoSegundos: 41,
  dddTelefone: '11987654321', telefone2: '(11) 98765-4321', nomeCliente: 'José da Silva', cpfCnpj: '123.456.789-09',
  email: 'jose@exemplo.com', camposCRM: { banco: 'X', margem: 900 }, historico: [{ obs: 'ligar depois' }], idLote: 77, nrLead: 991,
};

test('sanitizar: tira cliente, telefone, CPF, e-mail; troca nomes e ramais por apelidos fixos; mantém campos e tipos', () => {
  const s = new Sanitizador();
  const [a, b] = s.limpar([ligacao, { ...ligacao, idLigacao: '20261027100500000046' }]);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(ligacao).sort(), 'os nomes dos campos ficam (é o que os parsers leem)');
  assert.equal(a.usuarioOperador, 'Operador 1');
  assert.equal(b.usuarioOperador, 'Operador 1', 'o mesmo nome vira o mesmo apelido');
  assert.equal(a.ramal, '900001');
  assert.equal(a.resultadoLigacao, 'OPER. VIRTUAL - ABANDONO EM FILA', 'o resultado fica');
  assert.equal(a.dataHoraLigacao, '2026-10-27 10:03:12');
  assert.equal(a.tempoSegundos, 41);
  assert.equal(a.idLigacao, '20261027100312000045', 'ids da Argus ficam');
  for (const campo of ['dddTelefone', 'telefone2', 'nomeCliente', 'cpfCnpj', 'email']) assert.equal(a[campo], '(removido)', campo);
  assert.deepEqual(a.camposCRM, {});
  assert.deepEqual(a.historico, []);
  assert.deepEqual(dadosPessoais([a, b]), []);
});

test('sanitizar: statusoperador e listargrupos (nome, ramais em lista, grupos)', () => {
  const s = new Sanitizador();
  const status = s.limpar({ ramal: '2266423', nome: 'Maria Aparecida Souza', descricaoStatus: 'Livre', descricaoPausa: '', tempoStatus: 95000, idGrupo: 12, grupo: 'URA RECEPTIVO' });
  assert.deepEqual(status, { ramal: '900001', nome: 'Operador 1', descricaoStatus: 'Livre', descricaoPausa: '', tempoStatus: 95000, idGrupo: 12, grupo: 'URA RECEPTIVO' });
  const [grupo] = s.limpar([{ idGrupoUsuario: 12, descricao: 'URA RECEPTIVO', ramaisOperadores: ['2266423', 2266500], idTipoGrupo: 1 }]);
  assert.deepEqual(grupo.ramaisOperadores, ['900001', 900002], 'o mesmo ramal vira o mesmo apelido, e número continua número');
});

test('dadosPessoais: acha o que escapou (telefone, CPF, e-mail) fora dos campos de id e data', () => {
  assert.deepEqual(dadosPessoais({ obs: 'ligar 11987654321', idLigacao: '20261027100312000045', dataHoraLigacao: '2026-10-27 10:03:12' }), ['obs: telefone']);
  assert.deepEqual(dadosPessoais([{ x: 'cpf 123.456.789-09' }, { y: 'a@b.com' }]), ['[0].x: CPF', '[1].y: e-mail']);
});

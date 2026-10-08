'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Resultado } = require('../../src/integrations/argus/discadora.service');
const { montarArgusMock, grupoAtual } = require('./helpers');

// Argus simulada: grupo 1 GABRIEL (Ativo), 3 MAYSA (Ativo), 2 URA, 9 TREINAMENTO.
// 1001/1002/1004 → grupo 1 (Gabriel); 1005/1006/1008 → grupo 3 (Maysa);
// 1003 → URA (supervisora Maysa); 1007 → TREINAMENTO.

test('não transfere quem já está no destino (idempotente)', async () => {
  const { discadora } = montarArgusMock();
  assert.equal((await discadora.moverPara('1003', 'URA')).resultado, Resultado.JA_NO_DESTINO);
});

test('transfere do Ativo para a URA', async () => {
  const { discadora, client } = montarArgusMock();
  const r = await discadora.moverPara('1001', 'URA');
  assert.equal(r.resultado, Resultado.TRANSFERIDO);
  assert.deepEqual([r.grupoAnterior, r.grupoDestino], [1, 2]);
  assert.equal(grupoAtual(client, '1001'), 2);
});

test('ATIVO: quem já está em qualquer grupo do Ativo fica onde está', async () => {
  const { discadora } = montarArgusMock();
  assert.equal((await discadora.moverPara('1005', 'ATIVO')).resultado, Resultado.JA_NO_DESTINO);
  assert.equal((await discadora.moverPara('1001', 'ATIVO')).resultado, Resultado.JA_NO_DESTINO);
});

test('ATIVO: quem está na URA volta para o grupo do PRÓPRIO supervisor', async () => {
  const { discadora, client } = montarArgusMock();
  const r = await discadora.moverPara('1003', 'ATIVO'); // supervisora Maysa → grupo 3
  assert.equal(r.resultado, Resultado.TRANSFERIDO);
  assert.equal(r.grupoDestino, 3);
  assert.equal(grupoAtual(client, '1003'), 3);
});

test('ATIVO: sem grupo do supervisor identificável, não move', async () => {
  const { discadora, diretorio } = montarArgusMock();
  diretorio.grupoAtivoDoOperador = () => null;
  assert.equal((await discadora.moverPara('1003', 'ATIVO')).resultado, Resultado.SEM_GRUPO_ATIVO);
});

test('respeita ramal colocado manualmente em grupo externo', async () => {
  assert.equal((await montarArgusMock().discadora.moverPara('1007', 'ATIVO')).resultado, Resultado.GRUPO_EXTERNO);
  const semRespeito = montarArgusMock({ respeitarGruposExternos: false });
  assert.equal((await semRespeito.discadora.moverPara('1007', 'URA')).resultado, Resultado.TRANSFERIDO);
});

test('falha da Argus para o operador vira FALHA (sem exceção)', async () => {
  const { discadora, client } = montarArgusMock();
  client.transferirOperador = async () => { throw new Error('Operador não vinculado à campanha'); };
  const r = await discadora.moverPara('1001', 'URA');
  assert.equal(r.resultado, Resultado.FALHA);
  assert.match(r.erro, /não vinculado/);
});

test('sem leitura de grupos, ainda tenta transferir', async () => {
  const { discadora, client } = montarArgusMock();
  client.listarGrupos = async () => { throw new Error('Argus fora'); };
  const r = await discadora.moverPara('1001', 'URA');
  assert.equal(r.resultado, Resultado.TRANSFERIDO);
  assert.equal(r.grupoAnterior, undefined);
});

test('DRY_RUN não altera a Argus', async () => {
  const { discadora, client } = montarArgusMock({ cfg: { dryRun: true } });
  assert.equal((await discadora.moverPara('1001', 'URA')).resultado, Resultado.SIMULADO);
  assert.equal(grupoAtual(client, '1001'), 1);
});

test('verificarGruposConfigurados detecta grupo inexistente', async () => {
  assert.equal(await montarArgusMock().discadora.verificarGruposConfigurados(), true);
  assert.equal(await montarArgusMock({ cfg: { gruposAtivosIds: [1, 99] } }).discadora.verificarGruposConfigurados(), false);
});

test('ATIVO sem leitura de grupos: não troca de supervisor quem já está no Ativo', async () => {
  const { discadora, diretorio, client } = montarArgusMock();
  await diretorio.atualizar(); // no boot o diretório já foi carregado
  client.listarGrupos = async () => { throw new Error('Argus fora'); };
  const r = await discadora.moverPara('1005', 'ATIVO'); // está no grupo 3 (Maysa)
  assert.equal(r.grupoDestino, 3);
  assert.equal(grupoAtual(client, '1005'), 3);
});

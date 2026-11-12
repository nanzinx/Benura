'use strict';
/**
 * Testes dos grupos de robôs da URA: identificação por nome (início do nome,
 * DTMF apenas) somada aos IDs configurados.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { gruposDosRobos, TipoGrupo } = require('../../src/domain/grupos-robos');

test('gruposDosRobos: pega URA PORT 1, 2 e 3 por nome (maiúsculas, acento e espaço não importam)', () => {
  const grupos = [
    { idGrupoUsuario: 10, descricao: 'URA PORT - 1', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9001', '9002'] },
    { idGrupoUsuario: 20, grupoUsuarioDesc: '  úRa   PoRt   2 ', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9003'] },
    { idGrupoUsuario: 30, nome: 'URA PORT 3 (TRANSBORDO)', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9004', '9005', '9006'] },
    { idGrupoUsuario: 40, descricao: 'URAPORT 4', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9007'] },
    { idGrupoUsuario: 50, descricao: 'OUTRO GRUPO', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9008'] },
  ];

  const robos = gruposDosRobos(grupos, { nomes: ['URA PORT'] });
  assert.equal(robos.length, 4);
  assert.deepEqual(robos.map((g) => g.id), [10, 20, 30, 40]);
  assert.deepEqual(robos[0], { id: 10, nome: 'URA PORT - 1', ramais: ['9001', '9002'] });
  assert.deepEqual(robos[1], { id: 20, nome: '  úRa   PoRt   2 ', ramais: ['9003'] });
  assert.deepEqual(robos[2], { id: 30, nome: 'URA PORT 3 (TRANSBORDO)', ramais: ['9004', '9005', '9006'] });
  assert.deepEqual(robos[3], { id: 40, nome: 'URAPORT 4', ramais: ['9007'] });
});

test('gruposDosRobos: ignora os de outro tipo (Flash, operacional)', () => {
  const grupos = [
    { idGrupoUsuario: 1, descricao: 'URA PORT 1', idTipoGrupo: TipoGrupo.OPERACIONAL, ramaisOperadores: ['101'] },
    { idGrupoUsuario: 2, descricao: 'URA PORT 2', idTipoGrupo: TipoGrupo.VIRTUAL_FLASH, ramaisOperadores: ['902'] },
    { idGrupoUsuario: 3, descricao: 'URA PORT 3', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['903'] },
    { idGrupoUsuario: 4, descricao: 'IA - Flash', idTipoGrupo: TipoGrupo.VIRTUAL_FLASH, ramaisOperadores: ['904'] },
  ];

  const robos = gruposDosRobos(grupos, { nomes: ['URA PORT'] });
  assert.equal(robos.length, 1);
  assert.equal(robos[0].id, 3);
  assert.deepEqual(robos[0].ramais, ['903']);
});

test('gruposDosRobos: soma com os IDs, sem repetir', () => {
  const grupos = [
    { idGrupoUsuario: 3, descricao: 'URA PORT 3', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9031', '9032'] },
    { idGrupoUsuario: 6, descricao: 'ROBOS ESPECIAIS', idTipoGrupo: TipoGrupo.VIRTUAL_FLASH, ramaisOperadores: ['9061'] },
    { idGrupoUsuario: 7, descricao: 'OUTRO ATIVO', idTipoGrupo: TipoGrupo.OPERACIONAL, ramaisOperadores: ['701'] },
  ];

  // Grupo 3 casa por nome E por ID; grupo 6 casa só por ID; grupo 7 não casa com nada
  const robos = gruposDosRobos(grupos, { ids: [3, 6], nomes: ['URA PORT'] });
  assert.equal(robos.length, 2);
  assert.deepEqual(robos.map((g) => g.id), [3, 6]);
  assert.deepEqual(robos[0], { id: 3, nome: 'URA PORT 3', ramais: ['9031', '9032'] });
  assert.deepEqual(robos[1], { id: 6, nome: 'ROBOS ESPECIAIS', ramais: ['9061'] });
});

test('gruposDosRobos: com nomes vazios, só os IDs', () => {
  const grupos = [
    { idGrupoUsuario: 3, descricao: 'URA PORT 3', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9031'] },
    { idGrupoUsuario: 5, descricao: 'URA PORT 5', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9051'] },
    { idGrupoUsuario: 8, descricao: 'LEGADO', idTipoGrupo: TipoGrupo.VIRTUAL_FLASH, ramaisOperadores: ['9081'] },
  ];

  const vazios = gruposDosRobos(grupos, { ids: [8], nomes: [] });
  assert.equal(vazios.length, 1);
  assert.equal(vazios[0].id, 8);

  const semOpcoes = gruposDosRobos(grupos, { ids: [3] });
  assert.equal(semOpcoes.length, 1);
  assert.equal(semOpcoes[0].id, 3);
});


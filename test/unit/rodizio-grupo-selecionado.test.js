'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { GrupoRobos } = require('../../src/rodizio/grupo-robos');
const { TipoGrupo } = require('../../src/integrations/argus/argus.client');

function criarCenario() {
  const gruposNaArgus = [
    { idGrupoUsuario: 100, descricao: 'URA ATENDIMENTO', idTipoGrupo: TipoGrupo.OPERACIONAL, ramaisOperadores: ['101', '102'] },
    { idGrupoUsuario: 10, descricao: 'URA PORT - 1', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9001', '9002'] },
    { idGrupoUsuario: 20, descricao: 'URA PORT - 2', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9003'] },
    { idGrupoUsuario: 30, descricao: 'URA PORT 3', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9004', '9005', '9006'] },
  ];

  const transferenciasEfetuadas = [];

  const clientMock = {
    listarGrupos: async () => structuredClone(gruposNaArgus),
    transferirOperador: async (ramal, grupoDestinoId) => {
      transferenciasEfetuadas.push({ ramal: String(ramal), grupoDestinoId });
      // Atualiza os grupos simulados na Argus
      for (const g of gruposNaArgus) {
        g.ramaisOperadores = g.ramaisOperadores.filter((r) => r !== String(ramal));
      }
      const destino = gruposNaArgus.find((g) => g.idGrupoUsuario === grupoDestinoId);
      if (destino) destino.ramaisOperadores.push(String(ramal));
      return { codStatus: 1 };
    },
  };

  const loggerMock = {
    info: () => {},
    aviso: () => {},
    erro: () => {},
    debug: () => {},
  };

  const robosMock = {
    sincronizar: async () => {},
    situacao: () => ({ ligados: 0 }),
    resumo: () => ({ ligados: 0 }),
  };

  const grupoRobos = new GrupoRobos({ arquivo: null, logger: loggerMock });

  const svc = new RodizioService({
    client: clientMock,
    robos: robosMock,
    repositorio: { carregar: () => ({}), salvar: () => {} },
    cfg: {
      grupoUraId: 100,
      gruposRobosIds: [],
      gruposRobosNomes: ['URA PORT'],
      concorrencia: 5,
      dryRun: false,
    },
    logger: loggerMock,
    grupoRobos,
  });

  return { svc, gruposNaArgus, transferenciasEfetuadas, grupoRobos };
}

test('Filtro de grupo: sem grupo selecionado pega todos os URA PORT', async () => {
  const { svc } = criarCenario();
  await svc.atualizarGrupos();

  assert.equal(svc.gruposRobosDisponiveis.length, 3);
  assert.equal(svc.ramaisRobos.length, 6); // 2 + 1 + 3
  assert.deepEqual(svc.gruposRobosIds(), [10, 20, 30]);
});

test('Filtro de grupo: selecionar grupo 10 restringe ramais e IDs a esse grupo', async () => {
  const { svc } = criarCenario();
  await svc.atualizarGrupos();

  const r = await svc.definirGrupoRobos(10, 'supervisor@teste.com');
  assert.equal(r.mudou, true);
  assert.equal(r.grupoId, 10);

  assert.equal(svc.gruposRobosDisponiveis.length, 3);
  assert.equal(svc.gruposRobosAgora.length, 1);
  assert.equal(svc.gruposRobosAgora[0].id, 10);
  assert.deepEqual(svc.ramaisRobos, ['9001', '9002']);
  assert.deepEqual(svc.gruposRobosIds(), [10]);

  // Resumo para o painel expõe a seleção
  const resumo = svc.resumo();
  assert.equal(resumo.grupoRobos.grupoId, 10);
  assert.equal(resumo.grupoRobos.escolhido, true);
  assert.equal(resumo.gruposRobosDisponiveis.length, 3);
});

test('Filtro de grupo: voltar para "todos" restaura todos os grupos', async () => {
  const { svc } = criarCenario();
  await svc.definirGrupoRobos(20);
  assert.equal(svc.ramaisRobos.length, 1);

  await svc.definirGrupoRobos('todos');
  assert.equal(svc.ramaisRobos.length, 6);
  assert.deepEqual(svc.gruposRobosIds(), [10, 20, 30]);
  assert.equal(svc.resumo().grupoRobos.grupoId, null);
});

test('Transferência de grupo: move robôs do grupo 30 para o grupo 10 na Argus', async () => {
  const { svc, transferenciasEfetuadas } = criarCenario();
  await svc.atualizarGrupos();

  const resultado = await svc.transferirRobosDeGrupo({
    grupoOrigemId: 30,
    grupoDestinoId: 10,
    por: 'supervisor@teste.com',
  });

  assert.equal(resultado.ok, true);
  assert.equal(resultado.transferidos, 3);
  assert.equal(transferenciasEfetuadas.length, 3);

  // Grupo 10 agora tem 2 + 3 = 5 robôs; grupo 30 agora tem 0 robôs
  const g10 = svc.gruposRobosDisponiveis.find((g) => g.id === 10);
  const g30 = svc.gruposRobosDisponiveis.find((g) => g.id === 30);
  assert.equal(g10.robos, 5);
  assert.equal(g30.robos, 0);
});

test('Transferência de grupo: se o grupo origem estava filtrado, migra o filtro para o destino', async () => {
  const { svc } = criarCenario();
  await svc.definirGrupoRobos(30);
  assert.equal(svc.grupoRobos.grupoId, 30);

  await svc.transferirRobosDeGrupo({
    grupoOrigemId: 30,
    grupoDestinoId: 10,
  });

  assert.equal(svc.grupoRobos.grupoId, 10);
  assert.equal(svc.gruposRobosAgora[0].id, 10);
  assert.equal(svc.gruposRobosAgora[0].robos, 5);
});

test('Rotas HTTP: PUT /robos/grupo e POST /robos/transferir-grupo funcionam via controllers', async () => {
  const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
  const { ACOES } = require('../../src/painel/servicos');
  const { svc } = criarCenario();
  await svc.atualizarGrupos();

  const rotas = criarRotasDoRodizio({ rodizio: svc, ciclos: {}, logger: { info: () => {}, aviso: () => {}, erro: () => {} } });

  const rotaGrupo = rotas.find((r) => r.caminho === '/robos/grupo');
  assert.ok(rotaGrupo);
  assert.equal(rotaGrupo.metodo, 'PUT');
  assert.equal(rotaGrupo.protegida, true);

  const resGrupo = await rotaGrupo.handler({ corpo: { grupoId: 20, por: 'sup@teste.com' } });
  assert.equal(resGrupo.status, 200);
  assert.equal(svc.grupoRobos.grupoId, 20);

  const rotaTransferir = rotas.find((r) => r.caminho === '/robos/transferir-grupo');
  assert.ok(rotaTransferir);
  assert.equal(rotaTransferir.metodo, 'POST');
  assert.equal(rotaTransferir.protegida, true);

  const resTransferir = await rotaTransferir.handler({ corpo: { grupoOrigemId: 20, grupoDestinoId: 10, por: 'sup@teste.com' } });
  assert.equal(resTransferir.status, 200);
  assert.equal(resTransferir.corpo.transferidos, 1);

  // Erro 400 com parâmetros inválidos
  const resInvalido = await rotaTransferir.handler({ corpo: { grupoOrigemId: 10, grupoDestinoId: 10 } });
  assert.equal(resInvalido.status, 400);

  // Verifica que ambas as ações estão mapeadas no painel
  assert.ok(ACOES.some((a) => a.caminho === '/api/robos/grupo' && a.destino === '/robos/grupo'));
  assert.ok(ACOES.some((a) => a.caminho === '/api/robos/transferir-grupo' && a.destino === '/robos/transferir-grupo'));
});

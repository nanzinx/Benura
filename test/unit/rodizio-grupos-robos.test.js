'use strict';
/**
 * Testes da releitura dinâmica de grupos de robôs no RodizioService.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { TipoGrupo } = require('../../src/domain/grupos-robos');
const { loggerNulo } = require('../../src/utils/logger');

function criarServico({ gruposIniciais, cfg = {} }) {
  let gruposArgus = gruposIniciais;
  const logs = [];
  const log = {
    ...loggerNulo,
    filho: () => log,
    info: (msg) => logs.push(msg),
    aviso: (msg) => logs.push(msg),
    debug: () => {},
  };

  const client = {
    listarGrupos: async () => gruposArgus,
    statusOperador: async () => ({ descricaoStatus: 'Livre', tempoStatus: 0 }),
    logarOperadorVirtual: async () => {},
    deslogarOperador: async () => {},
  };

  const svc = new RodizioService({
    client,
    robos: {
      sincronizar: async () => {},
      situacao: () => ({ ligados: 0, alvo: 0 }),
      resumo: () => ({ ligados: 0, alvo: 0 }),
    },
    cfg: {
      grupoUraId: 2,
      gruposAtivosIds: [1],
      gruposRobosIds: [],
      gruposRobosNomes: ['URA PORT'],
      robosPorLivre: 2,
      robosTaxa: { porStatus: {} },
      tempoNaUraMs: 120_000,
      cheiaLivresMin: 4,
      cheiaLivresMax: 6,
      descricoesStatus: { livres: ['livre'], atendimento: ['atendimento'], offline: ['offline'] },
      ...cfg,
    },
    logger: log,
  });

  return { svc, setGrupos: (novos) => { gruposArgus = novos; }, logs };
}

test('rodizio: os robôs movidos do PORT 3 para o PORT 1 entram em ramaisRobos na próxima releitura', async () => {
  const grupos1 = [
    { idGrupoUsuario: 1, descricao: 'ATIVO', idTipoGrupo: TipoGrupo.OPERACIONAL, ramaisOperadores: ['100'] },
    { idGrupoUsuario: 2, descricao: 'URA RECEPTIVO', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['200'] },
    { idGrupoUsuario: 3, descricao: 'URA PORT 3', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9001', '9002'] },
  ];

  const { svc, setGrupos, logs } = criarServico({ gruposIniciais: grupos1 });
  await svc.atualizarGrupos();

  assert.deepEqual(svc.ramaisRobos, ['9001', '9002']);
  assert.deepEqual(svc.gruposRobosAgora, [{ id: 3, nome: 'URA PORT 3', robos: 2 }]);
  assert.ok(logs.some((l) => l.includes('robôs agora em: URA PORT 3 (2)')));

  // Move os robôs para URA PORT 1 e adiciona um terceiro robô
  const grupos2 = [
    { idGrupoUsuario: 1, descricao: 'ATIVO', idTipoGrupo: TipoGrupo.OPERACIONAL, ramaisOperadores: ['100'] },
    { idGrupoUsuario: 2, descricao: 'URA RECEPTIVO', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['200'] },
    { idGrupoUsuario: 11, descricao: 'URA PORT 1', idTipoGrupo: TipoGrupo.VIRTUAL_DTMF, ramaisOperadores: ['9101', '9102', '9103'] },
  ];

  setGrupos(grupos2);
  logs.length = 0;
  await svc.atualizarGrupos();

  assert.deepEqual(svc.ramaisRobos, ['9101', '9102', '9103'], 'novos ramais de robôs entram em ramaisRobos');
  assert.deepEqual(svc.gruposRobosAgora, [{ id: 11, nome: 'URA PORT 1', robos: 3 }]);
  assert.ok(logs.some((l) => l.includes('robôs agora em: URA PORT 1 (3)')), 'loga quando a lista de grupos muda');

  // Próxima releitura sem mudar grupos: não loga de novo
  logs.length = 0;
  await svc.atualizarGrupos();
  assert.equal(logs.filter((l) => l.includes('robôs agora em:')).length, 0, 'não loga de novo sem mudança');

  // Resumo (/health) inclui gruposRobos
  const resumo = svc.resumo();
  assert.deepEqual(resumo.gruposRobos, [{ id: 11, nome: 'URA PORT 1', robos: 3 }]);
});

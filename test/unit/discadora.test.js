'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscadoraService, Resultado } = require('../../src/integrations/argus/discadora.service');
const { loggerNulo } = require('../../src/utils/logger');

const cfg = { grupoUraId: 2, grupoAtivoId: 1, cacheGruposMs: 60_000, dryRun: false };

function criarArgusFalso(grupos) {
  const chamadas = [];
  return {
    chamadas,
    async listarGrupos() {
      if (grupos === null) throw new Error('Argus fora');
      return grupos;
    },
    async transferirOperador(ramal, destino) {
      chamadas.push([ramal, destino]);
      if (ramal === 'quebrado') throw new Error('codStatus -1');
      return { codStatus: 1 };
    },
  };
}

const grupos = [
  { idGrupoUsuario: 1, ramaisOperadores: [100] },
  { idGrupoUsuario: 2, ramaisOperadores: ['200'] },
  { idGrupoUsuario: 9, ramaisOperadores: ['900'] },
];

test('não transfere quem já está no destino (idempotente)', async () => {
  const client = criarArgusFalso(grupos);
  const svc = new DiscadoraService({ client, cfg, respeitarGruposExternos: true, logger: loggerNulo });
  const r = await svc.moverPara('200', 'URA');
  assert.equal(r.resultado, Resultado.JA_NO_DESTINO);
  assert.equal(client.chamadas.length, 0);
});

test('transfere do Ativo para a URA', async () => {
  const client = criarArgusFalso(grupos);
  const svc = new DiscadoraService({ client, cfg, respeitarGruposExternos: true, logger: loggerNulo });
  const r = await svc.moverPara('100', 'URA');
  assert.equal(r.resultado, Resultado.TRANSFERIDO);
  assert.equal(r.grupoAnterior, 1);
  assert.deepEqual(client.chamadas, [['100', 2]]);
});

test('respeita ramal colocado manualmente em grupo externo', async () => {
  const client = criarArgusFalso(grupos);
  const svc = new DiscadoraService({ client, cfg, respeitarGruposExternos: true, logger: loggerNulo });
  assert.equal((await svc.moverPara('900', 'ATIVO')).resultado, Resultado.GRUPO_EXTERNO);
  assert.equal(client.chamadas.length, 0);

  const svc2 = new DiscadoraService({ client, cfg, respeitarGruposExternos: false, logger: loggerNulo });
  assert.equal((await svc2.moverPara('900', 'ATIVO')).resultado, Resultado.TRANSFERIDO);
});

test('sem leitura de grupos, ainda tenta transferir; falha vira FALHA (sem exceção)', async () => {
  const client = criarArgusFalso(null);
  const svc = new DiscadoraService({ client, cfg, respeitarGruposExternos: true, logger: loggerNulo });
  const ok = await svc.moverPara('100', 'URA');
  assert.equal(ok.resultado, Resultado.TRANSFERIDO);
  assert.equal(ok.grupoAnterior, undefined);

  const falha = await svc.moverPara('quebrado', 'URA');
  assert.equal(falha.resultado, Resultado.FALHA);
  assert.match(falha.erro, /codStatus/);
});

test('DRY_RUN não chama a Argus', async () => {
  const client = criarArgusFalso(grupos);
  const svc = new DiscadoraService({ client, cfg: { ...cfg, dryRun: true }, respeitarGruposExternos: true, logger: loggerNulo });
  assert.equal((await svc.moverPara('100', 'URA')).resultado, Resultado.SIMULADO);
  assert.equal(client.chamadas.length, 0);
});

test('verificarGruposConfigurados detecta grupo inexistente', async () => {
  const svc = new DiscadoraService({
    client: criarArgusFalso([{ idGrupoUsuario: 1, ramaisOperadores: [] }]),
    cfg, respeitarGruposExternos: true, logger: loggerNulo,
  });
  assert.equal(await svc.verificarGruposConfigurados(), false);
});

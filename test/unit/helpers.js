'use strict';
/** Monta a camada da Argus sobre o ArgusMockClient (Argus simulada em memória). */
const { ArgusMockClient } = require('../../src/integrations/argus/argus.mock-client');
const { DiretorioOperadores } = require('../../src/integrations/argus/diretorio-operadores.service');
const { DiscadoraService } = require('../../src/integrations/argus/discadora.service');
const { loggerNulo } = require('../../src/utils/logger');

const CFG_ARGUS = Object.freeze({
  grupoUraId: 2, gruposAtivosIds: [1, 3], cacheGruposMs: 60_000, cacheDiretorioMs: 60_000, dryRun: false,
});

function montarArgusMock({ cfg = {}, respeitarGruposExternos = true, excecoesRamal, arquivoSupervisoresGrupos } = {}) {
  const client = new ArgusMockClient(loggerNulo);
  const cfgFinal = { ...CFG_ARGUS, ...cfg };
  const diretorio = new DiretorioOperadores({
    client, cfg: cfgFinal, excecoesRamal, arquivoSupervisoresGrupos, logger: loggerNulo,
  });
  const discadora = new DiscadoraService({
    client, cfg: cfgFinal, diretorio, respeitarGruposExternos, logger: loggerNulo,
  });
  return { client, diretorio, discadora, cfg: cfgFinal };
}

/** Grupo atual de um ramal na Argus simulada. */
const grupoAtual = (client, ramal) => client.dados.usuarios.find((u) => u.ramal === ramal).campanhas[0].idGrupoUsuario;

module.exports = { montarArgusMock, grupoAtual, CFG_ARGUS };

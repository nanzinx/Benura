'use strict';
/** [NOVO] URA calma com URA cheia: de 4 a 6 livres; faltando, sobem os mais antigos; passando, voltam os livres há mais tempo. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { planoDosLivres, excessoDeLivres } = require('../../src/domain/rodizio');

test('planoDosLivres: abaixo do mínimo sobe o que falta; acima do máximo devolve o excesso; na faixa, nada', () => {
  const cfg = { min: 4, max: 6 };
  assert.deepEqual(planoDosLivres({ contados: 0, ...cfg }), { subir: 4, devolver: 0 });
  assert.deepEqual(planoDosLivres({ contados: 3, ...cfg }), { subir: 1, devolver: 0 });
  assert.deepEqual(planoDosLivres({ contados: 4, ...cfg }), { subir: 0, devolver: 0 });
  assert.deepEqual(planoDosLivres({ contados: 6, ...cfg }), { subir: 0, devolver: 0 });
  assert.deepEqual(planoDosLivres({ contados: 8, ...cfg }), { subir: 0, devolver: 2 });
});

test('excessoDeLivres: quem está livre há mais tempo volta primeiro', () => {
  const livres = [{ ramal: '201', livreDesde: 3000 }, { ramal: '202', livreDesde: 1000 }, { ramal: '203', livreDesde: 2000 }];
  assert.deepEqual(excessoDeLivres(livres, 2), ['202', '203']);
  assert.deepEqual(excessoDeLivres(livres, 0), []);
});

const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

function servico({ status = 'calma', cheia = true, ura = {} } = {}) {
  const svc = Object.create(RodizioService.prototype);
  const movimentos = [];
  Object.assign(svc, {
    cfg: { cheiaLimitarLivres: true, cheiaLivresMin: 4, cheiaLivresMax: 6 }, log: loggerNulo,
    ramaisUra: new Set(Object.keys(ura)), statusUra: new Map(Object.entries(ura)), aguardandoTroca: new Set(), permanentes: new Set(),
    emTransferencia: new Set(), esperandoAtender: new Set(), atenderamNoAtivo: new Set(), movidos: {},
  });
  svc.statusAtualDaUra = () => status;
  svc.emUraCheia = () => cheia;
  svc.travadoEm = () => null;
  svc.moverParaUra = async (ramal) => { movimentos.push(`URA ${ramal}`); svc.ramaisUra.add(ramal); svc.aguardandoTroca.add(ramal); return true; };
  svc.moverParaAtivo = async (ramal, motivo) => { movimentos.push(`ATIVO ${ramal} (${motivo})`); return { ok: true }; };
  return { svc, movimentos };
}
const livre = (livreDesde = 0, x = {}) => ({ classe: Classe.LIVRE, livreDesde, ts: 0, ...x });
const ativo = (ramais) => ramais.map((ramal) => ({ ramal, grupo: 1, classe: Classe.LIVRE }));

test('URA cheia: com 1 livre na URA, sobem os 3 mais antigos livres do Ativo; quem está a caminho conta', async () => {
  const { svc, movimentos } = servico({ ura: { 100: livre() } });
  assert.ok(svc.emUraCheiaComLimite());
  await svc.completarLivresDaUraCheia(ativo(['305', '210', '220', '401', '230']));
  assert.deepEqual(movimentos, ['URA 210', 'URA 220', 'URA 230']);
  movimentos.length = 0;
  await svc.completarLivresDaUraCheia(ativo(['305', '401']));
  assert.deepEqual(movimentos, [], 'os 3 a caminho já contam: 4');
});

test('URA cheia: quem voltou ao Ativo só sobe de novo depois de atender lá', async () => {
  const { svc, movimentos } = servico();
  svc.esperandoAtender.add('210');
  await svc.completarLivresDaUraCheia(ativo(['210', '220']));
  assert.deepEqual(movimentos, ['URA 220']);
  svc.lerStatus = async () => ({ classe: Classe.ATENDIMENTO, status: { idGrupo: 1 } });
  await svc.verificarOperadorDoAtivo({ ramal: '210', grupo: 1 });
  assert.ok(!svc.esperandoAtender.has('210'), 'atendeu no Ativo: volta para a fila');
});

test('URA cheia: no Ativo, ninguém sobe sozinho por ter atendido; o completar decide', async () => {
  const { svc, movimentos } = servico();
  svc.atenderamNoAtivo.add('210');
  svc.lerStatus = async () => ({ classe: Classe.LIVRE, status: { idGrupo: 1 } });
  const lido = await svc.verificarOperadorDoAtivo({ ramal: '210', grupo: 1 }, { subir: false });
  assert.deepEqual(lido, { ramal: '210', grupo: 1, classe: Classe.LIVRE });
  assert.deepEqual(movimentos, []);
});

test('URA cheia: acima de 6 livres, voltam os livres há mais tempo; fixo, travado e carência ficam', async () => {
  const ura = {
    101: livre(1000), 102: livre(2000), 103: livre(3000), 104: livre(4000), 105: livre(5000), 106: livre(6000),
    107: livre(7000), 108: livre(500), 109: livre(100, { emCarencia: true }),
  };
  const { svc, movimentos } = servico({ ura });
  svc.permanentes.add('108');
  svc.travadoEm = (r) => (r === '101' ? 'ura' : null);
  await svc.devolverExcessoDaUraCheia([]);
  assert.deepEqual(movimentos, ['ATIVO 102 (URA cheia com 9 livres (máx. 6))', 'ATIVO 103 (URA cheia com 9 livres (máx. 6))', 'ATIVO 104 (URA cheia com 9 livres (máx. 6))']);
  assert.deepEqual([...svc.esperandoAtender].sort(), ['102', '103', '104']);
});

test('URA cheia: quem já sai pelo ocioso neste ciclo não conta no excesso', async () => {
  const ura = Object.fromEntries(['101', '102', '103', '104', '105', '106', '107'].map((r, i) => [r, livre(i * 1000)]));
  const { svc, movimentos } = servico({ ura });
  await svc.devolverExcessoDaUraCheia(['101']);
  assert.deepEqual(movimentos, [], '7 livres, 1 saindo pelo ocioso = 6');
});

test('só vale com a URA calma E a URA cheia ligada; faltando uma das duas, ou com a regra desligada, não vale', () => {
  assert.ok(servico().svc.emUraCheiaComLimite(), 'calma + URA cheia: vale');
  assert.ok(!servico({ status: 'agressiva' }).svc.emUraCheiaComLimite(), 'URA cheia em agressiva: não vale');
  assert.ok(!servico({ status: 'normal' }).svc.emUraCheiaComLimite(), 'URA cheia em normal: não vale');
  assert.ok(!servico({ cheia: false }).svc.emUraCheiaComLimite(), 'calma sem URA cheia: não vale');
  const { svc } = servico();
  svc.cfg.cheiaLimitarLivres = false;
  assert.ok(!svc.emUraCheiaComLimite());
});

function config(env) {
  const antes = { ...process.env };
  Object.assign(process.env, { BENURA_SEM_DOTENV: '1', ARGUS_TOKEN: 'x', GRUPO_URA_ID: '1', GRUPOS_ATIVOS_IDS: '2', GRUPOS_ROBOS_URA_IDS: '6', ...env });
  delete require.cache[require.resolve('../../src/config')];
  try {
    const c = require('../../src/config');
    const cfg = c.carregarConfig();
    return { cfg, ...c.validarConfig(cfg, { escopo: 'rodizio' }) };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
    delete require.cache[require.resolve('../../src/config')];
  }
}

test('config: URA cheia com 4 a 6 livres por padrão, trocável e validado', () => {
  const { cfg, fatais } = config({});
  assert.deepEqual([cfg.rodizio.cheiaLimitarLivres, cfg.rodizio.cheiaLivresMin, cfg.rodizio.cheiaLivresMax], [true, 4, 6]);
  assert.deepEqual(fatais, []);
  const desligado = config({ URA_CHEIA_LIMITAR_LIVRES: '0', URA_CHEIA_LIVRES_MIN: '3', URA_CHEIA_LIVRES_MAX: '5' });
  assert.deepEqual([desligado.cfg.rodizio.cheiaLimitarLivres, desligado.cfg.rodizio.cheiaLivresMin, desligado.cfg.rodizio.cheiaLivresMax], [false, 3, 5]);
  assert.match(config({ URA_CHEIA_LIVRES_MIN: '7' }).fatais.join(' | '), /URA_CHEIA_LIVRES_MIN/);
});

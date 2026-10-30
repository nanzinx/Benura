'use strict';
/** [NOVO] Conta operacional de supervisor (ex.: Ariel Souza da Conceicao, supervisora Ariel Conceicao) não fica na URA. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mesmaPessoa, ContasDeSupervisores } = require('../../src/domain/contas-supervisores');
const { DiretorioOperadores } = require('../../src/integrations/argus/diretorio-operadores.service');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { Classe } = require('../../src/domain/rodizio');
const { loggerNulo } = require('../../src/utils/logger');

test('mesmaPessoa: primeiro e último nome iguais, e o resto do nome do supervisor dentro do do operador', () => {
  assert.ok(mesmaPessoa('Ariel Souza da Conceicao', 'Ariel Conceição'));
  assert.ok(mesmaPessoa('ROBSON JUNIOR', 'Robson Junior'));
  assert.ok(!mesmaPessoa('Renato Mariano de Jesus', 'Robson Junior'));
  assert.ok(!mesmaPessoa('Ariel Souza', 'Ariel Conceicao'), 'sobrenome diferente');
  assert.ok(!mesmaPessoa('Ariel', 'Ariel'), 'só o primeiro nome não basta');
});

const vinc = (idSup, nomeSup) => [{ idCampanha: 1, idGrupoUsuario: 1, idUsuarioSupervisor: idSup, nomeUsuarioSupervisor: nomeSup }];
const USUARIOS = [
  { idUsuario: 1, nome: 'Ariel Conceicao', idTipoUsuario: 1, ativo: true, campanhas: [] },
  { idUsuario: 2, nome: 'Robson Junior', idTipoUsuario: 1, ativo: true, campanhas: [] },
  { idUsuario: 10, nome: 'Ariel Souza da Conceicao', ramal: '1010', idTipoUsuario: 2, ativo: true, campanhas: vinc(1, 'Ariel Conceicao') },
  { idUsuario: 11, nome: 'Renato Mariano de Jesus', ramal: '1011', idTipoUsuario: 2, ativo: true, campanhas: vinc(2, 'Robson Junior') },
  { idUsuario: 12, nome: 'Fulano Junior Robson', ramal: '1012', idTipoUsuario: 2, ativo: true, campanhas: vinc(2, 'Robson Junior') },
];

async function diretorio() {
  const client = { listarUsuarios: async () => USUARIOS, listarGrupos: async () => [{ idGrupoUsuario: 1, grupoUsuarioDesc: 'ATIVO' }] };
  const d = new DiretorioOperadores({ client, cfg: { grupoUraId: 9, gruposAtivosIds: [1], cacheDiretorioMs: 60_000 }, logger: loggerNulo });
  return d.atualizar();
}

test('diretório: acha as contas operacionais dos supervisores pelo nome', async () => {
  const d = await diretorio();
  assert.deepEqual(d.contasDeSupervisores(), [{ ramal: '1010', nome: 'Ariel Souza da Conceicao', supervisor: 'Ariel Conceicao' }]);
});

test('ContasDeSupervisores: automático pelo diretório, mais os ramais do .env, menos as exceções', async () => {
  const d = await diretorio();
  const contas = new ContasDeSupervisores({ diretorio: d, cfg: { automatico: true, ramais: ['2020'], exceto: [] }, logger: loggerNulo });
  assert.ok(contas.eh('1010'));
  assert.ok(contas.eh('2020'));
  assert.ok(!contas.eh('1011'));
  assert.ok(!new ContasDeSupervisores({ diretorio: d, cfg: { automatico: true, ramais: [], exceto: ['1010'] }, logger: loggerNulo }).eh('1010'));
  assert.ok(!new ContasDeSupervisores({ diretorio: d, cfg: { automatico: false, ramais: [], exceto: [] }, logger: loggerNulo }).eh('1010'));
  const semDiretorio = new ContasDeSupervisores({ diretorio: { contaDeSupervisor: () => { throw new Error('não carregou'); } }, cfg: { automatico: true }, logger: loggerNulo });
  assert.ok(!semDiretorio.eh('1010'), 'diretório fora: não trava ninguém');
});

function rodizio(contas) {
  const svc = Object.create(RodizioService.prototype);
  Object.assign(svc, {
    cfg: {}, contasSupervisores: { eh: (r) => contas.includes(r) }, permanentes: new Set(['1010']), emTransferencia: new Set(),
    statusUra: new Map(), movidos: {}, ramaisUra: new Set(), alinhandoLogin: new Set(), travas: null,
    gruposAtivos: [{ idGrupoUsuario: 1, ramaisOperadores: ['1010', '1011'] }],
  });
  svc.travadoEm = () => null;
  svc.limiteOciosoMs = () => 120_000;
  return svc;
}

test('rodízio: conta de supervisor não sobe do Ativo e sai da URA (mesmo fixa) quando não está em ligação', () => {
  const svc = rodizio(['1010']);
  assert.deepEqual(svc.operadoresDoAtivo().map((o) => o.ramal), ['1011']);
  const agora = 1_000_000;
  for (const [classe, sai] of [[Classe.LIVRE, true], [Classe.OUTRO, true], [Classe.ATENDIMENTO, false]]) {
    svc.statusUra.set('1010', { classe, livreDesde: agora - 1000, ts: agora });
    assert.equal(svc.deveDevolver('1010', agora), sai, classe);
  }
  svc.statusUra.set('1010', { classe: Classe.LIVRE, livreDesde: agora - 1000, ts: agora });
  svc.travadoEm = () => 'ura';
  assert.equal(svc.deveDevolver('1010', agora), false, 'posta à mão na URA pelo painel: fica');
});

'use strict';
/** Desligados: Inativos no Vanguard que continuam ativos na Argus. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { quemSaiu, situacaoNoVanguard, loginArgusDe } = require('../../src/domain/desligados');
const { DesligadosService, FuncionariosDeArquivo } = require('../../src/rotinas/desligados.service');
const { RoboEsteira } = require('../../src/integrations/vanguard/esteira-robo');
const { lerTabela } = require('../../src/utils/planilhas');
const { loggerNulo } = require('../../src/utils/logger');
const { criarVanguardFake, navegadorDeTeste } = require('./vanguard-fake');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desligados-'));
const func = (usuario, status, nome = usuario) => ({ Nome: nome, 'Usuário': usuario, Status: status });
const op = (login, ramal, extra = {}) => ({ login, nome: login, ramal, ativo: true, tipo: 2, ...extra });

test('loginArgusDe e situacaoNoVanguard: recontratado (um cadastro Ativo) conta como ativo', () => {
  assert.equal(loginArgusDe('ana.souza@36241'), 'ANA.SOUZA');
  assert.equal(loginArgusDe('login inválido!'), null);
  const s = situacaoNoVanguard([func('ANA.SOUZA@1', 'Inativo'), func('ANA.SOUZA@2', 'Ativo'), func('BIA.LIMA@1', 'Inativo')]);
  assert.equal(s.get('ANA.SOUZA').ativo, true);
  assert.equal(s.get('BIA.LIMA').ativo, false);
});

test('quemSaiu: só Inativo no Vanguard E operador ativo na Argus', () => {
  const funcionarios = [
    func('ANA.SOUZA@36241', 'Inativo'), func('BIA.LIMA@36241', 'Ativo'), func('CAIO.REIS@36241', 'Inativo'), func('DANI.MELO@36241', 'Inativo'),
  ];
  const usuarios = [
    op('ANA.SOUZA', '1001'), op('BIA.LIMA', '1002'), op('CAIO.REIS', '1003', { ativo: false }),
    op('DANI.MELO', '1004', { tipo: 1 }), op('EVA.ROCHA', '1005'), // EVA não está no Vanguard: ignorada
  ];
  assert.deepEqual(quemSaiu(funcionarios, usuarios).map((d) => [d.login, d.statusVanguard]), [['ANA.SOUZA', 'Inativo']]);
});

function montar({ funcionarios, usuarios, status = {}, dryRun = false, horarios = ['07:30', '18:10'] }) {
  const pasta = tmp();
  const arquivo = path.join(pasta, 'funcionarios.xls');
  const linhas = funcionarios.map((f) => `<tr><td>${f.Nome}</td><td>${f['Usuário']}</td><td>${f.Status}</td></tr>`).join('');
  fs.writeFileSync(arquivo, Buffer.from(`<html><table><tr><th>Nome</th><th>Usuário</th><th>Status</th></tr>${linhas}</table></html>`, 'latin1'));
  const memoria = { estado: {}, avisos: [], eventos: [], deslogados: [] };
  const client = {
    listarUsuarios: async () => usuarios.map((u) => ({ idUsuario: 1, nome: u.nome, login: u.login, ramal: u.ramal, ativo: u.ativo, idTipoUsuario: u.tipo })),
    statusOperador: async (r) => (status[r] ? { descricaoStatus: status[r] } : null),
    deslogarOperador: async (r) => { memoria.deslogados.push(r); },
  };
  const servico = new DesligadosService({
    fonte: new FuncionariosDeArquivo(arquivo),
    client,
    cfg: { ativo: true, horarios, diasSemana: [1, 2, 3, 4, 5], toleranciaMin: 120, fusoHorario: 'America/Sao_Paulo', dryRun },
    repositorio: { carregar: () => structuredClone(memoria.estado), salvar: async (e) => { memoria.estado = e; } },
    auditoria: { registrar: async (acao, d) => { memoria.eventos.push({ acao, ...d }); } },
    notificador: { notificar: async (a) => { memoria.avisos.push(a); } },
    logger: loggerNulo,
  });
  return { servico, memoria };
}

test('DesligadosService: desloga quem está logado e avisa a lista; DRY_RUN não desloga', async () => {
  const funcionarios = [func('ANA.SOUZA@1', 'Inativo', 'ANA SOUZA'), func('BIA.LIMA@1', 'Inativo', 'BIA LIMA'), func('CAIO.REIS@1', 'Ativo')];
  const usuarios = [op('ANA.SOUZA', '1001', { nome: 'ANA SOUZA' }), op('BIA.LIMA', '1002'), op('CAIO.REIS', '1003')];
  const { servico, memoria } = montar({ funcionarios, usuarios, status: { 1001: 'livre' } });
  const r = await servico.executar();
  assert.deepEqual(r.desligados.map((d) => [d.login, d.estavaLogado, d.deslogado]), [['ANA.SOUZA', true, true], ['BIA.LIMA', false, undefined]]);
  assert.deepEqual(memoria.deslogados, ['1001']);
  assert.match(memoria.avisos[0].titulo, /2 ainda ativo/);
  assert.match(memoria.avisos[0].texto, /ANA SOUZA \(ANA\.SOUZA, ramal 1001\) — deslogado agora/);

  const simulado = montar({ funcionarios, usuarios, status: { 1001: 'livre' }, dryRun: true });
  await simulado.servico.executar();
  assert.deepEqual(simulado.memoria.deslogados, []);
});

test('DesligadosService: ninguém para avisar → só log; exportação vazia → erro avisado', async () => {
  const nada = montar({ funcionarios: [func('ANA.SOUZA@1', 'Ativo')], usuarios: [op('ANA.SOUZA', '1')] });
  assert.equal((await nada.servico.executar()).desligados.length, 0);
  assert.equal(nada.memoria.avisos.length, 0);

  const vazio = montar({ funcionarios: [], usuarios: [] });
  await assert.rejects(vazio.servico.executar(), /veio vazia/);
  assert.equal(vazio.memoria.avisos[0].nivel, 'erro');
});

test('DesligadosService tique: 07:30 e fim do dia, uma vez cada', async () => {
  const { servico, memoria } = montar({ funcionarios: [func('ANA.SOUZA@1', 'Inativo')], usuarios: [op('ANA.SOUZA', '1')] });
  const as = (hhmm) => new Date(`2026-10-09T${hhmm}:00-03:00`);
  assert.equal(await servico.tique(as('07:00')), null);
  assert.equal((await servico.tique(as('07:31'))).desligados.length, 1);
  assert.equal(await servico.tique(as('08:00')), null);
  assert.equal((await servico.tique(as('18:15'))).desligados.length, 1);
  assert.equal(memoria.avisos.length, 2);
});

test('lerTabela: "Excel" em HTML (exportação de sistemas web)', async () => {
  const arquivo = path.join(tmp(), 'f.xls');
  fs.writeFileSync(arquivo, Buffer.from('<html><table><tr><th>Código</th><th>Nome</th></tr><tr><td>1</td><td>JOÃO&nbsp;<b>DA</b> SILVA &amp; CIA</td></tr></table></html>', 'latin1'));
  assert.deepEqual(await lerTabela(arquivo), [{ 'Código': '1', Nome: 'JOÃO DA SILVA & CIA' }]);
});

test('RoboEsteira.baixarFuncionarios: status Todos, agência Todas e exporta', { timeout: 60_000 }, async () => {
  const v = await criarVanguardFake({
    usuario: 'robo', senha: 's', registros: [],
    funcionarios: [{ Nome: 'ANA', Usuario: 'ANA.SOUZA@36241', Status: 'Ativo' }, { Nome: 'BIA', Usuario: 'BIA.LIMA@36241', Status: 'Inativo' }],
  });
  try {
    const robo = new RoboEsteira({
      cfg: {
        url: v.url, usuario: 'robo', senha: 's', pastaDownload: tmp(), timeoutMs: 15_000, navegador: navegadorDeTeste(),
        urlFuncionarios: `${v.url}/index.php/funcionario`,
      },
      logger: loggerNulo,
    });
    const arquivo = await robo.baixarFuncionarios({ hoje: '2026-10-09' });
    assert.deepEqual(v.estado.filtroFuncionarios, { situacao: 'Todos', agencia: '' });
    assert.deepEqual((await lerTabela(arquivo)).map((l) => [l['Usuário'], l.Status]), [['ANA.SOUZA@36241', 'Ativo'], ['BIA.LIMA@36241', 'Inativo']]);

    const semUrl = new RoboEsteira({ cfg: { ...robo.cfg, urlFuncionarios: '' }, logger: loggerNulo });
    await assert.rejects(semUrl.baixarFuncionarios({ hoje: '2026-10-09' }), /VANGUARD_FUNCIONARIOS_URL/);
  } finally {
    await v.fechar();
  }
});

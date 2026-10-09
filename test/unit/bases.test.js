'use strict';
/** Bases de mailing: regras puras, leitura de planilhas, robô da esteira e o serviço. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  TipoBase, criarFiltroStatus, chavesDaEsteira, removerDaBase, leadsDaEsteira, embaralhar, dividirIgual,
  montarCsvMailing, nomeDoArquivo, horariosDoDia, horarioPendente,
} = require('../../src/domain/bases');
const { lerTabela, lerXlsxCompleto, separarCsv } = require('../../src/utils/planilhas');
const { RoboEsteira, VanguardLoginError, periodoDoCenario } = require('../../src/integrations/vanguard/esteira-robo');
const { BasesService, EsteiraDeArquivo } = require('../../src/bases/bases.service');
const { problemasDaBase, validarBases } = require('../../src/bases/configuracao');
const { loggerNulo } = require('../../src/utils/logger');
const { criarVanguardFake, navegadorDeTeste } = require('./vanguard-fake');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bases-'));
const lead = (chave, nome = `CLIENTE ${chave}`) => ({ chave, beneficio: '', nome });

// ───────────── Regras puras ─────────────

test('filtro de status ignora acento, caixa e espaços duplos; lista vazia aceita tudo', () => {
  const f = criarFiltroStatus(['CLIENTE COM  AÇÃO JUDICIAL', 'Não perturbe']);
  assert.equal(f('cliente com acao judicial'), true);
  assert.equal(f('NAO PERTURBE'), true);
  assert.equal(f('TAXA BAIXA'), false);
  assert.equal(criarFiltroStatus([])('qualquer'), true);
});

test('chavesDaEsteira e removerDaBase: o "left anti join" da planilha, sem repetir cliente', () => {
  const esteira = [
    { Codigo: '_A', Status: 'TAXA BAIXA' }, { Codigo: '_B', Status: 'OUTRO' }, { Codigo: '', Status: 'TAXA BAIXA' },
  ];
  const chaves = chavesDaEsteira(esteira, { colunaChave: 'codigo', status: ['taxa baixa'] });
  assert.deepEqual([...chaves], ['_A']);
  const base = [lead('_A'), lead('_C'), lead('_C'), lead('')];
  assert.deepEqual(removerDaBase(base, chaves).map((l) => l.chave), ['_C']);
});

test('leadsDaEsteira (Digital): só os status escolhidos, sem repetir', () => {
  const esteira = [
    { Codigo: '_A', Status: 'AUDITORIA', Nome: 'ANA', Beneficio: '1' },
    { Codigo: '_A', Status: 'AUDITORIA', Nome: 'ANA', Beneficio: '1' },
    { Codigo: '_B', Status: 'PAGO', Nome: 'BIA', Beneficio: '2' },
  ];
  const leads = leadsDaEsteira(esteira, { colunas: { chave: 'Codigo', beneficio: 'Beneficio', nome: 'Nome' }, status: ['Auditoria'] });
  assert.deepEqual(leads, [{ chave: '_A', beneficio: '1', nome: 'ANA' }]);
});

test('embaralhar mantém todos; dividirIgual faz partes iguais (sobra vai para as primeiras) e respeita o limite', () => {
  const lista = Array.from({ length: 23 }, (_, i) => i);
  const mistura = embaralhar(lista, () => 0.3);
  assert.deepEqual([...mistura].sort((a, b) => a - b), lista);
  assert.deepEqual(dividirIgual(lista, 5).map((p) => p.length), [5, 5, 5, 4, 4]);
  assert.deepEqual(dividirIgual(lista, 5).flat(), lista);
  assert.deepEqual(dividirIgual(lista, 5, 3).map((p) => p.length), [3, 3, 3, 3, 3]);
  assert.deepEqual(dividirIgual([], 3), [[], [], []]);
});

test('montarCsvMailing segue o layout da Argus e limpa ";" e quebras de linha', () => {
  const csv = montarCsvMailing([{ chave: '_A', beneficio: '123', nome: 'ANA; DA\nSILVA' }]);
  assert.equal(csv, 'CPF;BENEFICIO;NOME;TELEFONE1;TELEFONE2;TELEFONE3;TELEFONE4;TELEFONE5\r\n_A;123;ANA DA SILVA;;;;;\r\n');
  assert.equal(nomeDoArquivo({ base: 'ativo', equipe: 'ROBSON - URA', data: '2026-10-09', horario: '08:00' }),
    'BASE-ATIVO-ROBSON-URA-20261009-0800.csv');
});

test('agenda: horários do dia e qual rodar agora', () => {
  assert.deepEqual(horariosDoDia(['08:00']), ['08:00']);
  const digital = horariosDoDia({ de: '08:00', ate: '18:00', aCadaMin: 60 });
  assert.equal(digital.length, 11);
  assert.equal(digital[10], '18:00');

  const base = { horarios: digital, data: '2026-10-09', diaSemana: 5, diasSemana: [1, 2, 3, 4, 5], toleranciaMin: 120 };
  assert.equal(horarioPendente({ ...base, hora: '07:59' }), null);
  assert.equal(horarioPendente({ ...base, hora: '09:30' }), '09:00');
  assert.equal(horarioPendente({ ...base, hora: '09:30', ultima: { data: '2026-10-09', horario: '09:00' } }), null);
  assert.equal(horarioPendente({ ...base, hora: '10:00', ultima: { data: '2026-10-09', horario: '09:00' } }), '10:00');
  assert.equal(horarioPendente({ ...base, hora: '23:00' }), null); // depois da tolerância
  assert.equal(horarioPendente({ ...base, hora: '09:00', diaSemana: 0 }), null); // domingo
});

test('periodoDoCenario: sem dias = sem data; 60 dias para trás em dd/mm/aaaa', () => {
  assert.deepEqual(periodoDoCenario({}, '2026-06-23'), { inicial: '', final: '' });
  assert.deepEqual(periodoDoCenario({ diasAtras: 60 }, '2026-06-23'), { inicial: '24/04/2026', final: '23/06/2026' });
});

// ───────────── Planilhas ─────────────

test('separarCsv respeita aspas, ";" dentro de aspas e CRLF', () => {
  assert.deepEqual(separarCsv('a;b\r\n"x;y";"di""z"\r\n', ';'), [['a', 'b'], ['x;y', 'di"z']]);
});

test('lerTabela: CSV em Windows-1252 e .xlsx pela aba (sem acento no nome)', async () => {
  const pasta = tmp();
  const csv = path.join(pasta, 'e.csv');
  fs.writeFileSync(csv, Buffer.from('Codigo;Status\r\n_A;NÃO PERTURBE\r\n', 'latin1'));
  assert.deepEqual(await lerTabela(csv), [{ Codigo: '_A', Status: 'NÃO PERTURBE' }]);

  const xlsx = path.join(pasta, 'base.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('LOTE').addRows([['CPF'], ['_X']]);
  wb.addWorksheet('NÃO MEXA').addRows([['CPF', 'Beneficio', 'Nome'], ['_A', 1, 'ANA'], [], ['_B', null, 'BIA']]);
  wb.addWorksheet('Com buracos').addRows([[null, 'A', null, 'C'], [null, 1, null, 3]]);
  await wb.xlsx.writeFile(xlsx);
  const linhas = await lerTabela(xlsx, { aba: 'nao mexa' });
  assert.deepEqual(linhas.map((l) => l.CPF), ['_A', '_B']);
  await assert.rejects(lerTabela(xlsx, { aba: 'outra' }), /Aba "outra" não encontrada/);
  assert.deepEqual(await lerTabela(xlsx, { aba: 'com buracos' }), [{ '': '', A: 1, C: 3 }]);
  // O recurso final (leitura completa) dá o mesmo resultado que o streaming.
  assert.deepEqual(await lerXlsxCompleto(xlsx, 'Com buracos'), [{ '': '', A: 1, C: 3 }]);
  assert.deepEqual(await lerXlsxCompleto(xlsx, 'NÃO MEXA'), linhas);
});

test('lerTabela: .xlsx com as abas antes do workbook.xml (ordem que quebrava no Windows)', async () => {
  const JSZip = require('jszip');
  const pasta = tmp();
  const original = path.join(pasta, 'original.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('LOTE').addRows([['CPF'], ['_X']]);
  wb.addWorksheet('NÃO MEXA').addRows([['CPF', 'Nome'], ['_A', 'ANA'], ['_B', 'BIA']]);
  await wb.xlsx.writeFile(original);

  // Mesmo conteúdo, com rels e sharedStrings primeiro e o workbook.xml por último.
  const zip = await JSZip.loadAsync(fs.readFileSync(original));
  const prioridade = (n) => {
    if (n === 'xl/workbook.xml') return 3;
    if (/^xl\/worksheets\/sheet/.test(n)) return 2;
    return 1;
  };
  const nomes = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort((a, b) => prioridade(a) - prioridade(b));
  const reordenado = new JSZip();
  for (const n of nomes) reordenado.file(n, await zip.file(n).async('nodebuffer'));
  const xlsx = path.join(pasta, 'reordenado.xlsx');
  fs.writeFileSync(xlsx, await reordenado.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

  assert.deepEqual((await lerTabela(xlsx, { aba: 'NÃO MEXA' })).map((l) => l.CPF), ['_A', '_B']);
  assert.deepEqual((await lerTabela(xlsx)).map((l) => l.CPF), ['_X']);
  await assert.rejects(lerTabela(xlsx, { aba: 'outra' }), /Abas: LOTE, NÃO MEXA/);
});

// ───────────── Robô da esteira (navegador de verdade contra um Vanguard falso) ─────────────

test('RoboEsteira: entra, aplica os filtros de cada cenário, baixa e sai', { timeout: 60_000 }, async () => {
  const v = await criarVanguardFake({
    usuario: 'robo',
    senha: 'segredo',
    registros: [
      { Codigo: '_A', Status: 'X', Nome: 'ANA', Beneficio: '1', Etapa: 'Andamento' },
      { Codigo: '_B', Status: 'TAXA BAIXA', Nome: 'BIA', Beneficio: '2', Etapa: 'Reprovado' },
    ],
  });
  try {
    const robo = new RoboEsteira({
      cfg: { url: v.url, usuario: 'robo', senha: 'segredo', pastaDownload: tmp(), timeoutMs: 15_000, navegador: navegadorDeTeste() },
      logger: loggerNulo,
    });
    const arquivos = await robo.baixar([
      { nome: 'Andamento', tipoData: 'Data Cadastro', etapas: ['andamento'] },
      { nome: 'Reprova', tipoData: 'data reprovacao', diasAtras: 60 },
    ], { hoje: '2026-10-09' });

    assert.deepEqual((await lerTabela(arquivos.Andamento)).map((l) => l.Codigo), ['_A']);
    assert.deepEqual((await lerTabela(arquivos.Reprova)).map((l) => l.Codigo), ['_A', '_B']);
    assert.deepEqual(v.estado.filtros, [
      { tipodata: 'Data Cadastro', inicial: '', final: '', etapas: ['Andamento'], equipes: ['AMANDA', 'MAYSA'] },
      { tipodata: 'Data Reprovação', inicial: '10/08/2026', final: '09/10/2026', etapas: [], equipes: ['AMANDA', 'MAYSA'] },
    ]);
    assert.equal(v.estado.logouts, 1);

    await assert.rejects(robo.baixar([{ nome: 'X', tipoData: 'Data Inexistente' }], { hoje: '2026-10-09' }),
      /"Data Inexistente" não existe no Vanguard\. Opções: Data Cadastro \| Data Pagamento \| Data Reprovação/);

    const errado = new RoboEsteira({ cfg: { ...robo.cfg, senha: 'errada' }, logger: loggerNulo });
    await assert.rejects(errado.baixar([], { hoje: '2026-10-09' }), VanguardLoginError);
  } finally {
    await v.fechar();
  }
});

// ───────────── Serviço ─────────────

/** Argus falsa de mailing: registra uploads e exclusões. */
function argusDeMailing({ falharPara = [] } = {}) {
  const client = { uploads: [], exclusoes: [], proximo: 100 };
  client.uploadMailing = async (hash, { nomeArquivo, conteudo }) => {
    if (falharPara.includes(hash)) throw new Error('Argus recusou');
    client.uploads.push({ hash, nomeArquivo, linhas: conteudo.toString('latin1').trim().split('\r\n').length - 1 });
    client.proximo += 1;
    return { codStatus: 1, idArquivo: client.proximo };
  };
  client.excluirMailing = async (hash, idArquivo) => { client.exclusoes.push({ hash, idArquivo }); };
  return client;
}

async function montarServico({ bases, modo = 'arquivos', dryRun = false, esteira, client = argusDeMailing() }) {
  const pasta = tmp();
  const memoria = { estado: {}, eventos: [], avisos: [] };
  const servico = new BasesService({
    cfg: {
      bases, modo, dryRun, pastaSaida: path.join(pasta, 'saida'), fusoHorario: 'America/Sao_Paulo',
      diasSemana: [1, 2, 3, 4, 5], toleranciaMin: 120, pausaEntreUploadsMs: 0, codificacao: 'latin1',
    },
    esteira,
    client,
    repositorio: { carregar: () => structuredClone(memoria.estado), salvar: async (e) => { memoria.estado = e; } },
    auditoria: { registrar: async (acao, dados) => { memoria.eventos.push({ acao, ...dados }); } },
    notificador: { notificar: async (a) => { memoria.avisos.push(a); } },
    logger: loggerNulo,
    aleatorio: () => 0.5,
  });
  return { servico, memoria, client, pasta };
}

/** Base mestra .xlsx + esteira CSV num diretório temporário. */
async function arquivosDeExemplo({ mestra, esteira }) {
  const pasta = tmp();
  const xlsx = path.join(pasta, 'mestra.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('NÃO MEXA').addRows([['CPF', 'Beneficio', 'Nome'], ...mestra.map((c) => [c, '', `CLIENTE ${c}`])]);
  await wb.xlsx.writeFile(xlsx);
  const csv = path.join(pasta, 'esteira.csv');
  fs.writeFileSync(csv, ['Codigo;Status;Nome;Beneficio', ...esteira.map(([c, s]) => `${c};${s};CLIENTE ${c};9`)].join('\r\n'));
  return { xlsx, csv };
}

const baseAtivo = (xlsx, equipes) => ({
  ativo: true,
  tipo: TipoBase.REMOCAO,
  agenda: ['08:00'],
  baseMestra: { arquivo: xlsx, aba: 'NÃO MEXA' },
  esteira: { colunaChave: 'Codigo' },
  cenarios: [{ nome: 'Andamento', tipoData: 'Data Cadastro', etapas: ['Andamento'] }, { nome: 'Reprova', tipoData: 'Data Reprovação', diasAtras: 60, status: ['TAXA BAIXA'] }],
  equipes,
});

test('BasesService ativo (arquivos): remove a esteira, divide igual e grava um CSV por equipe', async () => {
  const mestra = Array.from({ length: 11 }, (_, i) => `_C${i}`);
  const { xlsx, csv } = await arquivosDeExemplo({ mestra, esteira: [['_C0', 'QUALQUER'], ['_C1', 'TAXA BAIXA']] });
  const { servico, memoria, client } = await montarServico({
    bases: { ativo: baseAtivo(xlsx, [{ nome: 'AMANDA' }, { nome: 'MAYSA' }]) },
    esteira: new EsteiraDeArquivo(csv),
  });
  const r = await servico.executar('ativo', { horario: '08:00', agora: new Date('2026-10-09T11:00:00Z') });
  assert.equal(r.baseMestra, 11);
  assert.equal(r.removidos, 2); // _C0 e _C1 (o 2º cenário não filtra etapa, mas filtra status)
  assert.deepEqual(r.equipes.map((e) => e.clientes), [5, 4]);
  const linhas = r.equipes.flatMap((e) => fs.readFileSync(e.arquivo, 'latin1').trim().split('\r\n').slice(1).map((l) => l.split(';')[0]));
  assert.equal(new Set(linhas).size, 9);
  assert.equal(linhas.includes('_C0') || linhas.includes('_C1'), false);
  assert.equal(client.uploads.length, 0);
  assert.equal(memoria.eventos[0].acao, 'bases.gerada');
  assert.match(memoria.avisos[0].texto, /AMANDA 5, MAYSA 4.*CSVs gerados/);
});

test('BasesService modo argus: sobe por equipe, exclui o mailing anterior só depois do novo e isola falhas', async () => {
  const { xlsx, csv } = await arquivosDeExemplo({ mestra: ['_A', '_B', '_C', '_D'], esteira: [['_D', 'X']] });
  const client = argusDeMailing({ falharPara: ['hash-maysa'] });
  const bases = { ativo: baseAtivo(xlsx, [{ nome: 'AMANDA', skillHash: 'hash-amanda' }, { nome: 'MAYSA', skillHash: 'hash-maysa' }]) };
  const { servico, memoria } = await montarServico({ bases, modo: 'argus', esteira: new EsteiraDeArquivo(csv), client });

  const r1 = await servico.executar('ativo', { horario: '08:00' });
  assert.deepEqual(client.uploads.map((u) => [u.hash, u.linhas]), [['hash-amanda', 2]]);
  assert.equal(r1.equipes[0].idArquivo, 101);
  assert.match(r1.equipes[1].erro, /Argus recusou/);
  assert.equal(memoria.avisos[0].nivel, 'erro');
  assert.equal(client.exclusoes.length, 0);

  await servico.executar('ativo', { horario: '08:00' });
  assert.deepEqual(client.exclusoes, [{ hash: 'hash-amanda', idArquivo: 101 }]);
  assert.equal(memoria.estado.mailings['hash-amanda'], 102);
});

test('BasesService: DRY_RUN no modo argus não sobe nada', async () => {
  const { xlsx, csv } = await arquivosDeExemplo({ mestra: ['_A', '_B'], esteira: [['_Z', 'X']] });
  const bases = { ativo: baseAtivo(xlsx, [{ nome: 'AMANDA', skillHash: 'h' }]) };
  const { servico, client } = await montarServico({ bases, modo: 'argus', dryRun: true, esteira: new EsteiraDeArquivo(csv) });
  const r = await servico.executar('ativo');
  assert.equal(r.modo, 'argus (DRY_RUN)');
  assert.equal(r.equipes[0].simulado, true);
  assert.equal(client.uploads.length, 0);
});

test('BasesService: travas — esteira sem ninguém para remover ou robô fora do ar não geram base', async () => {
  const { xlsx, csv } = await arquivosDeExemplo({ mestra: ['_A'], esteira: [['', 'X']] });
  const bases = { ativo: baseAtivo(xlsx, [{ nome: 'AMANDA' }]) };
  const semRemocao = await montarServico({ bases, esteira: new EsteiraDeArquivo(csv) });
  await assert.rejects(semRemocao.servico.executar('ativo'), /nenhum cliente para remover/);
  assert.equal(semRemocao.memoria.avisos[0].nivel, 'erro');
  assert.equal(fs.existsSync(path.join(semRemocao.pasta, 'saida')), false);

  const foraDoAr = await montarServico({ bases, esteira: { baixar: async () => { throw new Error('Vanguard fora do ar'); } } });
  await assert.rejects(foraDoAr.servico.executar('ativo'), /Vanguard fora do ar/);
  await assert.rejects(foraDoAr.servico.executar('outra'), /Base "outra" não existe/);
});

test('BasesService digital: a base é a esteira filtrada', async () => {
  const { csv } = await arquivosDeExemplo({ mestra: [], esteira: [['_A', 'Auditoria'], ['_B', 'PAGO'], ['_C', 'FORMALIZAÇÃO']] });
  const bases = {
    digital: {
      ativo: true, tipo: TipoBase.ESTEIRA, agenda: { de: '08:00', ate: '18:00', aCadaMin: 60 },
      cenarios: [{ nome: 'Digital', tipoData: 'Data Cadastro', status: ['AUDITORIA', 'formalizacao'] }],
      equipes: [{ nome: 'DIGITAL 1' }, { nome: 'DIGITAL 2' }],
    },
  };
  const { servico } = await montarServico({ bases, esteira: new EsteiraDeArquivo(csv) });
  const r = await servico.executar('digital');
  assert.equal(r.naEsteira, 2);
  assert.deepEqual(r.equipes.map((e) => e.clientes), [1, 1]);
});

test('BasesService tique: roda no horário, uma vez, e tenta de novo depois de uma falha (até 3 vezes)', async () => {
  const { xlsx, csv } = await arquivosDeExemplo({ mestra: ['_A', '_B'], esteira: [['_Z', 'X']] });
  let falhar = true;
  let downloads = 0;
  const esteira = { baixar: async (cenarios) => { downloads++; if (falhar) throw new Error('fora do ar'); return new EsteiraDeArquivo(csv).baixar(cenarios); } };
  const { servico, memoria } = await montarServico({ bases: { ativo: baseAtivo(xlsx, [{ nome: 'AMANDA' }]) }, esteira });
  const as = (hhmm, extraMs = 0) => new Date(new Date(`2026-10-09T${hhmm}:00-03:00`).getTime() + extraMs);

  assert.deepEqual(await servico.tique(as('07:59')), []);
  assert.match((await servico.tique(as('08:00')))[0].erro, /fora do ar/);
  assert.deepEqual(await servico.tique(as('08:01')), []); // espera 5 min antes de tentar de novo
  falhar = false;
  const [ok] = await servico.tique(as('08:06'));
  assert.equal(ok.equipes[0].clientes, 2);
  assert.deepEqual(memoria.estado.bases.ativo.ultima, { data: '2026-10-09', horario: '08:00' });
  assert.deepEqual(await servico.tique(as('08:30')), []);
  assert.equal(downloads, 2);
});

// ───────────── Configuração ─────────────

test('validação do bases.json', () => {
  const ok = baseAtivo(__filename, [{ nome: 'A', skillHash: 'h' }]);
  assert.deepEqual(problemasDaBase('ativo', ok, { modo: 'argus' }), []);
  const ruim = { ...ok, tipo: 'x', agenda: ['8h'], equipes: [{ nome: 'A' }] };
  const p = problemasDaBase('ativo', ruim, { modo: 'argus' });
  assert.equal(p.length, 3);
  assert.match(p.join('\n'), /tipo.*agenda.*skillHash/s);
  assert.deepEqual(problemasDaBase('ativo', { ...ok, equipes: [{ nome: 'A' }] }, { modo: 'arquivos' }), []);
  assert.match(problemasDaBase('ativo', { ...ok, baseMestra: { arquivo: '/nao/existe.xlsx' } }, {}).join(), /não encontrada/);

  const cfg = { bases: { ativo: ok }, modo: 'argus', vanguard: { usuario: '', senha: '' } };
  assert.match(validarBases(cfg).join(), /VANGUARD_USUARIO/);
  assert.deepEqual(validarBases({ ...cfg, bases: { ativo: { ...ok, ativo: false } } }), []);
});

// ───────────── Argus: upload e exclusão de mailing ─────────────

test('ArgusClient.uploadMailing envia form-data com o nome do arquivo; excluirMailing manda o idArquivo', async () => {
  const http = require('http');
  const { ArgusClient } = require('../../src/integrations/argus/argus.client');
  const recebidas = [];
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.setEncoding('latin1');
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      recebidas.push({ url: req.url, tipo: req.headers['content-type'], token: req.headers['token-signature'], corpo });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ codStatus: 1, idArquivo: 77 }));
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${servidor.address().port}/apiargus`;
    const client = new ArgusClient({ baseUrl: `${base}/cmd`, baseMailing: base, token: 'tk', timeoutMs: 2000, tentativas: 1 }, loggerNulo);
    const conteudo = Buffer.from('CPF;NOME\r\n_A;JOÃO\r\n', 'latin1');
    assert.deepEqual(await client.uploadMailing('hash1', { nomeArquivo: 'BASE-ATIVO-X.csv', conteudo }), { codStatus: 1, idArquivo: 77 });
    await client.excluirMailing('hash1', 77);

    const [upload, exclusao] = recebidas;
    assert.equal(upload.url, '/apiargus/hash1/uploadmailing');
    assert.equal(upload.token, 'tk');
    assert.match(upload.tipo, /^multipart\/form-data; boundary=/);
    assert.match(upload.corpo, /filename="BASE-ATIVO-X\.csv"/);
    assert.ok(upload.corpo.includes('_A;JOÃO'));
    assert.equal(exclusao.url, '/apiargus/hash1/excluirmailing');
    assert.deepEqual(JSON.parse(exclusao.corpo), { idArquivo: 77, excluirTodosMailings: 'N' });
  } finally {
    servidor.close();
  }
});

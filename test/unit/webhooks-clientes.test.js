'use strict';
/**
 * [NOVO] Webhook de transferências para clientes: o cliente se cadastra por API e recebe
 * { codigo, nome, mensagem } a cada operador transferido entre URA e Ativo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Assinaturas } = require('../../src/webhooks-clientes/assinaturas');
const { AvisoTransferencias, MENSAGENS } = require('../../src/webhooks-clientes/avisar-transferencia');
const { Transferencias } = require('../../src/rodizio/transferencias');
const { DiscadoraService, Resultado } = require('../../src/integrations/argus/discadora.service');
const { HttpError } = require('../../src/utils/http-client');
const { loggerNulo } = require('../../src/utils/logger');

const arquivoTemp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webhooks-')), 'state-webhooks-clientes.json');
const diretorioFalso = (ops = { 2266423: { idUsuario: 1234, nome: 'Fulano de Tal' } }) => ({
  async atualizar() {},
  operadorPorRamal(r) { return ops[r] ?? null; },
});

test('assinaturas: cadastra (com segredo), lista sem o segredo, remove; o outro processo vê a mudança', async () => {
  const arquivo = arquivoTemp();
  const a = new Assinaturas({ arquivo, logger: loggerNulo });
  const nova = await a.cadastrar({ url: 'https://cliente.exemplo.com/hook', nome: 'CRM' });
  assert.match(nova.id, /^[a-f0-9]{12}$/);
  assert.match(nova.segredo, /^[a-f0-9]{64}$/);
  const lista = a.listar();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].segredo, undefined, 'a lista não mostra o segredo');
  assert.deepEqual([lista[0].nome, lista[0].url], ['CRM', 'https://cliente.exemplo.com/hook']);

  const outroProcesso = new Assinaturas({ arquivo, logger: loggerNulo });
  assert.equal(outroProcesso.paraEnviar().length, 1, 'o roteador lê o mesmo arquivo');
  assert.equal(outroProcesso.paraEnviar()[0].segredo, nova.segredo);

  assert.equal(await a.remover(nova.id), true);
  assert.equal(await a.remover(nova.id), false);
  assert.equal(new Assinaturas({ arquivo, logger: loggerNulo }).listar().length, 0);
});

test('assinaturas: só https (http só para localhost); URL inválida é recusada', async () => {
  const a = new Assinaturas({ arquivo: arquivoTemp(), logger: loggerNulo });
  await assert.rejects(a.cadastrar({ url: 'http://cliente.exemplo.com/hook' }), /https/);
  await assert.rejects(a.cadastrar({ url: 'nada' }), /URL/);
  assert.ok(await a.cadastrar({ url: 'http://localhost:8080/hook' }));
});

function montarAviso({ respostas = [], diretorio = diretorioFalso(), assinaturas } = {}) {
  const pedidos = [];
  const requisitar = async (url, opcoes) => {
    pedidos.push({ url, ...opcoes });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return r ?? {};
  };
  const lista = assinaturas ?? [{ id: 'a1', nome: 'CRM', url: 'https://cliente/hook', segredo: 's'.repeat(64) }];
  const aviso = new AvisoTransferencias({ assinaturas: { paraEnviar: () => lista }, diretorio, logger: loggerNulo, requisitar, baseMs: 1 });
  return { aviso, pedidos };
}

test('aviso: corpo só com codigo, nome e mensagem, nos dois sentidos; assinatura HMAC no cabeçalho', async () => {
  const { aviso, pedidos } = montarAviso();
  await aviso.avisar({ ramal: '2266423', paraUra: false });
  await aviso.avisar({ ramal: '2266423', paraUra: true });
  assert.equal(pedidos.length, 2);
  assert.deepEqual(pedidos[0].corpo, { codigo: 1234, nome: 'Fulano de Tal', mensagem: 'Transferido da URA para o Ativo' });
  assert.deepEqual(pedidos[1].corpo, { codigo: 1234, nome: 'Fulano de Tal', mensagem: 'Transferido do Ativo para a URA' });
  assert.deepEqual(MENSAGENS, { paraAtivo: 'Transferido da URA para o Ativo', paraUra: 'Transferido do Ativo para a URA' });
  const esperada = crypto.createHmac('sha256', 's'.repeat(64)).update(JSON.stringify(pedidos[0].corpo)).digest('hex');
  assert.equal(pedidos[0].headers['X-BenURA-Assinatura'], `sha256=${esperada}`);
  assert.equal(pedidos[0].metodo, 'POST');
});

test('aviso: sem assinaturas não envia; falha não lança e fica no estado; diretório fora manda codigo null', async () => {
  const vazio = montarAviso({ assinaturas: [] });
  await vazio.aviso.avisar({ ramal: '2266423', paraUra: true });
  assert.equal(vazio.pedidos.length, 0);

  const falha = montarAviso({ respostas: [new HttpError('HTTP 500', { status: 500 }), new HttpError('HTTP 500', { status: 500 })] });
  await falha.aviso.avisar({ ramal: '2266423', paraUra: true });
  assert.equal(falha.pedidos.length, 2, 'tenta de novo uma vez');
  assert.match(falha.aviso.situacao().a1.ultimoErro, /HTTP 500/);

  const semDiretorio = montarAviso({ diretorio: { async atualizar() { throw new Error('fora'); }, operadorPorRamal() { throw new Error('sem snapshot'); } } });
  await semDiretorio.aviso.avisar({ ramal: '2266423', paraUra: true });
  assert.deepEqual(semDiretorio.pedidos[0].corpo, { codigo: null, nome: 'Ramal 2266423', mensagem: 'Transferido do Ativo para a URA' });
});

test('rodízio: Transferencias avisa só na transferência de verdade (nem DRY_RUN, nem falha, nem em espera)', async () => {
  const avisos = [];
  const criar = (cfg, client) => new Transferencias({ client, cfg: { grupoUraId: 2, ...cfg }, logger: loggerNulo, aoTransferir: (a) => avisos.push(a) });
  const ok = criar({}, { transferirOperador: async () => {} });
  assert.equal(await ok.transferir('2266423', 2), true);
  assert.equal(await ok.transferir('2266423', 7), true);
  assert.deepEqual(avisos, [{ ramal: '2266423', paraUra: true }, { ramal: '2266423', paraUra: false }]);

  avisos.length = 0;
  await criar({ dryRun: true }, { transferirOperador: async () => {} }).transferir('1', 2);
  await criar({}, { transferirOperador: async () => { throw new Error('caiu'); } }).transferir('1', 2);
  assert.deepEqual(avisos, []);
});

test('roteador: a discadora avisa só no TRANSFERIDO (não no "já estava" nem no simulado)', async () => {
  const avisos = [];
  const criar = (dryRun = false) => new DiscadoraService({
    client: { transferirOperador: async () => {} }, cfg: { gruposAtivosIds: [7], grupoUraId: 2, cacheGruposMs: 1000, dryRun },
    diretorio: null, logger: loggerNulo, aoTransferir: (a) => avisos.push(a),
  });
  const d = criar();
  assert.equal((await d.transferirParaGrupo('2266423', 2, { grupoAnterior: 7, rotulo: 'URA' })).resultado, Resultado.TRANSFERIDO);
  assert.equal((await d.transferirParaGrupo('2266423', 7, { grupoAnterior: 2, rotulo: 'ATIVO' })).resultado, Resultado.TRANSFERIDO);
  await d.transferirParaGrupo('2266423', 2, { grupoAnterior: 2, rotulo: 'URA' });
  await criar(true).transferirParaGrupo('2266423', 2, { grupoAnterior: 7, rotulo: 'URA' });
  assert.deepEqual(avisos, [{ ramal: '2266423', paraUra: true }, { ramal: '2266423', paraUra: false }]);
});

test('rotas do rodízio: cadastrar, listar (sem segredo), testar e remover; tudo protegido pelo token', async () => {
  const { criarRotasDoRodizio } = require('../../src/rodizio/controllers');
  const assinaturas = new Assinaturas({ arquivo: arquivoTemp(), logger: loggerNulo });
  const testes = [];
  const aviso = { testar: async (id) => { testes.push(id); return { ok: true }; }, situacao: () => ({}) };
  const rotas = criarRotasDoRodizio({ rodizio: {}, retornoFila: null, ciclos: {}, logger: loggerNulo, webhooksClientes: { assinaturas, aviso } });
  const rota = (metodo, caminho) => rotas.find((r) => r.metodo === metodo && r.caminho === caminho);
  for (const r of rotas.filter((x) => x.caminho.startsWith('/webhooks/clientes'))) assert.equal(r.protegida, true, `${r.metodo} ${r.caminho}`);

  const cad = await rota('POST', '/webhooks/clientes').handler({ corpo: { url: 'https://cliente.exemplo.com/hook', nome: 'CRM' }, req: { url: '/webhooks/clientes' } });
  assert.equal(cad.status, 201);
  assert.ok(cad.corpo.segredo);
  const ruim = await rota('POST', '/webhooks/clientes').handler({ corpo: { url: 'http://x.com' }, req: { url: '/webhooks/clientes' } });
  assert.equal(ruim.status, 400);

  const lista = await rota('GET', '/webhooks/clientes').handler({ req: { url: '/webhooks/clientes' } });
  assert.equal(lista.corpo.clientes.length, 1);
  assert.equal(lista.corpo.clientes[0].segredo, undefined);

  assert.equal((await rota('POST', '/webhooks/clientes/testar').handler({ corpo: { id: cad.corpo.id }, req: { url: '/' } })).status, 200);
  assert.deepEqual(testes, [cad.corpo.id]);

  assert.equal((await rota('DELETE', '/webhooks/clientes').handler({ req: { url: `/webhooks/clientes?id=${cad.corpo.id}` } })).status, 200);
  assert.equal((await rota('DELETE', '/webhooks/clientes').handler({ req: { url: '/webhooks/clientes?id=nao-existe' } })).status, 404);
  assert.equal((await rota('POST', '/webhooks/clientes/remover').handler({ corpo: { id: 'nao-existe' }, req: { url: '/' } })).status, 404);
});

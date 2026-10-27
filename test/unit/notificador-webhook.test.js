'use strict';
/** [NOVO] Avisos para fora (BenHub): webhook genérico, com o log de hoje sempre junto. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificadorWebhook } = require('../../src/notificacoes/notificador-webhook');
const { criarNotificador } = require('../../src/notificacoes');
const { HttpError } = require('../../src/utils/http-client');
const { loggerNulo } = require('../../src/utils/logger');
const os = require('os');
const path = require('path');
const fs = require('fs');

/** O registro local (log + trilha), como o NotificadorLog. */
const registroFalso = () => ({ avisos: [], async notificar(a) { this.avisos.push(a); return { ok: true, destino: 'log' }; } });

function montar(respostas) {
  const pedidos = [];
  const requisitar = async (url, opcoes) => {
    pedidos.push({ url, ...opcoes });
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return r ?? { ok: true };
  };
  const registro = registroFalso();
  const n = new NotificadorWebhook({ url: 'https://benhub.exemplo.com/api/notificacoes', token: 'tok-123', registro, requisitar, baseMs: 1, logger: loggerNulo });
  return { n, pedidos, registro };
}

test('webhook: envia título, texto e nível com o token; registra no log também', async () => {
  const { n, pedidos, registro } = montar([{ ok: true }]);
  const r = await n.notificar({ titulo: 'Rodízio fora do ar', texto: 'Há 5 min.', nivel: 'erro', dados: { segredo: 'não vai' } });
  assert.deepEqual(r, { ok: true, destino: 'webhook' });
  assert.equal(pedidos.length, 1);
  const [p] = pedidos;
  assert.equal(p.url, 'https://benhub.exemplo.com/api/notificacoes');
  assert.equal(p.metodo, 'POST');
  assert.equal(p.headers.Authorization, 'Bearer tok-123');
  assert.deepEqual(Object.keys(p.corpo).sort(), ['em', 'nivel', 'origem', 'texto', 'titulo']);
  assert.deepEqual([p.corpo.titulo, p.corpo.texto, p.corpo.nivel, p.corpo.origem], ['Rodízio fora do ar', 'Há 5 min.', 'erro', 'BenURA']);
  assert.equal(registro.avisos.length, 1, 'o log de hoje continua registrando');
});

test('webhook: tenta de novo em falha de rede; recusa (4xx) não repete; nunca lança', async () => {
  const rede = montar([new HttpError('caiu', { status: 0 }), { ok: true }]);
  assert.equal((await rede.n.notificar({ titulo: 't', texto: 'x' })).ok, true);
  assert.equal(rede.pedidos.length, 2);

  const recusa = montar([new HttpError('HTTP 401', { status: 401 })]);
  const r = await recusa.n.notificar({ titulo: 't', texto: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.erro, /401/);
  assert.equal(recusa.pedidos.length, 1);
  assert.equal(recusa.registro.avisos.length, 1, 'ficou no log mesmo sem chegar ao BenHub');
});

test('criarNotificador: log por padrão; webhook só com URL', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'notif-'));
  const arquivo = path.join(pasta, 'n.jsonl');
  const cfg = (tipo, url = '') => ({ notificacoes: { tipo, arquivo, webhook: { url, token: 't', timeoutMs: 1000 } } });
  assert.equal(criarNotificador({ cfg: cfg('log'), logger: loggerNulo }).descricao().tipo, 'log');
  assert.equal(criarNotificador({ cfg: cfg('webhook'), logger: loggerNulo }).descricao().tipo, 'log', 'sem URL fica no log');
  const w = criarNotificador({ cfg: cfg('webhook', 'https://benhub/x'), logger: loggerNulo });
  assert.deepEqual(w.descricao(), { tipo: 'webhook', destino: 'definido' });
  assert.ok(!JSON.stringify(w.descricao()).includes('benhub'), 'o endereço não sai');
});

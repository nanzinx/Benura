'use strict';
/** Notificador do BenHub contra um BenHub falso: login, renovação do token e falha sem derrubar nada. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { NotificadorBenHub, formatar, expiracaoDoJwt } = require('../../src/notificacoes/notificador-benhub');
const { criarNotificador, faltaParaBenHub } = require('../../src/notificacoes');
const { loggerNulo } = require('../../src/utils/logger');

/** JWT de teste (assinatura falsa) com expiração em `segundos`. */
const jwt = (segundos) => ['e30', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + segundos })).toString('base64url'), 'x'].join('.');

async function benhubFalso({ validos }) {
  const estado = { logins: [], mensagens: [], recusar: false };
  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const dados = corpo ? JSON.parse(corpo) : {};
      const responder = (status, json) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      if (req.url === '/api/auth/login') {
        estado.logins.push(dados);
        if (dados.password !== 'certa') return responder(401, { error: 'credenciais' });
        const token = jwt(86_400);
        validos.add(token);
        return responder(200, { token });
      }
      const token = (req.headers.authorization || '').replace('Bearer ', '');
      if (estado.recusar || !validos.has(token)) return responder(401, { error: 'token' });
      estado.mensagens.push({ url: req.url, ...dados });
      return responder(201, { id: estado.mensagens.length });
    });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${servidor.address().port}`, estado, fechar: () => new Promise((r) => servidor.close(r)) };
}

const cfgBenHub = (url, extra = {}) => ({
  url, chatId: '42', email: 'robo@benconsig.com', senha: 'certa', token: '',
  caminhoLogin: '/api/auth/login', campoUsuario: 'email', campoSenha: 'password', timeoutMs: 2000, ...extra,
});

function reservaEmMemoria() {
  const avisos = [];
  return { avisos, notificar: async (a) => { avisos.push(a); } };
}

test('formatar e expiracaoDoJwt', () => {
  assert.equal(formatar({ titulo: 'Base ATIVO 08:00', texto: 'ok', nivel: 'erro' }), '🚨 BenURA · Base ATIVO 08:00\nok');
  assert.ok(Math.abs(expiracaoDoJwt(jwt(60)) - (Date.now() + 60_000)) < 2000);
  assert.equal(expiracaoDoJwt('lixo'), null);
});

test('NotificadorBenHub: faz login, posta no grupo e reaproveita o token', async () => {
  const b = await benhubFalso({ validos: new Set() });
  try {
    const reserva = reservaEmMemoria();
    const n = new NotificadorBenHub({ cfg: cfgBenHub(b.url), reserva, logger: loggerNulo });
    await n.notificar({ titulo: 'Fim de expediente', texto: '2 logados', nivel: 'aviso' });
    await n.notificar({ titulo: 'Base ATIVO', texto: 'ok' });
    assert.equal(b.estado.logins.length, 1);
    assert.deepEqual(b.estado.logins[0], { email: 'robo@benconsig.com', password: 'certa' });
    assert.deepEqual(b.estado.mensagens.map((m) => [m.url, m.content_type, m.reply_to_id]),
      [['/api/internal-chat/42/messages', 'text', null], ['/api/internal-chat/42/messages', 'text', null]]);
    assert.equal(b.estado.mensagens[0].content, '⚠️ BenURA · Fim de expediente\n2 logados');
    assert.equal(reserva.avisos.length, 2, 'o log recebe tudo também');
  } finally {
    await b.fechar();
  }
});

test('NotificadorBenHub: token vencido ou recusado → entra de novo; sem como entrar → só log, sem lançar', async () => {
  const validos = new Set();
  const b = await benhubFalso({ validos });
  try {
    const vencido = new NotificadorBenHub({ cfg: cfgBenHub(b.url, { token: jwt(-10) }), reserva: reservaEmMemoria(), logger: loggerNulo });
    await vencido.notificar({ titulo: 'x', texto: 'y' });
    assert.equal(b.estado.logins.length, 1);

    const recusado = new NotificadorBenHub({ cfg: cfgBenHub(b.url, { token: jwt(3600) }), reserva: reservaEmMemoria(), logger: loggerNulo });
    await recusado.notificar({ titulo: 'x', texto: 'y' }); // token não reconhecido → 401 → login → reenvia
    assert.equal(b.estado.logins.length, 2);
    assert.equal(b.estado.mensagens.length, 2);

    const reserva = reservaEmMemoria();
    const semSenha = new NotificadorBenHub({ cfg: cfgBenHub(b.url, { senha: 'errada' }), reserva, logger: loggerNulo });
    await semSenha.notificar({ titulo: 'x', texto: 'y' }); // login recusado: não lança
    assert.equal(reserva.avisos.length, 1);
    assert.equal(b.estado.mensagens.length, 2);
  } finally {
    await b.fechar();
  }
});

test('criarNotificador: benhub só com grupo e credenciais; senão, log', () => {
  const os = require('os');
  const path = require('path');
  const arquivo = path.join(os.tmpdir(), `notif-${process.pid}.jsonl`);
  const benhub = cfgBenHub('http://x');
  const cfg = (tipo, b = benhub) => ({ notificacoes: { tipo, arquivo, benhub: b } });
  assert.equal(criarNotificador({ cfg: cfg('benhub'), logger: loggerNulo }).constructor.name, 'NotificadorBenHub');
  assert.equal(criarNotificador({ cfg: cfg('benhub', { ...benhub, chatId: '' }), logger: loggerNulo }).constructor.name, 'NotificadorLog');
  assert.equal(criarNotificador({ cfg: cfg('log'), logger: loggerNulo }).constructor.name, 'NotificadorLog');
  assert.equal(faltaParaBenHub({ ...benhub, email: '', senha: '', token: '' }), 'BENHUB_EMAIL e BENHUB_SENHA');
});

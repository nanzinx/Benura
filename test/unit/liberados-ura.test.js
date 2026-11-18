'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lerFixos, diaAnteriorComOperacao, calcular, comunicado, lerDiasOperacao } = require('../../src/domain/liberados-ura');

const VENDAS_17_11 = `Stephanny Marlene Firmo dos Santos 99823,54
Emilly Santos Araujo 90456,15
Jamily Barbosa Mello da Silva 89398,37
Isabella Veloso Fernandes 70289,81
Renato Mariano de Jesus 64839,31
Yasmin Ferreira de Jesus 60966,52
Eduardo Monteiro Ferreira 46010,04
Mauricio Rodrigues Ramos dos Santos 45100,43
Igor Melo Gomes da Silva 44983,26
Pedro Henrique de Souza Trindade 41783,84
Eloiza de Oliveira da Silva 40469,63
Gabriel Nascimento da Silva 28391,88
Sophia Reis Santos 25394,55
Kyara Kymbelly Almeida da Silva 24255,38
Lara Nathaly Borges Dantas Santos 23634,62
Ana Clara Nascimento de Souza 21561,68
Nicolly Vitoria de Andrade 19885,22
Isabelly da Silva Pereira 11956`.split('\n').map((l) => {
  const m = /^(.*) ([\d,]+)$/.exec(l);
  return { nome: m[1], valor: Number(m[2].replace(',', '.')) };
});
const FIXOS = lerFixos('Stephanny, Jamily, Renato, Eduardo (CLT)');

test('liberados: o caso real de 17/11 (meta R$ 50.000)', () => {
  const r = calcular({ vendas: VENDAS_17_11, meta: 50000, fixos: FIXOS });
  assert.equal(r.total, 849200.23);
  assert.deepEqual(r.bateram.map((x) => x.nome.split(' ')[0]), ['Stephanny', 'Emilly', 'Jamily', 'Isabella', 'Renato', 'Yasmin']);
  assert.equal(r.liberados.length, 7);
  assert.deepEqual(r.liberados.filter((x) => !x.fixo).map((x) => x.nome.split(' ')[0]), ['Emilly', 'Isabella', 'Yasmin']);
  assert.equal(r.fixosNaUra, 4);
  assert.equal(r.pelaMeta, 3);
  const eduardo = r.liberados.find((x) => x.nome.startsWith('Eduardo'));
  assert.equal(eduardo.fixo.obs, 'CLT');
  assert.equal(Math.round(eduardo.pct), 92);
  assert.equal(Math.round(-eduardo.diferenca), 3990);
  assert.deepEqual(r.quaseLa.map((x) => x.nome.split(' ')[0]), ['Eduardo', 'Mauricio', 'Igor', 'Pedro', 'Eloiza']);
  assert.equal(r.coroa, 'Stephanny Marlene Firmo dos Santos');
  assert.deepEqual(r.liberados.map((x) => x.valor), [...r.liberados.map((x) => x.valor)].sort((a, b) => b - a), 'por valor');
});

test('liberados: o comunicado no formato combinado', () => {
  const r = calcular({ vendas: VENDAS_17_11, meta: 50000, fixos: FIXOS });
  const texto = comunicado({ diaUra: '2026-11-18', diaVendas: '2026-11-17', meta: 50000, fixos: FIXOS, bateram: r.bateram });
  assert.equal(texto, `📢 *URA — Lista de hoje (18/11)*

Bom dia, time! Seguimos com a *regra padrão da URA*:
👉 Para iniciar na URA, é preciso ter vendido *R$ 50.000 no dia anterior*.

📌 *Fixos na URA:*
• Stephanny
• Jamily
• Renato
• Eduardo

🏆 *Bateram a meta ontem (17/11):*
1️⃣ *Stephanny Marlene Firmo dos Santos* — R$ 99.823,54 (200% da meta) 🥇
2️⃣ *Emilly Santos Araujo* — R$ 90.456,15 (181%)
3️⃣ *Jamily Barbosa Mello da Silva* — R$ 89.398,37 (179%)
4️⃣ *Isabella Veloso Fernandes* — R$ 70.289,81 (141%)
5️⃣ *Renato Mariano de Jesus* — R$ 64.839,31 (130%)
6️⃣ *Yasmin Ferreira de Jesus* — R$ 60.966,52 (122%)

⚠️ *ATENÇÃO:* todas as ligações serão *acompanhadas*. Caso seja identificado *qualquer desvio de conduta*, o colaborador será *banido da URA pelo restante do mês*.

🕘 A lista será enviada aqui *todos os dias até as 09:00*.

Parabéns a quem bateu e bora pra cima! 🚀`);
});

test('liberados: ninguém bateu; do 10º em diante a numeração vira 🔟 e "11."', () => {
  const nada = comunicado({ diaUra: '2026-11-18', diaVendas: '2026-11-17', meta: 50000, fixos: FIXOS, bateram: [] });
  assert.match(nada, /\(17\/11\):\*\nNinguém bateu a meta ontem\.\n\n/);
  const muitos = Array.from({ length: 11 }, (_, i) => ({ nome: `Pessoa ${i}`, valor: 60000 - i }));
  const r = calcular({ vendas: muitos, meta: 50000, fixos: [] });
  const texto = comunicado({ diaUra: '2026-11-18', diaVendas: '2026-11-17', meta: 50000, fixos: [], bateram: r.bateram });
  assert.match(texto, /\n🔟 \*Pessoa 9\*/);
  assert.match(texto, /\n11\. \*Pessoa 10\*/);
  assert.equal((texto.match(/🥇/g) || []).length, 1);
});

test('liberados: fixo sem venda entra com R$ 0; o primeiro nome casa sem acento nem maiúscula', () => {
  const r = calcular({ vendas: [{ nome: 'ÉDUARDO Monteiro', valor: 10 }], meta: 50000, fixos: lerFixos('eduardo, Zé') });
  assert.equal(r.liberados.find((x) => x.nome.startsWith('ÉDUARDO')).fixo.nome, 'eduardo');
  const ze = r.liberados.find((x) => x.nome === 'Zé');
  assert.equal(ze.semVenda, true);
  assert.equal(ze.valor, 0);
});

test('liberados: o dia anterior com operação (segunda pega o sábado; domingo nunca)', () => {
  assert.equal(diaAnteriorComOperacao('2026-11-18'), '2026-11-17'); // quarta → terça
  assert.equal(diaAnteriorComOperacao('2026-11-23'), '2026-11-21'); // segunda → sábado
  assert.equal(diaAnteriorComOperacao('2026-11-23', '1,2,3,4,5'), '2026-11-20'); // sem sábado → sexta
  assert.deepEqual(lerDiasOperacao(''), [1, 2, 3, 4, 5, 6]);
});

// ---- adaptador (Carrossel + foto do dia) e o serviço do painel ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FonteVendasCarrossel } = require('../../src/integrations/vendas/fonte-carrossel');
const { LiberadosUra } = require('../../src/painel/liberados-ura');
const { loggerNulo } = require('../../src/utils/logger');

const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'liberados-'));
const carrosselFalso = ({ hoje = [], ontem = [], diaOntem = null, fora = false } = {}) => ({
  listarVendas: async (periodo) => {
    if (fora) throw new Error('fora do ar');
    return periodo === 'hoje' ? { vendedores: hoje, diaOntem } : { vendedores: ontem, diaOntem };
  },
});
const VENDAS_17 = [
  { nome: 'Emilly Souza', totalVendas: 80000 }, { nome: 'Eduardo Lima', totalVendas: 46010 }, { nome: 'Igor Reis', totalVendas: 42000 },
];

test('adaptador: o "ontem" do Carrossel só vale para o mesmo dia; senão a foto; senão o motivo', async () => {
  const dir = pasta();
  // sábado 21/11, 17:00 em São Paulo: a foto do dia
  let agora = new Date('2026-11-21T20:00:00Z');
  const fonte = new FonteVendasCarrossel({ carrossel: carrosselFalso({ hoje: VENDAS_17, diaOntem: '20/11/2026', ontem: VENDAS_17 }), arquivo: path.join(dir, 'v.json'), fuso: 'America/Sao_Paulo', logger: loggerNulo, agora: () => agora });
  assert.equal(await fonte.fotografar(), true);

  // na segunda (23/11), o "ontem" do Carrossel é a sexta: usa a foto de sábado
  agora = new Date('2026-11-23T11:30:00Z');
  const sab = await fonte.vendasDoDia('2026-11-21');
  assert.equal(sab.vendas.length, 3);
  assert.match(sab.origem, /foto do Carrossel de 21\/11\/2026 às 17:00/);

  const sexta = await fonte.vendasDoDia('2026-11-20');
  assert.match(sexta.origem, /Carrossel \("ontem" = 20\/11\/2026\)/);

  const nada = await new FonteVendasCarrossel({ carrossel: carrosselFalso({ fora: true }), arquivo: path.join(pasta(), 'v.json'), fuso: 'America/Sao_Paulo', logger: loggerNulo }).vendasDoDia('2026-11-21');
  assert.equal(nada.vendas, null);
  assert.match(nada.motivo, /Sem as vendas de 21\/11\/2026: Carrossel indisponível/);

  // a foto sobrevive a reiniciar o painel
  await fonte.aguardar();
  const outra = new FonteVendasCarrossel({ carrossel: carrosselFalso({ fora: true }), arquivo: path.join(dir, 'v.json'), fuso: 'America/Sao_Paulo', logger: loggerNulo });
  assert.equal((await outra.vendasDoDia('2026-11-21')).vendas.length, 3);
});

const cfgServico = (dir, extra = {}) => ({ meta: 50000, fixos: 'Stephanny, Jamily, Renato, Eduardo (CLT)', horario: '08:30', diasOperacao: '1,2,3,4,5,6', arquivo: path.join(dir, 'l.json'), ...extra });

test('serviço: gera, guarda no histórico e sem dados grava o motivo (sem comunicado)', async () => {
  const dir = pasta();
  const pedidos = [];
  const fonte = { vendasDoDia: async (dia) => { pedidos.push(dia); return dia === '2026-11-17' ? { vendas: VENDAS_17.map((v) => ({ nome: v.nome, valor: v.totalVendas })), origem: 'teste' } : { vendas: null, motivo: 'Sem as vendas de 21/11/2026: teste.' }; } };
  const s = new LiberadosUra({ fonte, cfg: cfgServico(dir), fuso: 'America/Sao_Paulo', logger: loggerNulo });

  const ok = await s.gerar({ diaUra: '2026-11-18', por: 'Ana' });
  assert.equal(pedidos[0], '2026-11-17');
  assert.equal(ok.ok, true);
  assert.equal(ok.liberados.length, 5, '4 fixos + Emilly');
  assert.match(ok.texto, /URA — Lista de hoje \(18\/11\)/);

  const vazio = await s.gerar({ diaUra: '2026-11-23' });
  assert.equal(pedidos[1], '2026-11-21', 'segunda pega o sábado');
  assert.equal(vazio.ok, false);
  assert.equal(vazio.texto, undefined, 'nunca gera comunicado vazio');
  assert.match(vazio.motivo, /Sem as vendas de 21\/11\/2026/);

  // reabre do arquivo: o histórico e a config trocada ficam
  s.definirConfig({ meta: 60000 }, 'Ana');
  await s.aguardar();
  const de_novo = new LiberadosUra({ fonte, cfg: cfgServico(dir), fuso: 'America/Sao_Paulo', logger: loggerNulo, agora: () => new Date('2026-11-18T12:00:00Z') });
  assert.deepEqual(de_novo.resumo('2026-11-18').datas, ['2026-11-23', '2026-11-18']);
  assert.equal(de_novo.config().meta, 60000);
  assert.throws(() => de_novo.definirConfig({ horario: '8h' }, 'x'), /Horário inválido/);
  await assert.rejects(de_novo.enviar('2026-11-18', 'Ana'), /LIBERADOS_URA_WEBHOOK_URL/);
});

test('serviço: a agenda gera na hora, só nos dias com operação, e tenta de novo sem dados', async () => {
  const dir = pasta();
  let agora = new Date('2026-11-22T11:40:00Z'); // domingo 08:40
  let comDados = false;
  const fonte = { vendasDoDia: async () => (comDados ? { vendas: [{ nome: 'Emilly', valor: 60000 }], origem: 't' } : { vendas: null, motivo: 'sem' }) };
  const enviados = [];
  const grupo = { notificar: async (a) => { enviados.push(a); return { ok: true }; } };
  const s = new LiberadosUra({ fonte, cfg: cfgServico(dir), fuso: 'America/Sao_Paulo', logger: loggerNulo, agora: () => agora, grupo });
  assert.equal(await s.verificar(), null, 'domingo não tem');
  agora = new Date('2026-11-23T11:20:00Z'); // segunda 08:20
  assert.equal(await s.verificar(), null, 'antes do horário');
  agora = new Date('2026-11-23T11:31:00Z');
  assert.equal((await s.verificar()).ok, false);
  comDados = true;
  agora = new Date('2026-11-23T11:35:00Z');
  assert.equal(await s.verificar(), null, 'espera 10 min para tentar de novo');
  agora = new Date('2026-11-23T11:42:00Z');
  assert.equal((await s.verificar()).ok, true);
  assert.equal(enviados.length, 0, 'a agenda nunca envia ao grupo sozinha');
  const envio = await s.enviar('2026-11-23', 'Ana');
  assert.equal(envio.ok, true);
  assert.match(enviados[0].texto, /Emilly/);
});

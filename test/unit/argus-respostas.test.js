'use strict';
/**
 * [NOVO] Os parsers do BenURA contra respostas da Argus guardadas em test/fixtures/argus/.
 * "origem": "exemplo" é o formato visto em produção; "argus" é uma captura real
 * (npm run capturar:argus), já sem dados pessoais. Qualquer fixture nova entra nos testes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classificarStatus, Classe } = require('../../src/domain/rodizio');
const { RodizioService } = require('../../src/rodizio/rodizio.service');
const { tipoDaLigacao, contarResultados, resumirLigacoes, semDadosDeCliente } = require('../../src/domain/diagnostico-callbacks');
const { dadosPessoais } = require('../../src/domain/sanitizar-argus');

const PASTA = path.join(__dirname, '..', 'fixtures', 'argus');
const DESCRICOES = { livres: ['livre', 'disponivel'], atendimento: ['atendimento', 'em atendimento', 'falando', 'conversa'], offline: ['deslogado', 'offline', 'desconectado'] };
const fixtures = fs.readdirSync(PASTA).filter((f) => f.endsWith('.json')).map((f) => ({ arquivo: f, ...JSON.parse(fs.readFileSync(path.join(PASTA, f), 'utf8')) }));
const doComando = (c) => fixtures.filter((f) => f.comando === c);

test('fixtures da Argus: todas têm origem, comando e resposta, e nenhum dado pessoal', () => {
  assert.ok(fixtures.length >= 4);
  for (const f of fixtures) {
    assert.ok(['exemplo', 'argus'].includes(f.origem), `${f.arquivo}: origem`);
    assert.ok(f.comando && f.resposta != null, `${f.arquivo}: comando e resposta`);
    assert.deepEqual(dadosPessoais(f.resposta), [], `${f.arquivo}: dado pessoal`);
  }
});

test('statusoperador: cada status vira uma classe, e o tempoStatus vira "desde quando"', () => {
  const agora = Date.parse('2026-10-27T13:00:00Z');
  for (const f of doComando('statusoperador')) {
    for (const s of f.resposta) {
      const classe = classificarStatus(s, DESCRICOES);
      assert.ok(Object.values(Classe).includes(classe), `${f.arquivo} ${s.ramal}: classe ${classe}`);
      const d = RodizioService.prototype.detalheDoStatus.call({}, s, agora);
      if (Number.isFinite(Number(s.tempoStatus))) assert.equal(d.statusDesde, agora - Number(s.tempoStatus), `${f.arquivo} ${s.ramal}: statusDesde`);
      if (s.descricaoPausa) assert.equal(d.pausa, String(s.descricaoPausa).trim());
    }
  }
  const exemplo = doComando('statusoperador').find((f) => f.origem === 'exemplo');
  if (exemplo) {
    assert.deepEqual(exemplo.resposta.map((s) => classificarStatus(s, DESCRICOES)), [Classe.LIVRE, Classe.ATENDIMENTO, Classe.OUTRO, Classe.LIVRE, Classe.OFFLINE]);
  }
});

test('listargrupos: todo grupo tem id e ramais (o que o rodízio lê)', () => {
  for (const f of doComando('listargrupos')) {
    assert.ok(Array.isArray(f.resposta) && f.resposta.length, f.arquivo);
    for (const g of f.resposta) {
      assert.ok(Number.isFinite(Number(g.idGrupoUsuario)), `${f.arquivo}: idGrupoUsuario`);
      assert.ok(Array.isArray(g.ramaisOperadores ?? []), `${f.arquivo}: ramaisOperadores`);
    }
  }
});

test('listarpausas: id e nome de cada pausa', () => {
  for (const f of doComando('listarpausas')) {
    for (const p of f.resposta) assert.ok(p.idPausa != null && typeof p.pausaDesc === 'string', f.arquivo);
  }
});

test('ligacoesdetalhadas: o resultado vira callback / derivou / sem agente / abandono, e o resumo não leva cliente', () => {
  for (const f of doComando('ligacoesdetalhadas')) {
    const tipos = f.resposta.map(tipoDaLigacao);
    assert.ok(tipos.some(Boolean), `${f.arquivo}: nenhum resultado reconhecido (${JSON.stringify(contarResultados(f.resposta))})`);
    const r = resumirLigacoes(f.resposta);
    assert.equal(r.total, f.resposta.length);
    for (const campo of ['nomeCliente', 'cpfCnpj', 'dddTelefone', 'camposCRM', 'historico']) assert.ok(!r.campos.includes(campo), `${f.arquivo}: ${campo}`);
    for (const l of f.resposta) assert.ok(!('cpfCnpj' in semDadosDeCliente(l)));
  }
  const exemplo = doComando('ligacoesdetalhadas').find((f) => f.origem === 'exemplo');
  if (exemplo) assert.deepEqual(exemplo.resposta.map(tipoDaLigacao), ['callback', 'derivou', 'semAgente', 'abandonoNaUra']);
});

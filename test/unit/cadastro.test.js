'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  interpretarLoginVanguard, ehPerfilOperador, sugerirProximoRamal, LoginVanguardInvalidoError, StatusPlano, StatusConferencia,
} = require('../../src/domain/cadastro-operador');
const { CadastroOperadorService } = require('../../src/services/cadastro-operador.service');
const { FonteFuncionarioManual } = require('../../src/integrations/vanguard/fonte-manual');
const { loggerNulo } = require('../../src/utils/logger');
const { montarArgusMock, grupoAtual } = require('./helpers');

const GABRIEL = 'GABRIEL NASCIMENTO DA SILVA';
const MAYSA = 'MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO';

test('login do Vanguard → login da Argus + agência', () => {
  assert.deepEqual(interpretarLoginVanguard(' yasmin.ferreira@36241 '),
    { loginVanguard: 'YASMIN.FERREIRA@36241', loginArgus: 'YASMIN.FERREIRA', codigoAgencia: '36241' });
  assert.equal(interpretarLoginVanguard('Jamily.Barbosa@33907').loginArgus, 'JAMILY.BARBOSA');
  assert.equal(interpretarLoginVanguard('SEM.AGENCIA').codigoAgencia, null);
  assert.throws(() => interpretarLoginVanguard('com espaco@1'), LoginVanguardInvalidoError);
  assert.throws(() => interpretarLoginVanguard('@123'), LoginVanguardInvalidoError);
});

test('perfil e sugestão de ramal', () => {
  assert.ok(ehPerfilOperador('Operador Call Center'));
  assert.ok(!ehPerfilOperador('Supervisor'));
  assert.equal(sugerirProximoRamal(['2266111', '2266767', 'abc']), '2266768');
  assert.equal(sugerirProximoRamal([]), null);
});

function montar(dadosVanguard) {
  const argus = montarArgusMock();
  const eventos = [];
  const servico = new CadastroOperadorService({
    fonteFuncionarios: new FonteFuncionarioManual(dadosVanguard),
    diretorio: argus.diretorio,
    discadora: argus.discadora,
    auditoria: { registrar: async (acao, dados) => eventos.push({ acao, ...dados }) },
    cfg: argus.cfg,
    logger: loggerNulo,
  });
  return { servico, eventos, ...argus };
}

test('planejar: operador novo gera ficha completa e auditoria', async () => {
  const { servico, eventos } = montar({ nome: 'Yasmin  Ferreira de Jesus', supervisor: MAYSA });
  const p = await servico.planejar('yasmin.ferreira@36241');
  assert.equal(p.status, StatusPlano.PRONTO);
  assert.equal(p.ficha.nome, 'YASMIN FERREIRA DE JESUS');
  assert.equal(p.ficha.login, 'YASMIN.FERREIRA');
  assert.equal(p.ficha.ramalIntegracaoSugerido, '2266768');
  assert.deepEqual(
    [p.ficha.vinculo.campanha, p.ficha.vinculo.idGrupo, p.ficha.vinculo.grupo, p.ficha.vinculo.idSupervisor],
    ['BENCONSIG', 3, 'MAYSA - COMERCIAL', 880],
  );
  assert.equal(eventos[0].acao, 'cadastro.planejar');
});

test('planejar: login existente (ativo ou inativo) não gera ficha', async () => {
  const ativo = await montar({ nome: 'X', supervisor: GABRIEL }).servico.planejar('RICARDO.MENDES@1');
  assert.equal(ativo.status, StatusPlano.JA_EXISTE);
  assert.equal(ativo.ficha, undefined);

  const inativo = await montar({ nome: 'X', supervisor: GABRIEL }).servico.planejar('bruno.desligado@1');
  assert.equal(inativo.status, StatusPlano.JA_EXISTE);
  assert.match(inativo.motivo, /INATIVO.*Reative/);
});

test('planejar: bloqueia perfil não-operador, inativo e funcionário não encontrado', async () => {
  assert.equal((await montar({ nome: 'X', perfil: 'Supervisor' }).servico.planejar('A.B@1')).status, StatusPlano.BLOQUEADO);
  assert.equal((await montar({ nome: 'X', status: 'Inativo' }).servico.planejar('A.B@1')).status, StatusPlano.BLOQUEADO);
  assert.equal((await montar({}).servico.planejar('A.B@1')).status, StatusPlano.BLOQUEADO);
  assert.equal((await montar({ nome: 'X' }).servico.planejar('inválido!')).status, StatusPlano.BLOQUEADO);
});

test('planejar: supervisor desconhecido vira pendência; homônimo vira aviso', async () => {
  const p = await montar({ nome: 'Juliana Alves', supervisor: 'FULANO' }).servico.planejar('JULIANA.A2@1');
  assert.equal(p.status, StatusPlano.PENDENTE);
  assert.match(p.pendencias[0], /FULANO/);
  assert.match(p.avisos[0], /JULIANA\.ALVES/);
});

test('conferir: cadastro correto → OK; não existe → NAO_ENCONTRADO', async () => {
  assert.equal((await montar({ supervisor: GABRIEL }).servico.conferir('RICARDO.MENDES@1')).status, StatusConferencia.OK);
  assert.equal((await montar({ supervisor: GABRIEL }).servico.conferir('NOVO.LOGIN@1')).status, StatusConferencia.NAO_ENCONTRADO);
});

test('conferir: sem supervisor esperado → INCONCLUSIVO', async () => {
  assert.equal((await montar({}).servico.conferir('RICARDO.MENDES@1')).status, StatusConferencia.INCONCLUSIVO);
});

test('conferir --corrigir: transfere para o grupo do supervisor', async () => {
  // Fernando (1006) está no grupo da Maysa; suponha que o Vanguard diga que é do Gabriel
  // e que o supervisor já foi corrigido na Argus — só o grupo está errado.
  const ctx = montar({ supervisor: GABRIEL });
  const fernando = ctx.client.dados.usuarios.find((u) => u.ramal === '1006');
  Object.assign(fernando.campanhas[0], { idUsuarioSupervisor: 491, nomeUsuarioSupervisor: GABRIEL });

  const semCorrigir = await ctx.servico.conferir('FERNANDO.RIBEIRO@1');
  assert.equal(semCorrigir.status, StatusConferencia.DIVERGENTE);
  assert.equal(grupoAtual(ctx.client, '1006'), 3);

  const corrigido = await ctx.servico.conferir('FERNANDO.RIBEIRO@1', { corrigir: true });
  assert.equal(corrigido.status, StatusConferencia.CORRIGIDO);
  assert.equal(grupoAtual(ctx.client, '1006'), 1);
});

test('conferir: nunca tira da URA quem está lá (rodízio)', async () => {
  const ctx = montar({ supervisor: MAYSA });
  const r = await ctx.servico.conferir('MARIANA.COSTA@1', { corrigir: true }); // 1003 está na URA
  assert.equal(r.status, StatusConferencia.OK);
  assert.equal(grupoAtual(ctx.client, '1003'), 2);
  assert.match(r.acoes[0], /URA/);
});

test('conferir: supervisor divergente vira pendência manual', async () => {
  const r = await montar({ supervisor: GABRIEL }).servico.conferir('JULIANA.ALVES@1', { corrigir: true });
  assert.equal(r.status, StatusConferencia.DIVERGENTE);
  assert.match(r.divergencias.find((d) => d.campo === 'supervisor').atual, /MAYSA/);
  assert.ok(r.pendencias.some((p) => /não altera supervisor/.test(p)));
});

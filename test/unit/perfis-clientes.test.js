'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizarTelefone, mascarar, chaveDoCliente, classificarLigacao, Resultado, motivosDeRisco,
} = require('../../src/domain/perfis-clientes');
const { PerfisClientes } = require('../../src/rodizio/perfis-clientes');
const { VigiaRisco } = require('../../src/rodizio/vigia-risco');
const { contar } = require('../../scripts/perfis-montar');
const { loggerNulo } = require('../../src/utils/logger');

const FUSO = 'America/Sao_Paulo';
const AGORA = new Date('2026-10-20T13:00:00Z').getTime(); // 10:00 em Brasília
const pasta = () => fs.mkdtempSync(path.join(os.tmpdir(), 'perfis-'));
const ligacao = (id, resultado, { tel = '11980821594', dia = '2026-10-20', hora = '09:46:13' } = {}) => ({
  idLigacao: id, dddTelefone: tel, dataHoraLigacao: `${dia}T${hora}`, resultadoLigacao: resultado, nomeCliente: 'CLIENTE TESTE', cpfCnpj: '00000000000',
});
function criar(dir = pasta(), cfg = {}) {
  return new PerfisClientes({
    cfg: {
      arquivo: path.join(dir, 'vivo.json'), arquivoHistorico: path.join(dir, 'historico.json'), arquivoSegredo: path.join(dir, 'segredo.key'),
      dias: 30, minCallbacks: 1, minAtendeu: 3, fuso: FUSO, ...cfg,
    },
    logger: loggerNulo,
  }).carregar();
}

test('perfis: telefone normalizado e mascarado; a chave não contém o número', () => {
  assert.equal(normalizarTelefone('+55 (11) 98082-1594'), '11980821594');
  assert.equal(normalizarTelefone('011980821594'), '11980821594');
  assert.equal(normalizarTelefone('1234'), null);
  assert.equal(mascarar('11980821594'), '(11) 9****-1594');
  assert.equal(mascarar('1133334444'), '(11) ****-4444');
  const chave = chaveDoCliente('11980821594', 'segredo');
  assert.ok(!chave.includes('980821594'));
  assert.notEqual(chave, chaveDoCliente('11980821594', 'outro segredo'), 'sem o segredo não dá para refazer a chave');
});

test('perfis: como cada resultado conta', () => {
  assert.equal(classificarLigacao({ resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA' }), Resultado.CALLBACK);
  assert.equal(classificarLigacao({ resultadoLigacao: 'ATENDIMENTO' }), Resultado.ATENDEU);
  assert.equal(classificarLigacao({ resultadoLigacao: 'OPER. VIRTUAL - ABANDONO' }), Resultado.ATENDEU);
  assert.equal(classificarLigacao({ resultadoLigacao: 'LIGAÇÃO EM CURSO' }), Resultado.EM_CURSO);
  assert.equal(classificarLigacao({ resultadoLigacao: 'AMD - CAIXA POSTAL / MSG' }), Resultado.NAO_ATENDEU);
  assert.equal(classificarLigacao({ resultadoLigacao: 'SEM AGENTE' }), Resultado.NAO_ATENDEU);
  assert.deepEqual(motivosDeRisco({ atendeu: 3, callbacks: 1 }, { minCallbacks: 1, minAtendeu: 3 }), ['1 callback(s)', 'atendeu 3 vez(es)']);
  assert.deepEqual(motivosDeRisco({ atendeu: 2, callbacks: 0 }, { minCallbacks: 1, minAtendeu: 3 }), []);
});

test('perfis: soma ao vivo, não repete a mesma ligação, guarda só HMAC e máscara, e retoma depois de reiniciar', async () => {
  const dir = pasta();
  const p = criar(dir);
  assert.equal(p.registrarLigacao(ligacao(1, 'OPER. VIRTUAL - ABANDONO EM FILA'), AGORA), true);
  assert.equal(p.registrarLigacao(ligacao(1, 'OPER. VIRTUAL - ABANDONO EM FILA'), AGORA), false, 'mesma ligação');
  assert.equal(p.registrarLigacao(ligacao(2, 'NÃO ATENDE'), AGORA), false);
  p.registrarLigacao(ligacao(3, 'ATENDIMENTO'), AGORA);
  assert.deepEqual(p.consultar('(11) 98082-1594', AGORA), {
    mascara: '(11) 9****-1594', atendeu: 2, callbacks: 1, ultimoDia: '2026-10-20', motivos: ['1 callback(s)'],
  });
  assert.deepEqual(p.consultar('11 99999-0000', AGORA).motivos, [], 'cliente sem perfil');
  await p.salvar(AGORA);

  const gravado = fs.readFileSync(path.join(dir, 'vivo.json'), 'utf8');
  assert.ok(!/98082|CLIENTE TESTE|00000000000/.test(gravado), 'nada do cliente no arquivo além da máscara');
  assert.equal(criar(dir).consultar('11980821594', AGORA).atendeu, 2, 'retoma depois de reiniciar');
});

test('perfis: histórico (perfis:montar) soma com o ao vivo sem contar o mesmo dia duas vezes; janela de 30 dias', () => {
  const dir = pasta();
  const segredo = 'segredo-fixo';
  const perfis = {};
  const r = contar(perfis, [
    ligacao(10, 'ATENDIMENTO', { dia: '2026-10-19' }),
    ligacao(11, 'OPER. VIRTUAL - ABANDONO', { dia: '2026-10-18' }),
    ligacao(12, 'ATENDIMENTO', { dia: '2026-10-20' }), // hoje: fica com o ao vivo
    ligacao(13, 'ATENDIMENTO', { dia: '2026-09-01' }),
  ], { segredo, ate: '2026-10-20', fuso: FUSO, agora: AGORA });
  assert.deepEqual(r, { lidas: 4, contadas: 3 });
  fs.writeFileSync(path.join(dir, 'historico.json'), JSON.stringify({ ate: '2026-10-20', perfis }));

  const p = criar(dir, { segredo });
  p.registrarLigacao(ligacao(14, 'ATENDIMENTO', { dia: '2026-10-19' }), AGORA); // já no histórico: não conta
  p.registrarLigacao(ligacao(15, 'ATENDIMENTO'), AGORA);
  const c = p.consultar('11980821594', AGORA);
  assert.equal(c.atendeu, 3, '2 do histórico (01/09 fora da janela) + 1 de hoje');
  assert.deepEqual(c.motivos, ['atendeu 3 vez(es)']);
  assert.equal(p.maisArriscados(5, AGORA).length, 1);
});

test('vigia de risco: "LIGAÇÃO EM CURSO" de cliente de risco vira alerta uma vez; com o interruptor, desliga os robôs', async () => {
  const p = criar();
  p.registrarLigacao(ligacao(1, 'OPER. VIRTUAL - ABANDONO EM FILA', { dia: '2026-10-19' }), AGORA);
  const desligamentos = [];
  const avisos = [];
  let ligado = false;
  const vigia = new VigiaRisco({
    client: {
      listarCampanhas: async () => [{ idCampanha: 1 }],
      ligacoesDetalhadas: async () => [
        { ...ligacao(50, 'LIGAÇÃO EM CURSO'), usuarioOperador: 'Oper Virtual 7' },
        { ...ligacao(51, 'LIGAÇÃO EM CURSO', { tel: '21999990000' }), usuarioOperador: 'Oper Virtual 8' },
      ],
    },
    rodizio: { teveRoboLigado: () => true, desligarPorClienteDeRisco: async (m) => desligamentos.push(m) },
    perfis: p,
    desligaRobos: { ligado: () => ligado },
    cfg: { gruposRobosIds: [6], fuso: FUSO },
    logger: { ...loggerNulo, aviso: (m) => avisos.push(m) },
  });
  await vigia.verificar(AGORA);
  const [alerta] = vigia.listar();
  assert.equal(vigia.listar().length, 1, 'só o cliente de risco');
  assert.equal(alerta.mascara, '(11) 9****-1594');
  assert.equal(alerta.robo, 'Oper Virtual 7');
  assert.match(avisos[0], /^CLIENTE DE RISCO em ligação: Oper Virtual 7 com \(11\) 9\*\*\*\*-1594 \(1 callback/);
  assert.equal(desligamentos.length, 0, 'interruptor desligado: só avisa');
  assert.ok(!JSON.stringify(vigia.listar()).includes('98082'));

  await vigia.verificar(AGORA + 10_000);
  assert.equal(avisos.length, 1, 'a mesma ligação não alerta de novo');

  ligado = true;
  vigia.alertas.clear();
  await vigia.verificar(AGORA + 20_000);
  assert.equal(desligamentos.length, 1);
  assert.match(desligamentos[0], /cliente de risco em ligação: \(11\) 9\*\*\*\*-1594/);
  assert.equal(vigia.listar().length, 1);
});

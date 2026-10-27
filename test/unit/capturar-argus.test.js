'use strict';
/** [NOVO] npm run capturar:argus: só leitura, tudo sanitizado, e não grava se sobrar dado pessoal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capturar, gravar } = require('../../scripts/capturar-argus');
const { dadosPessoais } = require('../../src/domain/sanitizar-argus');

function clienteFalso() {
  const chamadas = [];
  const client = {
    async listarGrupos() { chamadas.push('listargrupos'); return [{ idGrupoUsuario: 2, descricao: 'URA', ramaisOperadores: ['2266423', '2266500'] }, { idGrupoUsuario: 9, descricao: 'ROBOS', ramaisOperadores: ['3001'] }]; },
    async listarPausas(ramal) { chamadas.push(`listarpausas ${ramal}`); return [{ idPausa: 1, pausaDesc: 'Banheiro' }]; },
    async statusOperador(ramal) { chamadas.push(`statusoperador ${ramal}`); return { ramal, nome: 'Maria Aparecida Souza', descricaoStatus: 'Livre', tempoStatus: 9000, idGrupo: 2 }; },
    async listarCampanhas() { return [{ idCampanha: 3, campanhaDesc: 'C', ativo: true }]; },
    async ligacoesDetalhadas(filtro) {
      chamadas.push(`ligacoesdetalhadas ${filtro.idGrupoUsuario}`);
      return [{ idLigacao: '20261027100312000045', usuarioOperador: 'Maria Aparecida Souza', dddTelefone: '11987654321', nomeCliente: 'José', resultadoLigacao: 'ATENDIMENTO', dataHoraLigacao: '2026-10-27T10:03:12' }];
    },
  };
  return { client, chamadas };
}

test('capturar: só comandos de leitura, e o resultado já sai sem dado pessoal', async () => {
  const { client, chamadas } = clienteFalso();
  const capturas = await capturar({ client, grupoUraId: 2, gruposRobos: [9], ramais: 2, campanha: 3 });
  assert.ok(chamadas.every((c) => /^(listargrupos|listarpausas|statusoperador|ligacoesdetalhadas)/.test(c)), chamadas.join(', '));
  assert.deepEqual(capturas.map((c) => c.arquivo), ['listargrupos', 'listarpausas', 'statusoperador', 'ligacoesdetalhadas-robos', 'ligacoesdetalhadas-ura']);
  for (const c of capturas) assert.deepEqual(dadosPessoais(c.resposta), [], c.arquivo);
  const json = JSON.stringify(capturas);
  for (const pessoal of ['Maria', 'José', '11987654321', '2266423']) assert.ok(!json.includes(pessoal), pessoal);
  const status = capturas.find((c) => c.arquivo === 'statusoperador').resposta[0];
  const grupos = capturas.find((c) => c.arquivo === 'listargrupos').resposta;
  assert.equal(status.ramal, grupos[0].ramaisOperadores[0], 'o mesmo ramal tem o mesmo apelido em todos os arquivos');
});

test('gravar: escreve com origem "argus"; recusa tudo se sobrar dado pessoal', () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'fixtures-'));
  const [arquivo] = gravar([{ arquivo: 'listarpausas', comando: 'listarpausas', resposta: [{ idPausa: 1, pausaDesc: 'Banheiro' }] }], { pasta });
  assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).origem, 'argus');
  assert.throws(() => gravar([{ arquivo: 'x', comando: 'x', resposta: [{ obs: 'ligar 11987654321' }] }], { pasta }), /Nada gravado/);
  assert.ok(!fs.existsSync(path.join(pasta, 'x.json')));
});

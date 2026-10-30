#!/usr/bin/env node
'use strict';
/**
 * Cenários de caracterização do rodízio Ativo ↔ URA e do controle de robôs.
 *
 * Cada cenário sobe uma Argus falsa, inicia o rodízio como processo separado
 * (exatamente como em produção), altera status de operadores e confere os
 * comandos que chegam à Argus.
 *
 *   node test/rodizio/cenarios.js                  roda contra argus-automacao.js deste repositório
 *   node test/rodizio/cenarios.js caminho/antigo.js  roda contra outra versão (ex.: a anterior à refatoração)
 *
 * A mesma suíte foi rodada contra a versão antiga e a nova para garantir que
 * a refatoração preservou o comportamento.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { criarArgusFake } = require('./argus-fake');
const { dataLocal } = require('../../src/utils/datas');

const RAIZ = path.join(__dirname, '..', '..');
const ALVO = path.resolve(process.argv[2] || path.join(RAIZ, 'argus-automacao.js'));
const TOKEN = 'tk';

const GRUPOS_BASE = [
  { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100', '101'] }, // Ativo
  { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200'] }, // URA
  { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901'] }, // Robôs
];
const STATUS_BASE = { 100: 'livre', 101: 'livre', 200: 'livre', 900: 'livre', 901: 'livre' };

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function aguardar(condicao, { timeoutMs = 8000, descricao = 'condição' } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (await condicao()) return;
    await esperar(100);
  }
  throw new Error(`Tempo esgotado esperando: ${descricao}`);
}

function portaLivre() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** O script antigo grava a trava ao lado de si mesmo: roda uma cópia numa pasta temporária. */
function prepararAlvo(pasta) {
  const ehDesteRepositorio = path.dirname(ALVO) === RAIZ;
  if (ehDesteRepositorio) return ALVO;
  const copia = path.join(pasta, 'alvo.js');
  fs.copyFileSync(ALVO, copia);
  return copia;
}

async function iniciarRodizio({ grupos = GRUPOS_BASE, status = STATUS_BASE, usuarios, env = {}, preparar, atrasoTrocaMs } = {}) {
  const argus = await criarArgusFake({ grupos, status, usuarios, atrasoTrocaMs });
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'rodizio-'));
  preparar?.({ argus, pasta });
  const porta = await portaLivre();
  const saida = [];

  const filho = spawn(process.execPath, [prepararAlvo(pasta)], {
    cwd: pasta,
    env: {
      PATH: process.env.PATH,
      BENURA_SEM_DOTENV: '1',
      ARGUS_TOKEN: 't',
      ARGUS_BASE: argus.url,
      GRUPO_URA_ID: '2',
      GRUPO_ROBOS_URA_ID: '3',
      GRUPOS_ATIVOS_IDS: '1',
      TEMPO_MIN: '0.1', // 6 s
      URA_CHEIA_TEMPO_MIN: '0.1', // [NOVO] na URA cheia, o mesmo nos cenários
      PRIORIDADE_RAMAL_PASSO_S: '0', // [NOVO] sem a escada do ramal (os cenários contam o tempo exato)
      ALINHAR_LOGIN_APOS_TRANSFERIR: 'true', // os cenários de relogin testam o realinhar (o padrão)
      // Peso do status da URA nos robôs por livre: neutro aqui (os cenários contam robôs exatos).
      ROBOS_FATOR_CALMA: '1',
      ROBOS_FATOR_AGRESSIVA: '1',
      POLL_ATIVO_MS: '300',
      POLL_URA_MS: '300',
      REFRESH_GRUPOS_MS: '1000',
      MIN_ROBOS_OFF_MS: '500',
      ROBOS_REDUZIR_APOS_MS: '500',
      ROBOS_SUBIDA_INTERVALO_MS: '500',
      ALINHAR_LOGIN_ESPERA_MS: '100',
      ALINHAR_LOGIN_APOS_MS: '1000',
      PREPARAR_SAIDA_ULTIMO_LIVRE_MS: '0', // cada cenário de último livre liga o seu
      RODIZIO_SO_ELEGIVEIS: '0', // os cenários de elegíveis ligam o filtro
      CARENCIA_TROCA_GRUPO_MS: '0', // os cenários de carência ligam a sua
      OFFLINE_VOLTA_APOS_MS: '0',
      ROBOS_PASSIVA_APOS_MIN: '60', // os cenários de URA passiva ligam a sua
      ROBOS_MAX_COM_1_LIVRE: '0', // o cenário de 1 livre liga o seu
      ROBOS_CALCULO: 'fixo', // [NOVO] contagens exatas; o cenário da taxa liga a sua
      URA_CALMA_LIMITAR_LIVRES: '0', // [NOVO] o cenário da calma liga a sua
      CALLBACKS_VERIFICAR_SEG: '0', // o cenário do vigia de callbacks liga o seu
      ROBOS_MODO: 'automatico', // os cenários do modo pânico ligam o seu
      PERFIS_VIGIA_SEG: '0', // o cenário de cliente de risco liga o seu
      PERFIS_FILE: path.join(pasta, 'state-perfis-clientes.json'),
      PERFIS_HISTORICO_FILE: path.join(pasta, 'state-perfis-historico.json'),
      PERFIS_SEGREDO_FILE: path.join(pasta, 'perfis-segredo.key'),
      RODIZIO_RISCO_FILE: path.join(pasta, 'state-risco.json'),
      WEBHOOK_GRACE_MS: '1500',
      WEBHOOK_TOKEN: TOKEN,
      PORT: String(porta),
      RODIZIO_PORT: String(porta),
      STATE_FILE: path.join(pasta, 'state-vendas.json'),
      LOGS_DIR: path.join(pasta, 'logs'),
      RODIZIO_STATE_FILE: path.join(pasta, 'state.json'),
      RODIZIO_LOCK_FILE: path.join(pasta, 'argus.lock'),
      RODIZIO_URA_CHEIA_FILE: path.join(pasta, 'state-ura-cheia.json'),
      RODIZIO_AJUSTE_FILE: path.join(pasta, 'state-ajuste-robos.json'),
      RODIZIO_PANICO_FILE: path.join(pasta, 'state-panico.json'),
      RODIZIO_STATUS_URA_FILE: path.join(pasta, 'state-status-ura.json'),
      RETENCAO_ATIVO_FILE: path.join(pasta, 'state-retencao-ativo.json'),
      TRAVAS_MANUAIS_FILE: path.join(pasta, 'state-travas-manuais.json'),
      ROBOS_MODO_FILE: path.join(pasta, 'state-robos-modo.json'),
      RODIZIO_ESTATISTICAS_FILE: path.join(pasta, 'state-estatisticas-dia.json'),
      AUTOMACAO_FILE: path.join(pasta, 'state-automacao.json'),
      SIMULACAO_FILE: path.join(pasta, 'state-simulacao.json'),
      AUTOMACAO_VERIFICAR_MS: '200',
      ARGUS_PAUSA_FILE: path.join(pasta, 'argus-pausa.json'),
      RETORNO_STATE_FILE: path.join(pasta, 'state-retorno-fila.json'),
      RETORNO_LOG_FILE: path.join(pasta, 'logs', 'retorno-fila.jsonl'),
      ...env,
    },
  });
  filho.stdout.on('data', (d) => saida.push(String(d)));
  filho.stderr.on('data', (d) => saida.push(String(d)));

  let saiu = null;
  filho.once('exit', (codigo) => { saiu = codigo; });

  const base = `http://127.0.0.1:${porta}`;
  const encerrarTudo = async () => {
    filho.kill('SIGTERM');
    await new Promise((r) => { if (saiu !== null) r(); filho.once('exit', r); setTimeout(r, 3000); });
    await argus.fechar();
    fs.rmSync(pasta, { recursive: true, force: true });
  };
  try {
    await aguardar(() => saiu !== null || saida.join('').match(/ouvindo|HTTP na porta|Rodízio iniciado/i), { descricao: 'rodízio iniciar' });
    if (saiu !== null) throw new Error(`o processo encerrou ao iniciar (código ${saiu}): ${saida.join('').trim().split('\n').pop()}`);
  } catch (e) {
    await encerrarTudo();
    throw e;
  }
  await esperar(800); // primeiro ciclo de grupos/status

  const chamadas = (comando) => argus.estado.chamadas.filter((c) => c.comando === comando);
  const transferencias = () => chamadas('transferiroperadorgrupo')
    .map((c) => `${c.dados.ramaisOperadores.join(',')}→${c.dados.idGrupoUsuarioDestino}`);

  return {
    argus,
    base,
    pasta,
    saida,
    chamadas,
    transferencias,
    webhook: (corpo, { token = TOKEN } = {}) => fetch(`${base}/webhook${token ? `?token=${token}` : ''}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    }),
    encerrar: encerrarTudo,
  };
}

// ───────────────────────────── Cenários ─────────────────────────────

const CENARIOS = {
  async 'Ativo: atendeu e ficou livre → vai para a URA; quem não atendeu fica'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    if (r.transferencias().some((t) => t.startsWith('100→'))) throw new Error('100 não atendeu e foi movido');
  },

  async 'Ativo: só elegível sobe; quem vende hoje passa a subir'(r) {
    // 101 bateu a meta ontem (fila URA no roteador); 100 não.
    for (const ramal of ['100', '101']) r.argus.definirStatus(ramal, 'em atendimento');
    await esperar(1000);
    for (const ramal of ['100', '101']) r.argus.definirStatus(ramal, 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101 (elegível) → URA' });
    await esperar(1500);
    if (r.transferencias().some((t) => t.startsWith('100→'))) throw new Error('100 não é elegível e foi para a URA');
    const { elegiveisUra } = await (await fetch(`${r.base}/health`)).json();
    if (!elegiveisUra.disponivel || elegiveisUra.total !== 1) throw new Error(`/health elegiveisUra: ${JSON.stringify(elegiveisUra)}`);

    // O roteador promove o 100 (vendeu hoje): no próximo atendimento no Ativo, ele sobe.
    escreverVendas(r.pasta, { 100: 'URA', 101: 'URA' });
    await aguardar(() => r.saida.join('').includes('novos: 100'), { descricao: 'rodízio ver o 100 elegível' });
    r.argus.definirStatus('100', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('100', 'livre');
    await aguardar(() => r.transferencias().includes('100→2'), { descricao: '100 (vendeu hoje) → URA' });
  },

  async 'Ativo: sem a lista do dia do roteador, só os fixos sobem (e avisa)'(r) {
    for (const ramal of ['100', '101']) r.argus.definirStatus(ramal, 'em atendimento');
    await esperar(1000);
    for (const ramal of ['100', '101']) r.argus.definirStatus(ramal, 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101 (fixo) → URA' });
    await esperar(1500);
    if (r.transferencias().some((t) => t.startsWith('100→'))) throw new Error('100 não é fixo e subiu sem a lista do dia');
    if (!r.saida.join('').includes('Sem a lista de elegíveis do dia')) throw new Error('não avisou que está sem a lista');
  },

  async 'URA calma: sobem os 4 mais antigos livres do Ativo; quem volta pelo ocioso dá a vez ao próximo'(r) {
    const subiu = (ramal) => r.transferencias().includes(`${ramal}→2`);
    const voltou = (ramal) => r.transferencias().includes(`${ramal}→1`);
    await esperar(1500);
    if (r.transferencias().length) throw new Error(`subiu antes da calma: ${r.transferencias()}`);
    const resp = await fetch(`${r.base}/ura/status`, {
      method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'calma', modo: 'manual', por: 'cenário' }),
    });
    if (resp.status !== 200) throw new Error('não fixou a calma');
    await aguardar(() => ['100', '101', '102', '103'].every(subiu), { descricao: 'calma: sobem 100, 101, 102 e 103 (os mais antigos)' });
    await esperar(1500);
    if (['104', '105', '106', '107'].some(subiu)) throw new Error(`subiu mais que 4: ${r.transferencias()}`);
    const { calmaLivres } = await (await fetch(`${r.base}/health`)).json();
    if (!calmaLivres?.ativa || calmaLivres.min !== 4 || calmaLivres.max !== 6) throw new Error(`/health: ${JSON.stringify(calmaLivres)}`);

    // Ocioso há TEMPO_MIN (6 s): voltam ao Ativo e sobem os próximos da fila (104…), não eles de novo.
    await aguardar(() => voltou('100'), { timeoutMs: 15_000, descricao: '100 ocioso → Ativo' });
    await aguardar(() => subiu('104'), { timeoutMs: 8000, descricao: 'sobe o próximo da fila (104)' });
    const idas100 = r.transferencias().filter((t) => t === '100→2').length;
    if (idas100 !== 1) throw new Error('quem voltou pelo ocioso subiu de novo sem atender no Ativo');
  },

  async 'URA cheia: ninguém sobe só por estar no Ativo; quem atender sobe mesmo sem ser elegível; a regra do ocioso vale'(r) {
    const uraCheia = (method) => fetch(`${r.base}/ura/cheia`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
    const vezes = (t) => r.transferencias().filter((x) => x === t).length;
    if (!(await (await fetch(`${r.base}/ura`)).text()).includes('Ligar a URA cheia')) throw new Error('GET /ura sem a página');
    if ((await fetch(`${r.base}/ura/cheia`, { method: 'POST' })).status !== 401) throw new Error('ligou sem token');
    if (!(await uraCheia('POST')).ok) throw new Error('não ligou');
    // 100 e 101 estão livres no Ativo e não atenderam nada: ninguém sobe só por estar no Ativo.
    await esperar(3000);
    if (vezes('100→2') || vezes('101→2')) throw new Error('subiu quem não atendeu no Ativo');
    const { uraCheia: estado } = await (await fetch(`${r.base}/health`)).json();
    if (!estado.ligada) throw new Error('/health não mostra a URA cheia ligada');

    // O 100 (que nem é elegível) atende no Ativo: sobe.
    r.argus.definirStatus('100', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('100', 'livre');
    await aguardar(() => vezes('100→2') === 1, { descricao: '100 atendeu no Ativo → URA' });

    // Ocioso há TEMPO_MIN (6 s): volta ao Ativo e não sobe de novo sem atender (sem vai e volta).
    await aguardar(() => vezes('100→1') === 1, { timeoutMs: 15_000, descricao: 'ocioso → Ativo' });
    await esperar(3000);
    if (vezes('100→2') !== 1) throw new Error('levou de novo quem voltou por ocioso (vai e volta)');
    if (!(await uraCheia('DELETE')).ok) throw new Error('não desligou');
  },

  async 'Alocar todos no Ativo: ninguém sobe até retomar; ao retomar, quem é elegível vai para a URA na hora'(r) {
    const pedir = (caminho) => fetch(`${r.base}${caminho}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{"por":"cenário"}' });
    const alocar = await (await pedir('/operadores/transferir-ura-ativo')).json();
    if (!Array.isArray(alocar.movidos)) throw new Error(`alocar: ${JSON.stringify(alocar)}`);
    const retencao = JSON.parse(fs.readFileSync(path.join(r.pasta, 'state-retencao-ativo.json'), 'utf8'));
    if (retencao.ativa !== true) throw new Error('a retenção não foi gravada (o roteador lê esse arquivo)');

    // 101 é elegível, atende no Ativo e fica livre: normalmente subiria.
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await esperar(3000);
    if (r.transferencias().includes('101→2')) throw new Error('subiu para a URA com o rodízio pausado');
    if ((await pedir('/ura/cheia')).status !== 409) throw new Error('ligou a URA cheia com o rodízio pausado');
    const { retencaoAtivo } = await (await fetch(`${r.base}/health`)).json();
    if (!retencaoAtivo.ativa || retencaoAtivo.elegiveisParaVoltar !== 1) throw new Error(`/health: ${JSON.stringify(retencaoAtivo)}`);

    const retomar = await (await pedir('/operadores/retomar-rodizio')).json();
    if (JSON.stringify(retomar.movidos) !== '["101"]') throw new Error(`retomar: ${JSON.stringify(retomar)}`);
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101 (elegível) → URA ao retomar' });
    if (r.transferencias().some((t) => t.startsWith('100→2'))) throw new Error('100 não é elegível e foi para a URA');
  },

  async 'Painel do receptivo: pausar e sair da pausa pela API; trazer para a URA trava e o ocioso não devolve'(r) {
    const pedir = async (caminho, corpo) => {
      const resp = await fetch(`${r.base}${caminho}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ por: 'cenário', ...corpo }) });
      return { status: resp.status, corpo: await resp.json() };
    };
    const pausas = await pedir('/operadores/pausas', { ramal: '200' });
    if (pausas.corpo.pausas?.length !== 2) throw new Error(`pausas: ${JSON.stringify(pausas)}`);
    if ((await pedir('/operadores/pausar', { ramal: '200', idPausa: 3 })).status !== 200) throw new Error('pausar falhou');
    const emPausa = async () => (await (await fetch(`${r.base}/health`)).json()).uraAgora.find((u) => u.ramal === '200');
    if ((await emPausa()).pausa !== 'BANHEIRO') throw new Error(`a pausa não apareceu na hora: ${JSON.stringify(await emPausa())}`);
    await pedir('/operadores/sair-pausa', { ramal: '200' });
    await aguardar(async () => (await emPausa()).classe === 'livre', { descricao: '200 livre depois de sair da pausa' });
    if ((await pedir('/operadores/pausar', { ramal: '900', idPausa: 1 })).status !== 400) throw new Error('pausou um robô');

    // Trazer 100 (Ativo) para a URA à mão: fica travado e o ocioso (TEMPO_MIN = 6 s) não devolve.
    const mover = await pedir('/operadores/mover', { ramal: '100', para: 'ura' });
    if (mover.status !== 200) throw new Error(`mover: ${JSON.stringify(mover)}`);
    await aguardar(() => r.transferencias().includes('100→2'), { descricao: '100 → URA à mão' });
    const travas = JSON.parse(fs.readFileSync(path.join(r.pasta, 'state-travas-manuais.json'), 'utf8'));
    if (travas.ramais?.['100']?.onde !== 'ura') throw new Error(`trava não gravada: ${JSON.stringify(travas)}`);
    await esperar(8000);
    if (r.transferencias().includes('100→1')) throw new Error('travado na URA e voltou ao Ativo por ocioso');
    await pedir('/operadores/liberar', { ramal: '100' });
    await aguardar(() => r.transferencias().includes('100→1'), { descricao: 'liberado: o ocioso devolve ao Ativo' });
  },

  async 'URA cheia em DRY_RUN: simula a ida de quem atendeu uma vez só'(r) {
    await fetch(`${r.base}/ura/cheia`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.saida.join('').includes('[DRY_RUN] Transferiria ramal 101'), { descricao: 'simular 101 → URA' });
    await esperar(2000);
    const simulacoes = r.saida.join('').split('[DRY_RUN] Transferiria ramal 101').length - 1;
    if (simulacoes !== 1) throw new Error(`simulou a ida de 101 ${simulacoes} vezes`);
    if (r.transferencias().length) throw new Error('transferiu de verdade em DRY_RUN');
  },

  async 'DRY_RUN: movido simulado não conta como livre na URA (alvo de robôs não infla)'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.saida.join('').includes('[DRY_RUN] Transferiria ramal 101'), { descricao: 'simular 101→URA' });
    await esperar(1500);
    const { robos, ramaisUra } = await (await fetch(`${r.base}/health`)).json();
    if (ramaisUra.includes('101')) throw new Error('101 entrou na URA sem ter sido movido');
    if (robos.alvo !== 1) throw new Error(`alvo ${robos.alvo}; com 1 livre real na URA deveria ser 1`);
    const simulacoes = r.saida.join('').split('[DRY_RUN] Transferiria ramal 101').length - 1;
    if (simulacoes !== 1) throw new Error(`simulou a ida de 101 ${simulacoes} vezes`);
  },

  async 'URA: volta ao grupo de origem só depois de TEMPO_MIN ocioso'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    const entrou = Date.now();
    await aguardar(() => r.transferencias().includes('101→1'), { timeoutMs: 12_000, descricao: '101→Ativo' });
    const segundos = (Date.now() - entrou) / 1000;
    if (segundos < 4.5) throw new Error(`voltou cedo demais (${segundos.toFixed(1)}s; TEMPO_MIN = 6s)`);
  },

  async 'URA: quem já estava na URA (não movido) e fica ocioso volta ao grupo do supervisor'(r) {
    // 201 já estava no RECEPTIVO - URA quando o rodízio iniciou; o supervisor dele tem o grupo 1 no Ativo.
    await aguardar(() => r.transferencias().includes('201→1'), { timeoutMs: 12_000, descricao: '201 ocioso → grupo 1' });
    if (r.transferencias().some((t) => t.startsWith('200→'))) throw new Error('200 está em atendimento e não podia sair');
  },

  async 'URA: fixo (posto na URA pelo roteador) ocioso vai ao Ativo e volta à URA ao atender lá'(r) {
    await aguardar(() => r.transferencias().includes('201→1'), { timeoutMs: 12_000, descricao: '201 ocioso → grupo 1' });
    await aguardar(() => r.argus.estado.grupoLogado['201'] === undefined, { descricao: 'a discadora trocar o 201 para o Ativo' });
    r.argus.definirStatus('201', 'em atendimento');
    await esperar(1000); // ligação curta: o rodízio o vigia no Ativo desde a volta, sem esperar reler os grupos
    r.argus.definirStatus('201', 'livre');
    await aguardar(() => r.transferencias().includes('201→2'), { descricao: '201 atendeu no Ativo → URA' });
  },

  async 'URA: fixo de OPERADORES_FIXOS_URA/EQUIPES_FIXAS_URA fica na URA de vez, mesmo ocioso'(r) {
    await esperar(9000); // TEMPO_MIN é 6 s
    if (r.transferencias().some((t) => t.startsWith('201→'))) throw new Error(`o fixo saiu da URA: ${r.transferencias()}`);
    if (!r.saida.join('').includes('Fixos na URA de vez')) throw new Error('não registrou os fixos permanentes');
    const health = await (await fetch(`${r.base}/health`)).json();
    if (!health.fixosPermanentes.includes('201')) throw new Error(`health: ${JSON.stringify(health.fixosPermanentes)}`);
  },

  async 'URA: último livre sai no horário; antes disso os robôs param de discar e os em ligação terminam'(r) {
    const deslogados = () => r.chamadas('deslogaroperador').map((c) => String(c.dados.ramal));
    // 201 é o único humano. A 3 s de completar o ocioso (6 s), os robôs parados (901, 902) desligam; o 900, em ligação, fica.
    await aguardar(() => deslogados().includes('901') && deslogados().includes('902'), { timeoutMs: 12_000, descricao: 'robôs parados desligam antes' });
    if (deslogados().includes('900')) throw new Error('derrubou o robô em ligação');
    if (r.transferencias().some((t) => t.startsWith('201→'))) throw new Error('o 201 saiu antes do TEMPO_MIN');
    r.argus.definirStatus('900', 'livre'); // a ligação terminou com o 201 ainda na URA
    await aguardar(() => deslogados().includes('900'), { descricao: 'desligar o 900 ao terminar' });
    // A regra do ocioso vale: sai no horário.
    await aguardar(() => r.transferencias().includes('201→1'), { timeoutMs: 12_000, descricao: '201 volta ao Ativo no TEMPO_MIN' });
  },

  async 'URA: último livre sai no TEMPO_MIN mesmo com robô ainda em ligação'(r) {
    await aguardar(() => r.transferencias().includes('201→1'), { timeoutMs: 12_000, descricao: '201 volta ao Ativo no horário' });
    await aguardar(() => r.chamadas('deslogaroperador').some((c) => String(c.dados.ramal) === '900'), { descricao: 'URA sem livre desliga todos' });
  },

  async 'URA: logado em outro grupo → avisa; em ligação não mexe; ao ficar livre, reloga na URA'(r) {
    // 200 foi posto na URA "à mão" já logado: a telefonia diz grupo 1. Está em ligação.
    await aguardar(() => r.saida.join('').includes('Ramal 200 está no grupo da URA, mas a telefonia continua logada'),
      { descricao: 'aviso do grupo logado' });
    const { uraLogadosEmOutroGrupo } = await (await fetch(`${r.base}/health`)).json();
    if (uraLogadosEmOutroGrupo?.[0]?.ramal !== '200' || uraLogadosEmOutroGrupo[0].grupoLogado !== 1) {
      throw new Error(`health sem o 200: ${JSON.stringify(uraLogadosEmOutroGrupo)}`);
    }
    await esperar(1000);
    if (r.chamadas('logaroperador').length) throw new Error('relogou quem estava em ligação');

    r.argus.definirStatus('200', 'livre'); // terminou a ligação
    await aguardar(() => r.chamadas('logaroperador').some((c) => String(c.dados.ramal) === '200'), { descricao: 'relogar o 200' });
    await aguardar(() => r.saida.join('').includes('Ramal 200 agora está logado no grupo da URA'), { descricao: 'aviso de correção' });
    if (r.chamadas('deslogaroperador').some((c) => String(c.dados.ramal) === '200')) throw new Error('deslogou o 200 sem precisar');
  },

  async 'Rodízio: quem vai para a URA só conta como livre (e liga robô) depois que a discadora troca a telefonia'(r) {
    const robosLigados = () => r.chamadas('logaroperadorvirtual').length;
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    await esperar(800); // a discadora ainda não trocou (atraso de 1,5 s): a derivação não chegaria nele
    if (robosLigados()) throw new Error('ligou robô para quem ainda não está logado na URA');
    await aguardar(() => robosLigados() > 0, { descricao: 'ligar robô depois da troca' });
    if (r.chamadas('logaroperador').length) throw new Error('relogou sem precisar: a discadora trocou sozinha');
  },

  async 'Rodízio: quem fica preso no grupo antigo (não troca sozinho) é relogado e só então liga robô'(r) {
    const robosLigados = () => r.chamadas('logaroperadorvirtual').length;
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    await aguardar(() => r.chamadas('logaroperador').some((c) => String(c.dados.ramal) === '101'),
      { descricao: 'relogar o 101 depois de ALINHAR_LOGIN_APOS_MS' });
    await aguardar(() => robosLigados() > 0, { descricao: 'ligar robô depois de relogar' });
    if (!r.saida.join('').includes('Ramal 101 está no grupo da URA, mas a telefonia continua logada')) {
      throw new Error('não avisou do 101 preso');
    }
  },

  async 'URA: atender zera o tempo ocioso'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    await esperar(4000); // 4 s ocioso (TEMPO_MIN = 6 s)
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(2000);
    r.argus.definirStatus('101', 'livre'); // recomeça a contar daqui
    const recomecou = Date.now();
    await aguardar(() => r.transferencias().includes('101→1'), { timeoutMs: 12_000, descricao: '101→Ativo' });
    const segundos = (Date.now() - recomecou) / 1000;
    if (segundos < 4.5) throw new Error(`voltou ${segundos.toFixed(1)} s depois do atendimento; deveria contar 6 s de novo`);
  },

  async 'URA: movido que pisca offline não volta; offline que continua volta depois de OFFLINE_VOLTA_APOS_MS'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    await aguardar(() => r.argus.estado.grupoLogado['101'] === undefined, { descricao: 'a discadora trocar o 101 para a URA' });
    await esperar(500);
    r.argus.definirStatus('101', null); // pisca "deslogado" (troca de grupo, relogin)
    await esperar(1000);
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(2500);
    if (r.transferencias().includes('101→1')) throw new Error('devolveu ao Ativo por um offline passageiro');

    r.argus.definirStatus('101', null); // agora fica offline
    const desde = Date.now();
    await aguardar(() => r.transferencias().includes('101→1'), { timeoutMs: 6000, descricao: '101 offline → Ativo' });
    if (Date.now() - desde < 1800) throw new Error('voltou antes de OFFLINE_VOLTA_APOS_MS');
  },

  async 'Robôs: quem acabou de trocar a telefonia para a URA só liga robô depois da carência'(r) {
    const robosLigados = () => r.chamadas('logaroperadorvirtual').length;
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA' });
    await aguardar(() => r.saida.join('').includes('Ramal 101: telefonia na URA'), { descricao: 'registrar a troca' });
    const trocou = Date.now();
    await aguardar(() => robosLigados() > 0, { timeoutMs: 8000, descricao: 'ligar robô depois da carência' });
    if (Date.now() - trocou < 2500) throw new Error('ligou robô dentro da carência');
    if (!/livres: 101 \(grupo 2/.test(r.saida.join(''))) throw new Error('a linha do tempo não mostrou como a Argus via o livre');
  },

  async 'Ativo: quem ficou offline perde o histórico de atendimento'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', null);
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await esperar(2000);
    if (r.transferencias().length) throw new Error(`não deveria transferir: ${r.transferencias()}`);
  },

  async 'Robôs: todos os humanos da URA ocupados → desliga; alguém livre → religa'(r) {
    if (r.chamadas('deslogaroperador').length) throw new Error('desligou robôs com humano livre');
    r.argus.definirStatus('200', 'em atendimento');
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
    const deslogados = r.chamadas('deslogaroperador').map((c) => String(c.dados.ramal)).sort();
    if (deslogados.join() !== '900,901') throw new Error(`deslogou ${deslogados}`);

    r.argus.definirStatus('200', 'livre');
    await aguardar(() => r.chamadas('logaroperadorvirtual').length >= 2, { descricao: 'religar robôs' });
    const religados = r.chamadas('logaroperadorvirtual').map((c) => String(c.dados.ramal)).sort();
    if (religados.join() !== '900,901') throw new Error(`religou ${religados}`);
  },

  async 'Robôs proporcionais: 3 por livre, reduz poupando quem está em ligação, aumenta e zera'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]); // desligado = sem status ("Deslogado" na Argus)
    // 1 livre (200) → alvo 3: dos 10 ligados, desliga 7 e poupa o 900, que está em ligação.
    await aguardar(() => ligados().length === 3, { descricao: 'reduzir para 3' });
    if (!ligados().includes('900')) throw new Error('desligou o robô que estava em ligação');

    r.argus.definirStatus('201', 'livre'); // 2 livres → alvo 6
    await aguardar(() => ligados().length === 6, { descricao: 'aumentar para 6' });
    if (r.chamadas('logaroperadorvirtual').some((c) => !c.dados.ramal)) throw new Error('ligou o grupo inteiro');

    r.argus.definirStatus('200', 'em atendimento');
    r.argus.definirStatus('201', 'em atendimento'); // ninguém livre → zera
    await aguardar(() => ligados().length === 0, { descricao: 'desligar todos' });
  },

  async 'Robôs: callback baixa um degrau de robôs por livre (sem derrubar ligação) e volta sozinho'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]);
    const ajuste = async () => (await (await fetch(`${r.base}/health`)).json()).ajusteRobos;
    await aguardar(() => ligados().length === 6, { descricao: '2 livres × 3 = 6 robôs' });

    const callback = { idTipoWebhook: 5, idConclusaoDerivacao: 2, telefone: '11999990000', dataInicioUra: '2026-10-15T09:03:00' };
    await r.webhook(callback);
    await aguardar(() => ligados().length === 4, { descricao: '2 livres × 2 = 4 robôs' });
    if (!ligados().includes('900')) throw new Error('desligou o robô que estava em ligação');
    if (!r.saida.join('').includes('robôs por livre 3→2')) throw new Error('não registrou a queda no log');
    await r.webhook(callback); // reenvio da Argus
    const depois = await ajuste();
    if (depois.porLivre !== 2 || depois.callbacks !== 1) throw new Error(`ajuste ${JSON.stringify(depois)}`);

    // Sem callback por ROBOS_RECUPERAR_APOS_MIN (~5 s), volta ao valor do .env.
    await aguardar(() => ligados().length === 6, { timeoutMs: 12_000, descricao: 'voltar a 6 robôs' });
    if ((await ajuste()).porLivre !== 3) throw new Error('não voltou a 3 por livre');
  },

  async 'Robôs: URA passiva sobe os robôs por livre; a supervisão ajusta na /ura'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]);
    const ajuste = async () => (await (await fetch(`${r.base}/health`)).json()).ajusteRobos;
    await aguardar(() => ligados().length === 4, { descricao: '2 livres × 2 = 4 robôs' });
    // Ninguém da URA atende: depois de ROBOS_PASSIVA_APOS_MIN (~3 s), sobe 2 por livre.
    await aguardar(() => ligados().length === 8, { timeoutMs: 10_000, descricao: 'URA passiva: 4 → 8 robôs' });
    if (!r.saida.join('').includes('URA passiva (')) throw new Error('não registrou a subida no log');
    if ((await ajuste()).porLivre !== 4) throw new Error('ajuste não subiu para 4');

    if (!(await (await fetch(`${r.base}/ura`)).text()).includes('Robôs por livre')) throw new Error('a /ura não mostra os robôs por livre');
    const definir = (valor, token = TOKEN) => fetch(`${r.base}/robos/por-livre`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ valor }),
    });
    if ((await definir(3, '')).status !== 401) throw new Error('ajustou sem token');
    const resposta = await (await definir(3)).json();
    if (resposta.porLivre !== 3) throw new Error(`ajuste manual: ${JSON.stringify(resposta)}`);
    await aguardar(() => ligados().length === 6, { descricao: 'ajuste manual: 2 livres × 3 = 6 robôs' });
  },

  async 'Robôs: com 1 livre só, no máximo ROBOS_MAX_COM_1_LIVRE; a URA passiva não sobe'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]);
    await aguardar(() => ligados().length === 3, { descricao: '1 livre: até 3 robôs (não 5)' });
    // Com ROBOS_PASSIVA_APOS_MIN curto, 1 livre parado não sobe o "por livre".
    await new Promise((ok) => setTimeout(ok, 5000));
    const health = await (await fetch(`${r.base}/health`)).json();
    if (ligados().length !== 3) throw new Error(`robôs ligados: ${ligados().length}`);
    if (health.ajusteRobos.porLivre !== 5) throw new Error(`por livre mudou: ${health.ajusteRobos.porLivre}`);
    if (r.saida.join('').includes('URA passiva (')) throw new Error('subiu por passividade com 1 livre');
    if (health.robos.maxComUmLivre !== 3) throw new Error('o /health não mostra o teto com 1 livre');
  },

  async 'Robôs pela taxa: com 1 livre o teto é o do status da URA (agressiva 6, calma 20)'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]);
    const status = (s) => fetch(`${r.base}/ura/status`, {
      method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: s, modo: 'manual', por: 'cenário' }),
    });
    if ((await status('agressiva')).status !== 200) throw new Error('não fixou a agressiva');
    await aguardar(() => ligados().length === 6, { descricao: 'agressiva com 1 livre: teto 6' });
    if ((await status('calma')).status !== 200) throw new Error('não fixou a calma');
    await aguardar(() => ligados().length === 10, { descricao: 'calma com 1 livre: piso 20 (não o 6 do .env) = os 10 robôs' });
    const { robos } = await (await fetch(`${r.base}/health`)).json();
    if (robos.maxComUmLivre !== 20) throw new Error(`teto com 1 livre: ${robos.maxComUmLivre}`);
    if (robos.calculo?.fonte !== 'medindo' || robos.calculo.status !== 'calma' || robos.calculo.esperaAlvoS !== 45) {
      throw new Error(`calculo: ${JSON.stringify(robos.calculo)}`);
    }
  },

  async 'Vigia de callbacks: callback no relatório da Argus (sem webhook) → raio-x em callbacks.txt e ajuste desce'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x]);
    await aguardar(() => ligados().length === 8, { descricao: '2 livres × 4 = 8 robôs' });
    await aguardar(() => r.chamadas('ligacoesdetalhadas').length > 0, { descricao: 'primeira leitura do relatório' });

    // Hora local (como o relatório traz), 5 s atrás: o raio-x usa as fotos da URA desse intervalo.
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(Date.now() - 5000)).replace(' ', 'T');
    r.argus.estado.ligacoes.push({
      idLigacao: 77, usuarioOperador: 'Oper Virtual 1', dataHoraLigacao: local, resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA',
      tempoSegundos: 4, dddTelefone: '11999990000', nomeCliente: 'CLIENTE TESTE',
    });
    await aguardar(() => ligados().length === 4, { timeoutMs: 8000, descricao: 'callback: 4 → 2 por livre = 4 robôs' });
    const linha = r.saida.join('').split('\n').find((l) => l.includes('CALLBACK '));
    if (!linha || !/INVISÍVEL/.test(linha) || !/robôs 8\/8/.test(linha)) throw new Error(`raio-x: ${linha}`);

    const pastaDoDia = fs.readdirSync(path.join(r.pasta, 'logs')).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const arquivo = (nome) => fs.readFileSync(path.join(r.pasta, 'logs', pastaDoDia, nome), 'utf8');
    await aguardar(() => { try { return arquivo('callbacks.txt').includes('CALLBACK'); } catch { return false; } }, { descricao: 'callbacks.txt' });
    const tudo = arquivo('rodizio.txt');
    if (!/^\d{2}:\d{2}:\d{2} \[INFO\]/m.test(tudo)) throw new Error('rodizio.txt sem a hora local');
    if (!arquivo('avisos.txt').includes('CALLBACK')) throw new Error('avisos.txt sem o callback');
    if (/CLIENTE TESTE|11999990000/.test(tudo + arquivo('callbacks.txt'))) throw new Error('dado de cliente no log');
    if (tudo.includes(TOKEN)) throw new Error('token no log');

    // Lido de novo no próximo ciclo: não conta duas vezes.
    await esperar(1500);
    const ajuste = (await (await fetch(`${r.base}/health`)).json()).ajusteRobos;
    if (ajuste.callbacks !== 1 || ajuste.porLivre !== 2) throw new Error(`ajuste ${JSON.stringify(ajuste)}`);
  },

  async 'Pânico: com 1 livre, desliga os robôs que a supervisão ligou; com 2, não mexe; nunca liga'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x] && r.argus.estado.status[x] !== 'Deslogado');
    await esperar(1500);
    if (ligados().length !== 10) throw new Error(`com 2 livres o BenURA mexeu nos robôs: ${ligados().length}`);
    if (r.chamadas('logaroperadorvirtual').length) throw new Error('o BenURA ligou robô no modo pânico');

    r.argus.definirStatus('201', 'em atendimento');
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: '1 livre: robôs desligados' });
    if (!r.saida.join('').includes('PÂNICO: 1 livre')) throw new Error('não registrou o pânico no log');
    const health = await (await fetch(`${r.base}/health`)).json();
    if (!health.panico.ativoAgora || !health.panico.ligado) throw new Error(`health: ${JSON.stringify(health.panico)}`);
    if (!(await (await fetch(`${r.base}/ura`)).text()).includes('Pânico dos robôs')) throw new Error('a /ura não mostra o pânico');

    // A supervisão religa os robôs com 1 livre: na próxima leitura de grupos (1 s), o BenURA desliga de novo.
    for (const x of ROBOS_10.slice(0, 3)) r.argus.definirStatus(x, 'livre');
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'religados à mão: desligados de novo' });

    r.argus.definirStatus('201', 'livre');
    await aguardar(() => r.saida.join('').includes('PÂNICO encerrado'), { timeoutMs: 8000, descricao: 'pânico encerrado' });
    for (const x of ROBOS_10) r.argus.definirStatus(x, 'livre');
    await esperar(2500);
    if (ligados().length !== 10) throw new Error('com 2 livres o BenURA desligou robôs');
  },

  async 'Pânico: 1 livre comum — os robôs seguem até perto de ele sair por ociosidade, e então param'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x] && r.argus.estado.status[x] !== 'Deslogado');
    await esperar(1500); // 200 livre há ~1,5 s; sai com 6 s (TEMPO_MIN) e o pânico age 3 s antes
    if (ligados().length !== 10) throw new Error(`desligou os robôs longe da saída do livre: ${ligados().length}`);
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'perto da saída: robôs desligados' });
    if (!r.saida.join('').includes('PÂNICO: 1 livre na URA (200) e ele sai por ociosidade em até 3 s')) throw new Error('log sem o motivo');
    if (r.transferencias().some((t) => t.startsWith('200→'))) throw new Error('o 200 saiu antes de os robôs pararem');
    if (r.chamadas('logaroperadorvirtual').length) throw new Error('o BenURA ligou robô no modo pânico');
  },

  async 'Pânico: 1 fixo livre — com a URA passiva hoje os robôs seguem; sem ela, metade aos poucos e, ocioso, seguem até ele atender'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x] && r.argus.estado.status[x] !== 'Deslogado');
    const passiva = (method, token = TOKEN) => fetch(`${r.base}/ura/passiva`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if ((await passiva('POST', '')).status !== 401) throw new Error('ligou a URA passiva sem token');
    const resposta = await (await passiva('POST')).json();
    if (resposta.ligado !== true || !resposta.mudou) throw new Error(`POST /ura/passiva: ${JSON.stringify(resposta)}`);
    if (!(await (await fetch(`${r.base}/ura`)).text()).includes('URA passiva hoje')) throw new Error('a /ura não mostra a URA passiva');

    r.argus.definirStatus('201', 'em atendimento'); // sobra o 200, fixo
    await esperar(2500);
    if (ligados().length !== 10) throw new Error(`fixo livre e URA passiva: o BenURA desligou robôs (${ligados().length})`);
    r.argus.definirStatus('200', 'em atendimento'); // atendeu: 0 livre
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'fixo atendeu: robôs desligados' });

    await passiva('DELETE');
    r.argus.definirStatus('200', 'livre');
    await esperar(500);
    for (const x of ROBOS_10) r.argus.definirStatus(x, 'livre'); // a supervisão religa
    await aguardar(() => ligados().length === 5, { timeoutMs: 8000, descricao: 'sem URA passiva: fixo sozinho desliga a metade' });
    if (!r.saida.join('').includes('PÂNICO: 1 livre na URA (200, fixo): metade dos robôs a cada 2 s')) throw new Error('log sem o motivo do fixo');
    await aguardar(() => ligados().length === 1, { timeoutMs: 10_000, descricao: 'metade da metade, aos poucos, até 1' });
    await aguardar(() => r.saida.join('').includes('Ramal 200 (fixo) livre há'), { timeoutMs: 15_000, descricao: 'fixo ocioso: os robôs seguem' });
    for (const x of ROBOS_10.slice(0, 4)) r.argus.definirStatus(x, 'livre'); // a supervisão religa mais
    await esperar(3000);
    if (ligados().length < 4) throw new Error(`fixo ocioso: o BenURA desligou robôs (${ligados().length})`);
    const health = await (await fetch(`${r.base}/health`)).json();
    if (!health.termometro || !health.relatorio || health.relatorio.panicoVezes.fixo < 1) throw new Error(`health: ${JSON.stringify(health.relatorio)}`);
    r.argus.definirStatus('200', 'em atendimento'); // atendeu: 0 livre
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'fixo atendeu: robôs desligados' });
  },

  async 'Pânico: interruptor desligado na /ura — o BenURA não desliga os robôs'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x] && r.argus.estado.status[x] !== 'Deslogado');
    const pedir = (method, token = TOKEN) => fetch(`${r.base}/panico`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if ((await pedir('DELETE', '')).status !== 401) throw new Error('desligou o pânico sem token');
    const resposta = await (await pedir('DELETE')).json();
    if (resposta.ligado !== false || !resposta.mudou) throw new Error(`DELETE /panico: ${JSON.stringify(resposta)}`);
    r.argus.definirStatus('201', 'em atendimento');
    r.argus.definirStatus('200', 'em atendimento');
    await esperar(2500);
    if (ligados().length !== 10) throw new Error(`com o pânico desligado, o BenURA desligou robôs: ${ligados().length}`);
    await pedir('POST');
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'pânico religado: robôs desligados' });
  },

  async 'Cliente de risco: callback vira perfil; "em curso" com esse cliente alerta na /alertas e desliga os robôs'(r) {
    const ligados = () => ROBOS_10.filter((x) => r.argus.estado.status[x] && r.argus.estado.status[x] !== 'Deslogado');
    await aguardar(() => r.chamadas('ligacoesdetalhadas').length > 0, { descricao: 'primeira leitura do relatório' });
    const local = (ms) => new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(Date.now() - ms)).replace(' ', 'T');
    const cliente = { dddTelefone: '11900000001', nomeCliente: 'CLIENTE TESTE', usuarioOperador: 'Oper Virtual 7' };
    r.argus.estado.ligacoes.push({ ...cliente, idLigacao: 1, dataHoraLigacao: local(3000), resultadoLigacao: 'OPER. VIRTUAL - ABANDONO EM FILA', tempoSegundos: 2 });
    await aguardar(async () => (await (await fetch(`${r.base}/perfis/risco`)).json()).clientes.length === 1, { timeoutMs: 8000, descricao: 'perfil de risco' });
    if (ligados().length !== 10) throw new Error('mexeu nos robôs antes do cliente de risco ligar');

    r.argus.estado.ligacoes.push({ ...cliente, idLigacao: 2, dataHoraLigacao: local(1000), resultadoLigacao: 'LIGAÇÃO EM CURSO', tempoSegundos: 0 });
    await aguardar(async () => (await (await fetch(`${r.base}/alertas`)).json()).alertas.length === 1, { timeoutMs: 8000, descricao: 'alerta' });
    const { alertas } = await (await fetch(`${r.base}/alertas`)).json();
    if (alertas[0].mascara !== '(11) 9****-0001' || JSON.stringify(alertas).includes('900000001')) throw new Error(`alerta: ${JSON.stringify(alertas)}`);
    await aguardar(() => ligados().length === 0, { timeoutMs: 8000, descricao: 'robôs desligados pelo cliente de risco' });
    if (!r.saida.join('').includes('CLIENTE DE RISCO em ligação')) throw new Error('não registrou no log');
    if (!(await (await fetch(`${r.base}/ura`)).text()).includes('Clientes de risco')) throw new Error('a /ura não mostra os clientes de risco');
    const gravado = fs.existsSync(path.join(r.pasta, 'state-perfis-clientes.json')) ? fs.readFileSync(path.join(r.pasta, 'state-perfis-clientes.json'), 'utf8') : '';
    if (/900000001|CLIENTE TESTE/.test(gravado)) throw new Error('telefone ou nome no arquivo de perfis');
  },

  async 'Robôs: modo manual — a supervisão assume e o BenURA não mexe; ao devolver, volta a agir'(r) {
    const post = (rota, corpo = {}) => fetch(`${r.base}${rota}?token=${TOKEN}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
    if ((await post('/robos/manual', { minutos: 5 })).status !== 200) throw new Error('POST /robos/manual falhou');
    r.argus.definirStatus('200', 'em atendimento'); // ninguém livre: em modo automático desligaria tudo
    await esperar(2000);
    if (r.chamadas('deslogaroperador').length) throw new Error('mexeu nos robôs em modo manual');

    await post('/robos/automatico');
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'desligar ao voltar ao automático' });
  },

  async 'Robôs: redução parcial não derruba robô em ligação; ele sai quando a ligação termina'(r) {
    const deslogados = () => r.chamadas('deslogaroperador').map((c) => String(c.dados.ramal));
    await esperar(1500); // 2 livres × 2 = 4: nada a reduzir
    if (deslogados().length) throw new Error(`desligou com o alvo atendido: ${deslogados()}`);

    r.argus.definirStatus('201', 'em atendimento'); // 1 livre → alvo 2; excesso 2, mas só o 903 está ocioso
    await aguardar(() => deslogados().includes('903'), { descricao: 'desligar o ocioso 903' });
    await esperar(1500);
    if (deslogados().some((x) => ['900', '901', '902'].includes(x))) throw new Error(`derrubou robô em ligação: ${deslogados()}`);

    r.argus.definirStatus('900', 'livre'); // a ligação do 900 terminou
    await aguardar(() => deslogados().includes('900'), { descricao: 'desligar o 900 ao terminar a ligação' });
    if (deslogados().some((x) => ['901', '902'].includes(x))) throw new Error('derrubou robô que continua em ligação');
  },

  async 'Robôs: queda breve de livres não reduz; queda que se mantém reduz'(r) {
    const deslogados = () => r.chamadas('deslogaroperador').length;
    await esperar(1000); // 2 livres × 2 = 4 robôs: alvo atendido
    r.argus.definirStatus('201', 'em atendimento');
    await esperar(1000); // várias leituras (300 ms) vendo 1 livre só
    r.argus.definirStatus('201', 'livre'); // voltou antes de ROBOS_REDUZIR_APOS_MS (2 s)
    await esperar(3000);
    if (deslogados()) throw new Error('reduziu por uma queda breve de livres');

    r.argus.definirStatus('201', 'em atendimento'); // agora a queda se mantém
    await aguardar(() => deslogados() >= 2, { descricao: 'reduzir depois de confirmar' });
  },

  async 'Robôs: religar sobe em degraus'(r) {
    const religados = () => r.chamadas('logaroperadorvirtual').length;
    await aguardar(() => religados() >= 6, { timeoutMs: 10_000, descricao: 'chegar a 6 robôs' });
    const momentos = r.chamadas('logaroperadorvirtual').map((c) => c.em).sort((a, b) => a - b);
    const espalhado = momentos.at(-1) - momentos[0];
    if (espalhado < 900) throw new Error(`ligou 6 robôs em ${espalhado} ms: devia subir 2 por vez, a cada 500 ms`);
  },

  async 'Robôs: humano da URA em pausa conta como ocupado'(r) {
    r.argus.definirStatus('200', 'pausa');
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Robôs desligados pelo painel: desliga os robôs e mantém desligados; o rodízio dos humanos segue'(r) {
    const resp = await fetch(`${r.base}/robos/modo`, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{"modo":"desligados","por":"cenário"}' });
    if (resp.status !== 200) throw new Error(`PUT /robos/modo: HTTP ${resp.status}`);
    await aguardar(() => ['900', '901'].every((ramal) => r.chamadas('deslogaroperador').some((c) => c.dados.ramal === ramal)), { descricao: 'deslogar os dois robôs' });
    const ligacoesAntes = r.chamadas('logaroperadorvirtual').length;
    // Alguém liga um robô por fora: o BenURA desliga de novo.
    const antes = r.chamadas('deslogaroperador').length;
    r.argus.definirStatus('900', 'livre');
    await aguardar(() => r.chamadas('deslogaroperador').length > antes, { descricao: 'desligar de novo o robô ligado por fora' });
    // O rodízio dos humanos segue: 101 atende no Ativo e sobe para a URA.
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101 → URA com os robôs desligados' });
    if (r.chamadas('logaroperadorvirtual').length > ligacoesAntes) throw new Error('ligou robô com os robôs desligados pelo painel');
    const { robos } = await (await fetch(`${r.base}/health`)).json();
    if (robos.modo !== 'desligados' || robos.modoPor !== 'cenário') throw new Error(`/health: ${JSON.stringify(robos)}`);
  },

  async 'Robôs: URA sem humanos → desliga'(r) {
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Robôs: todos os humanos da URA offline → desliga'(r) {
    r.argus.definirStatus('200', null);
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { descricao: 'deslogar robôs' });
  },

  async 'Webhook de início de atendimento na URA → desliga robôs na hora'(r) {
    await esperar(500);
    const res = await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '200' });
    if (res.status !== 200) throw new Error(`webhook respondeu ${res.status}`);
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { timeoutMs: 1200, descricao: 'deslogar após webhook' });
  },

  async 'Webhook de início de atendimento no Ativo → marca histórico'(r) {
    // 101 nunca aparece "em atendimento" no status: só o webhook registra o atendimento.
    await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '101' });
    await aguardar(() => r.transferencias().includes('101→2'), { descricao: '101→URA pelo webhook' });
  },

  async 'Webhook sem token válido → 401 e nada acontece'(r) {
    const res = await r.webhook({ idTipoWebhook: 1, codUsuarioIntegracao: '200' }, { token: 'errado' });
    if (res.status !== 401) throw new Error(`esperava 401, veio ${res.status}`);
    await esperar(800);
    if (r.chamadas('deslogaroperador').length) throw new Error('webhook inválido teve efeito');
  },

  async 'Automação desligada pelo painel: o rodízio espera sem tocar na Argus e sobe quando religam'(r) {
    const tudo = r.saida.join('');
    if (!tudo.includes('Automação desligada pelo painel')) throw new Error('não avisou que estava esperando');
    if (!tudo.includes('Automação religada pelo painel')) throw new Error('não avisou que foi religada');
    if (r.argus.estado.chamadasAntesDeReligar !== 0) throw new Error(`chamou a Argus desligado: ${r.argus.estado.chamadasAntesDeReligar}`);
    if ((await fetch(`${r.base}/health`)).status !== 200) throw new Error('não subiu depois de religar');
  },

  async 'Modo simulação ligado pelo painel: o rodízio age em DRY_RUN mesmo com DRY_RUN=0 no .env'(r) {
    r.argus.definirStatus('101', 'em atendimento');
    await esperar(1000);
    r.argus.definirStatus('101', 'livre');
    await aguardar(() => /DRY_RUN/.test(r.saida.join('')) && r.saida.join('').includes('101'), { descricao: 'simulou a ida do 101' });
    if (r.chamadas('transferiroperadorgrupo').length) throw new Error('transferiu de verdade em simulação');
    const { dryRun } = await (await fetch(`${r.base}/health`)).json();
    if (dryRun !== true) throw new Error('/health sem dryRun');
  },

  async 'Health responde'(r) {
    const res = await fetch(`${r.base}/health`);
    if (res.status !== 200) throw new Error(`health ${res.status}`);
    // O painel da supervisão mostra quem está na URA a partir daqui.
    await aguardar(async () => {
      const { uraAgora } = await (await fetch(`${r.base}/health`)).json();
      return uraAgora?.some((u) => u.ramal === '200' && u.classe === 'livre' && u.livreDesde && u.fixo === false);
    }, { descricao: '/health com uraAgora (200 livre)' });
  },

  // ── Correções (o script original falha nestes) ──

  async 'Correção: trava deixada por processo morto não impede o início'(r) {
    const res = await fetch(`${r.base}/health`);
    if (res.status !== 200) throw new Error('não iniciou');
  },

  async 'Correção: token inválido (HTTP 403) é reportado como erro de autenticação'(r) {
    await esperar(1500);
    const log = r.saida.join('');
    if (/rate limit/i.test(log)) throw new Error('403 tratado como limite de requisições');
    if (!/token/i.test(log)) throw new Error('nenhuma mensagem sobre o token');
  },

  async 'Correção: webhook tipo 5 com o campo "FidConclusaoDerivacao" (como na documentação)'(r) {
    await esperar(500);
    await r.webhook({ idTipoWebhook: 5, FidConclusaoDerivacao: 1, codUsuarioIntegracao: '200' });
    await aguardar(() => r.chamadas('deslogaroperador').length >= 2, { timeoutMs: 1200, descricao: 'deslogar após webhook' });
  },

  // ── Retorno de quem desistiu da fila (novo: o script original não tem) ──

  async 'Retorno: abandonou a fila → lead na skill com origem RETORNO_URA'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await aguardar(() => r.chamadas('novo').length === 1, { descricao: 'POST /novo' });
    const [{ skill, dados }] = r.chamadas('novo');
    if (skill !== SKILL) throw new Error(`skill errada: ${skill}`);
    if (dados.telefone1 !== '11987654321' || dados.origem !== 'RETORNO_URA' || dados.info0 !== 'ABANDONOU_FILA') {
      throw new Error(`lead inesperado: ${JSON.stringify(dados)}`);
    }
  },

  async 'Retorno: mesmo telefone desiste duas vezes → um lead só'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await r.webhook(encerramentoUra({ conclusao: 4 }));
    await aguardar(() => r.chamadas('novo').length >= 1, { descricao: 'POST /novo' });
    await esperar(800);
    if (r.chamadas('novo').length !== 1) throw new Error(`${r.chamadas('novo').length} leads incluídos`);
  },

  async 'Retorno: cliente liga de novo e é atendido → retorno removido'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await aguardar(() => r.chamadas('novo').length === 1, { descricao: 'POST /novo' });
    await r.webhook(encerramentoUra({ conclusao: 1 }));
    await aguardar(() => r.chamadas('excluir').length === 1, { descricao: 'POST /excluir' });
    const { codCliente } = r.chamadas('excluir')[0].dados;
    if (codCliente !== r.chamadas('novo')[0].dados.codCliente) throw new Error(`codCliente diferente: ${codCliente}`);
  },

  async 'Retorno: desligado (padrão) → nada vai para o mailing'(r) {
    await r.webhook(encerramentoUra({ conclusao: 2 }));
    await esperar(800);
    if (r.chamadas('novo').length) throw new Error('lead incluído com o retorno desligado');
  },
};

const SKILL = 'hash-skill-retorno';
const RETORNO_LIGADO = { env: { RETORNO_FILA_ATIVO: 'true', RETORNO_SKILL_HASH: SKILL } };

/** Webhook "Encerramento de URA" (tipo 5) como a Argus envia. */
const encerramentoUra = ({ conclusao }) => ({
  idTipoWebhook: 5,
  idConclusaoDerivacao: conclusao,
  telefone: '5511987654321',
  servicoDesc: 'CONSIGNADO',
  dataInicioUra: '2026-10-08T10:00:00',
});

/** Grava o state-vendas.json do roteador com a data de hoje: { ramal: 'URA' | 'ATIVO' }. */
function escreverVendas(pasta, filas) {
  const vendedores = Object.fromEntries(Object.entries(filas).map(([ramal, fila]) => [ramal, { nome: `OPERADOR ${ramal}`, fila }]));
  const arquivo = path.join(pasta, 'state-vendas.json');
  fs.writeFileSync(arquivo, JSON.stringify({ versao: 2, data: dataLocal('America/Sao_Paulo'), vendedores }));
  const depois = new Date(Date.now() + 1000); // garante mtime novo mesmo em sistemas de arquivo com resolução de 1 s
  fs.utimesSync(arquivo, depois, depois);
}

/** PID que certamente não existe (processo já encerrado). */
function pidMorto() {
  const { pid } = require('child_process').spawnSync(process.execPath, ['-e', '0']);
  return pid;
}

const ROBOS_10 = Array.from({ length: 10 }, (_, i) => String(900 + i));

/** Diretório da Argus: 100 (Ativo, grupo 1) e 201 (URA) têm o mesmo supervisor → grupo do supervisor = 1. */
const USUARIOS_COM_SUPERVISOR = [
  { idUsuario: 900, nome: 'SUPERVISORA TESTE', idTipoUsuario: 1, ativo: true, campanhas: [] },
  ...[['100', 1], ['200', 2], ['201', 2]].map(([ramal, grupo], i) => ({
    idUsuario: 10 + i, nome: `OPERADOR ${ramal}`, ramal, idTipoUsuario: 2, ativo: true,
    campanhas: [{ idCampanha: 1, idGrupoUsuario: grupo, idUsuarioSupervisor: 900, nomeUsuarioSupervisor: 'SUPERVISORA TESTE' }],
  })),
];

/** 201 começa na URA sem ter sido movido pelo rodízio (como um fixo posto pelo roteador). */
const URA_COM_201_NAO_MOVIDO = {
  grupos: GRUPOS_BASE.map((g) => (g.idGrupoUsuario === 2 ? { ...g, ramaisOperadores: ['200', '201'] } : g)),
  status: { ...STATUS_BASE, 200: 'em atendimento', 201: 'livre' },
  usuarios: USUARIOS_COM_SUPERVISOR,
};

/** 201, único humano na URA, com robôs ligados (o 900 em ligação). */
const ULTIMO_LIVRE_COM_ROBO_EM_LIGACAO = {
  grupos: [
    { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
    { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['201'] },
    { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901', '902'] },
  ],
  status: { 100: 'em atendimento', 201: 'livre', 900: 'em atendimento', 901: 'livre', 902: 'livre' },
  usuarios: USUARIOS_COM_SUPERVISOR,
  env: { ROBOS_POR_LIVRE: '3' },
};

/** URA vazia e robôs desligados: dá para ver quando o 101 passa a contar como livre. */
const URA_VAZIA_ROBOS_DESLIGADOS = {
  grupos: [
    { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100', '101'] },
    { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: [] },
    { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901'] },
  ],
  status: { 100: 'livre', 101: 'livre' },
};

const VARIACOES = {
  'URA: movido que pisca offline não volta; offline que continua volta depois de OFFLINE_VOLTA_APOS_MS': {
    env: { OFFLINE_VOLTA_APOS_MS: '2000', TEMPO_MIN: '1' },
  },
  'Robôs: quem acabou de trocar a telefonia para a URA só liga robô depois da carência': {
    ...URA_VAZIA_ROBOS_DESLIGADOS, env: { CARENCIA_TROCA_GRUPO_MS: '3000' },
  },
  'Rodízio: quem vai para a URA só conta como livre (e liga robô) depois que a discadora troca a telefonia': {
    ...URA_VAZIA_ROBOS_DESLIGADOS, atrasoTrocaMs: 1500, env: { ALINHAR_LOGIN_APOS_MS: '5000' },
  },
  'Rodízio: quem fica preso no grupo antigo (não troca sozinho) é relogado e só então liga robô': {
    ...URA_VAZIA_ROBOS_DESLIGADOS, preparar: ({ argus }) => argus.estado.travados.add('101'),
  },
  'URA: logado em outro grupo → avisa; em ligação não mexe; ao ficar livre, reloga na URA': {
    status: { ...STATUS_BASE, 200: 'em atendimento' },
    preparar: ({ argus }) => { argus.estado.grupoLogado = { 200: 1 }; },
  },
  'URA: último livre sai no horário; antes disso os robôs param de discar e os em ligação terminam': {
    ...ULTIMO_LIVRE_COM_ROBO_EM_LIGACAO, env: { ROBOS_POR_LIVRE: '3', PREPARAR_SAIDA_ULTIMO_LIVRE_MS: '3000' },
  },
  'URA: último livre sai no TEMPO_MIN mesmo com robô ainda em ligação': {
    ...ULTIMO_LIVRE_COM_ROBO_EM_LIGACAO, env: { ROBOS_POR_LIVRE: '3', PREPARAR_SAIDA_ULTIMO_LIVRE_MS: '3000' },
  },
  'URA: quem já estava na URA (não movido) e fica ocioso volta ao grupo do supervisor': URA_COM_201_NAO_MOVIDO,
  // Grupos relidos só a cada 60 s: a volta à URA não pode depender dessa releitura.
  'URA: fixo (posto na URA pelo roteador) ocioso vai ao Ativo e volta à URA ao atender lá': {
    ...URA_COM_201_NAO_MOVIDO, env: { REFRESH_GRUPOS_MS: '60000', RODIZIO_SO_ELEGIVEIS: '1' },
    preparar: ({ pasta }) => escreverVendas(pasta, { 100: 'ATIVO', 201: 'URA' }),
  },
  'URA: fixo de OPERADORES_FIXOS_URA/EQUIPES_FIXAS_URA fica na URA de vez, mesmo ocioso': {
    ...URA_COM_201_NAO_MOVIDO, env: { OPERADORES_FIXOS_URA: '201' },
  },
  'Ativo: sem a lista do dia do roteador, só os fixos sobem (e avisa)': { env: { RODIZIO_SO_ELEGIVEIS: '1', OPERADORES_FIXOS_URA: '101' } },
  'Ativo: só elegível sobe; quem vende hoje passa a subir': {
    env: { RODIZIO_SO_ELEGIVEIS: '1' },
    preparar: ({ pasta }) => escreverVendas(pasta, { 100: 'ATIVO', 101: 'URA' }),
  },
  'Robôs proporcionais: 3 por livre, reduz poupando quem está em ligação, aumenta e zera': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      // 203 deslogado: a Argus responde HTTP 500 e ele não pode tirar a visibilidade da URA.
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201', '202', '203'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: {
      100: 'livre', 200: 'livre', 201: 'em atendimento', 202: 'em atendimento',
      ...Object.fromEntries(ROBOS_10.map((x) => [x, x === '900' ? 'em atendimento' : 'livre'])),
    },
    env: { ROBOS_POR_LIVRE: '3' },
  },
  'Robôs: callback baixa um degrau de robôs por livre (sem derrubar ligação) e volta sozinho': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: {
      100: 'livre', 200: 'livre', 201: 'livre',
      ...Object.fromEntries(ROBOS_10.map((x) => [x, x === '900' ? 'em atendimento' : 'livre'])),
    },
    env: {
      ROBOS_POR_LIVRE: '3', ROBOS_DEGRAU: '10', ROBOS_POR_LIVRE_MINIMO: '1', ROBOS_RECUPERAR_APOS_MIN: '0.08', TEMPO_MIN: '5',
      ROBOS_AJUSTE_DEGRAU: '1',
    },
  },
  'Robôs: URA passiva sobe os robôs por livre; a supervisão ajusta na /ura': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: {
      ROBOS_POR_LIVRE: '2', ROBOS_POR_LIVRE_MINIMO: '1', ROBOS_POR_LIVRE_MAXIMO: '4', ROBOS_PASSIVA_APOS_MIN: '0.05',
      ROBOS_DEGRAU: '10', TEMPO_MIN: '5',
    },
  },
  'Cliente de risco: callback vira perfil; "em curso" com esse cliente alerta na /alertas e desliga os robôs': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: {
      ROBOS_MODO: 'panico', TEMPO_MIN: '5', CALLBACKS_VERIFICAR_SEG: '0.5', PERFIS_VIGIA_SEG: '0.5', RISCO_DESLIGA_ROBOS: '1',
    },
  },
  'Pânico: com 1 livre, desliga os robôs que a supervisão ligou; com 2, não mexe; nunca liga': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    // Antecedência maior que o TEMPO_MIN: com 1 livre comum, o pânico age na hora.
    env: { ROBOS_MODO: 'panico', TEMPO_MIN: '5', PANICO_ANTES_DE_SAIR_MS: '600000' },
  },
  'Pânico: 1 livre comum — os robôs seguem até perto de ele sair por ociosidade, e então param': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'em atendimento', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: { ROBOS_MODO: 'panico', TEMPO_MIN: '0.1', PANICO_ANTES_DE_SAIR_MS: '3000' },
  },
  'Pânico: 1 fixo livre — com a URA passiva hoje os robôs seguem; sem ela, metade aos poucos e, ocioso, seguem até ele atender': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: { ROBOS_MODO: 'panico', TEMPO_MIN: '5', OPERADORES_FIXOS_URA: '200', PANICO_FIXO_REDUZIR_A_CADA_S: '2', PANICO_FIXO_OCIOSO_MIN: '0.2' },
  },
  'Pânico: interruptor desligado na /ura — o BenURA não desliga os robôs': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    // Antecedência maior que o TEMPO_MIN: com 1 livre comum, o pânico age na hora.
    env: { ROBOS_MODO: 'panico', TEMPO_MIN: '5', PANICO_ANTES_DE_SAIR_MS: '600000' },
  },
  'Vigia de callbacks: callback no relatório da Argus (sem webhook) → raio-x em callbacks.txt e ajuste desce': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', 201: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: {
      ROBOS_POR_LIVRE: '4', ROBOS_POR_LIVRE_MINIMO: '1', ROBOS_AJUSTE_DEGRAU: '2', ROBOS_DEGRAU: '10', TEMPO_MIN: '5',
      CALLBACKS_VERIFICAR_SEG: '0.5',
    },
  },
  'Robôs: com 1 livre só, no máximo ROBOS_MAX_COM_1_LIVRE; a URA passiva não sobe': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    env: {
      ROBOS_POR_LIVRE: '5', ROBOS_MAX_COM_1_LIVRE: '3', ROBOS_PASSIVA_APOS_MIN: '0.03', ROBOS_DEGRAU: '10', TEMPO_MIN: '5',
    },
  },
  'Robôs pela taxa: com 1 livre o teto é o do status da URA (agressiva 6, calma 20)': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ROBOS_10 },
    ],
    status: { 100: 'em atendimento', 200: 'livre', ...Object.fromEntries(ROBOS_10.map((x) => [x, 'livre'])) },
    // No começo do dia a taxa ainda é medida: vale o ROBOS_POR_LIVRE, com o teto do status.
    env: { ROBOS_CALCULO: 'taxa', ROBOS_POR_LIVRE: '8', ROBOS_MAX_COM_1_LIVRE: '6', ROBOS_DEGRAU: '10', TEMPO_MIN: '5' },
  },
  'Robôs: redução parcial não derruba robô em ligação; ele sai quando a ligação termina': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901', '902', '903'] },
    ],
    status: {
      100: 'livre', 200: 'livre', 201: 'livre', 900: 'em atendimento', 901: 'em atendimento', 902: 'em atendimento', 903: 'livre',
    },
    env: { ROBOS_POR_LIVRE: '2' },
  },
  'Robôs: queda breve de livres não reduz; queda que se mantém reduz': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901', '902', '903'] },
    ],
    status: { 100: 'livre', 200: 'livre', 201: 'livre', 900: 'livre', 901: 'livre', 902: 'livre', 903: 'livre' },
    env: { ROBOS_POR_LIVRE: '2', ROBOS_REDUZIR_APOS_MS: '2000' },
  },
  'Robôs: religar sobe em degraus': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: ['200', '201', '202'] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901', '902', '903', '904', '905'] },
    ],
    status: { 100: 'livre', 200: 'livre', 201: 'livre', 202: 'livre' }, // robôs começam desligados
    env: { ROBOS_POR_LIVRE: '2', ROBOS_DEGRAU: '2' },
  },
  'URA calma: sobem os 4 mais antigos livres do Ativo; quem volta pelo ocioso dá a vez ao próximo': {
    grupos: [
      { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: ['100', '101', '102', '103', '104', '105', '106', '107'] },
      { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: [] },
      { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: ['900', '901'] },
    ],
    status: { ...Object.fromEntries(['100', '101', '102', '103', '104', '105', '106', '107'].map((x) => [x, 'livre'])), 900: 'livre', 901: 'livre' },
    env: { URA_CALMA_LIMITAR_LIVRES: '1' },
  },
  'URA cheia: ninguém sobe só por estar no Ativo; quem atender sobe mesmo sem ser elegível; a regra do ocioso vale': {
    env: { RODIZIO_SO_ELEGIVEIS: '1' },
    preparar: ({ pasta }) => escreverVendas(pasta, { 100: 'ATIVO', 101: 'URA' }),
  },
  'Alocar todos no Ativo: ninguém sobe até retomar; ao retomar, quem é elegível vai para a URA na hora': {
    env: { RODIZIO_SO_ELEGIVEIS: '1' },
    preparar: ({ pasta }) => escreverVendas(pasta, { 100: 'ATIVO', 101: 'URA' }),
  },
  'URA cheia em DRY_RUN: simula a ida de quem atendeu uma vez só': { env: { DRY_RUN: '1' } },
  'DRY_RUN: movido simulado não conta como livre na URA (alvo de robôs não infla)': {
    env: { DRY_RUN: '1', ROBOS_POR_LIVRE: '1' },
  },
  'Robôs: URA sem humanos → desliga': {
    grupos: GRUPOS_BASE.map((g) => (g.idGrupoUsuario === 2 ? { ...g, ramaisOperadores: [] } : g)),
  },
  'Automação desligada pelo painel: o rodízio espera sem tocar na Argus e sobe quando religam': {
    preparar: ({ argus, pasta }) => {
      const arquivo = path.join(pasta, 'state-automacao.json');
      fs.writeFileSync(arquivo, JSON.stringify({ desligada: true, desde: new Date().toISOString(), por: 'teste' }));
      setTimeout(() => {
        argus.estado.chamadasAntesDeReligar = argus.estado.chamadas.length;
        fs.writeFileSync(arquivo, JSON.stringify({ desligada: false }));
      }, 2500);
    },
  },
  'Modo simulação ligado pelo painel: o rodízio age em DRY_RUN mesmo com DRY_RUN=0 no .env': {
    env: { DRY_RUN: '0' },
    preparar: ({ pasta }) => fs.writeFileSync(path.join(pasta, 'state-simulacao.json'), JSON.stringify({ ligada: true })),
  },
  'Correção: trava deixada por processo morto não impede o início': {
    preparar: ({ pasta }) => fs.writeFileSync(path.join(pasta, 'argus.lock'), String(pidMorto())),
  },
  'Correção: token inválido (HTTP 403) é reportado como erro de autenticação': {
    preparar: ({ argus }) => { argus.estado.responderComStatusHttp = 403; },
  },
  'Retorno: abandonou a fila → lead na skill com origem RETORNO_URA': RETORNO_LIGADO,
  'Retorno: mesmo telefone desiste duas vezes → um lead só': RETORNO_LIGADO,
  'Retorno: cliente liga de novo e é atendido → retorno removido': RETORNO_LIGADO,
};

// ───────────────────────────── Execução ─────────────────────────────

async function main() {
  const filtro = process.env.CENARIO;
  console.log(`Alvo: ${path.relative(process.cwd(), ALVO) || ALVO}\n`);
  let falhas = 0;

  for (const [nome, cenario] of Object.entries(CENARIOS)) {
    if (filtro && !nome.includes(filtro)) continue;
    const inicio = Date.now();
    let rodizio;
    try {
      rodizio = await iniciarRodizio(VARIACOES[nome]);
      await cenario(rodizio);
      console.log(`  ✓ ${nome} (${((Date.now() - inicio) / 1000).toFixed(1)}s)`);
    } catch (e) {
      falhas++;
      console.log(`  ✗ ${nome}\n      ${e.message}`);
      if (process.env.DEBUG_CENARIOS && rodizio) console.log(rodizio.saida.join('').split('\n').slice(-25).join('\n'));
    } finally {
      await rodizio?.encerrar();
    }
  }

  console.log(`\n${falhas ? `${falhas} cenário(s) falharam` : 'Todos os cenários passaram'}`);
  process.exitCode = falhas ? 1 : 0;
}

main();

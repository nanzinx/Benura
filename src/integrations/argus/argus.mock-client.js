'use strict';
/**
 * Argus falsa para desenvolvimento (USAR_MOCK=1) e para o mock server HTTP.
 * Mesma interface do ArgusClient, sem rede. Os nomes batem com o cliente
 * mock do Carrossel.
 *
 * Estrutura simulada (campanha 1 - BENCONSIG):
 *   grupo 1  GABRIEL - COMERCIAL   (Ativo)
 *   grupo 3  MAYSA - COMERCIAL     (Ativo)
 *   grupo 2  RECEPTIVO - URA       (URA)
 *   grupo 9  TREINAMENTO           (não gerenciado — ajuste manual)
 */

const CAMPANHA = { idCampanha: 1, campanhaDesc: 'BENCONSIG' };

const GRUPOS = [
  { idGrupoUsuario: 1, grupoUsuarioDesc: 'GABRIEL - COMERCIAL' },
  { idGrupoUsuario: 2, grupoUsuarioDesc: 'RECEPTIVO - URA' },
  { idGrupoUsuario: 3, grupoUsuarioDesc: 'MAYSA - COMERCIAL' },
  { idGrupoUsuario: 9, grupoUsuarioDesc: 'TREINAMENTO' },
];

const SUPERVISORES = [
  { idUsuario: 491, nome: 'GABRIEL NASCIMENTO DA SILVA', login: 'GABRIEL.NASCIMENTO', ramal: '2266465' },
  { idUsuario: 880, nome: 'MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO', login: 'MAYSA.SIQUEIRA', ramal: '2266767' },
];

// [idUsuario, nome, login, ramal, idGrupo, idSupervisor, ativo]
const OPERADORES = [
  [101, 'ANA CLARA SOUZA', 'ANA.SOUZA', '1001', 1, 491, true],
  [102, 'CARLOS EDUARDO LIMA', 'CARLOS.LIMA', '1002', 1, 491, true],
  [103, 'MARIANA FERREIRA COSTA', 'MARIANA.COSTA', '1003', 2, 880, true],
  [104, 'RICARDO MENDES', 'RICARDO.MENDES', '1004', 1, 491, true],
  [105, 'JULIANA ALVES', 'JULIANA.ALVES', '1005', 3, 880, true],
  [106, 'FERNANDO RIBEIRO', 'FERNANDO.RIBEIRO', '1006', 3, 880, true],
  [107, 'PATRÍCIA SANTOS', 'PATRICIA.SANTOS', '1007', 9, 491, true],
  [108, 'DIEGO OLIVEIRA', 'DIEGO.OLIVEIRA', '1008', 3, 880, true],
  [109, 'BRUNO DESLIGADO', 'BRUNO.DESLIGADO', '1009', 1, 491, false],
];

/** Estado inicial (novo a cada chamada: cada instância tem sua própria Argus). */
function criarDadosArgus() {
  const supervisorPorId = new Map(SUPERVISORES.map((s) => [s.idUsuario, s]));
  const grupoDesc = new Map(GRUPOS.map((g) => [g.idGrupoUsuario, g.grupoUsuarioDesc]));

  const usuarios = [
    ...SUPERVISORES.map((s) => ({
      ...s, re: '', cpf: '', email: '', ativo: true, idTipoUsuario: 1, tipoUsuarioDesc: 'Administrativo',
      campanhas: [{ ...CAMPANHA, idGrupoUsuario: null, grupoUsuarioDesc: null, idUsuarioSupervisor: null, nomeUsuarioSupervisor: null }],
    })),
    ...OPERADORES.map(([idUsuario, nome, login, ramal, idGrupo, idSup, ativo]) => ({
      idUsuario, nome, login, ramal, re: '', cpf: '', email: '', ativo, idTipoUsuario: 2, tipoUsuarioDesc: 'Operador',
      campanhas: [{
        ...CAMPANHA,
        idGrupoUsuario: idGrupo,
        grupoUsuarioDesc: grupoDesc.get(idGrupo),
        idUsuarioSupervisor: idSup,
        nomeUsuarioSupervisor: supervisorPorId.get(idSup).nome,
      }],
    })),
  ];
  return { usuarios };
}

/** Monta a resposta de /listargrupos a partir do estado atual dos usuários. */
function gruposDe(dados) {
  return GRUPOS.map((g) => {
    const ramais = dados.usuarios
      .filter((u) => u.ativo && u.idTipoUsuario === 2 && u.campanhas.some((c) => c.idGrupoUsuario === g.idGrupoUsuario))
      .map((u) => u.ramal);
    return {
      ...CAMPANHA, ...g, idTipoGrupo: 1, tipoGrupoDesc: 'OPERACIONAL',
      qtdeOperadores: ramais.length, ramaisOperadores: ramais, dadosGrupoVirtual: null,
    };
  });
}

/** Aplica /transferiroperadorgrupo nos dados. @returns {object} resposta da Argus */
function transferir(dados, { idGrupoUsuarioDestino, ramaisOperadores = [] }) {
  const destino = GRUPOS.find((g) => g.idGrupoUsuario === idGrupoUsuarioDestino);
  const operadores = ramaisOperadores.map((ramal) => {
    const u = dados.usuarios.find((x) => x.ramal === String(ramal) && x.idTipoUsuario === 2 && x.ativo);
    if (!destino) return { ramal, codStatus: -1, descStatus: 'Grupo destino inválido' };
    if (!u) return { ramal, codStatus: -1, descStatus: 'Operador não encontrado' };
    u.campanhas[0].idGrupoUsuario = destino.idGrupoUsuario;
    u.campanhas[0].grupoUsuarioDesc = destino.grupoUsuarioDesc;
    return { ramal, codStatus: 1, descStatus: 'Transferido' };
  });
  const ok = operadores.filter((o) => o.codStatus === 1).length;
  return {
    codStatus: 1, descStatus: 'Processado', qtdeTransferidos: ok, qtdeFalhas: operadores.length - ok, operadores,
  };
}

// Quem está logado na simulação: ANA livre, CARLOS em atendimento, DIEGO em pausa.
const STATUS_INICIAL = {
  1001: { descricaoStatus: 'Livre', descricaoPausa: '' },
  1002: { descricaoStatus: 'Em atendimento', descricaoPausa: '' },
  1008: { descricaoStatus: 'Pausa', descricaoPausa: 'Almoço' },
};

class ArgusMockClient {
  constructor(logger) {
    this.log = logger;
    this.dados = criarDadosArgus();
    this.status = new Map(Object.entries(structuredClone(STATUS_INICIAL)));
    this.leads = [];
  }

  async listarGrupos() {
    return gruposDe(this.dados);
  }

  async listarUsuarios() {
    return structuredClone(this.dados.usuarios);
  }

  async listarCampanhas() {
    return [{ ...CAMPANHA, ativo: true }];
  }

  async transferirOperador(ramal, grupoDestinoId) {
    const r = transferir(this.dados, { idGrupoUsuarioDestino: grupoDestinoId, ramaisOperadores: [String(ramal)] });
    this.log.info(`[MOCK] Argus: ramal ${ramal} → grupo ${grupoDestinoId}: ${r.operadores[0].descStatus}`);
    if (r.operadores[0].codStatus !== 1) throw new Error(r.operadores[0].descStatus);
    return r;
  }

  async statusOperador(ramal) {
    return this.status.get(String(ramal)) || null;
  }

  async deslogarOperador(ramal) {
    this.log.info(`[MOCK] Argus: ramal ${ramal} deslogado`);
    this.status.delete(String(ramal));
    return { codStatus: 1, descStatus: 'Operador deslogado' };
  }

  async incluirLead(hashSkill, lead) {
    const nrLead = this.leads.length + 1;
    this.leads.push({ hashSkill, nrLead, ...lead });
    this.log.info(`[MOCK] Argus: lead ${nrLead} (${lead.telefone1}) incluído na skill ${hashSkill}`);
    return { codStatus: 1, descStatus: 'Lead incluído', nrLead, idLote: 1 };
  }

  async excluirLead(hashSkill, { codCliente }) {
    const antes = this.leads.length;
    this.leads = this.leads.filter((l) => !(l.hashSkill === hashSkill && l.codCliente === codCliente));
    return { excluidos: antes - this.leads.length, items: [] };
  }
}

module.exports = { ArgusMockClient, criarDadosArgus, gruposDe, transferir };

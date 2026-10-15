'use strict';
/**
 * Argus falsa por HTTP para os cenários do rodízio (argus-automacao).
 *
 * Mantém grupos e status de operadores em memória, registra cada comando
 * recebido e permite que o teste altere status no meio da execução.
 *
 * Como a Argus real: transferir de grupo quem já está logado muda a lista na
 * hora, mas a telefonia (statusoperador.idGrupo) só troca quando a pessoa fica
 * LIVRE, com um atraso da discadora. Em ligação ou pausa, a troca espera.
 * `travados` simula quem nunca troca sozinho (até logar de novo), como o
 * operador visto em 14/10/2026. logaroperador loga no grupo vinculado.
 */

const http = require('http');

/**
 * @param {object} opcoes
 * @param {Array<{ idGrupoUsuario, idTipoGrupo, ramaisOperadores }>} opcoes.grupos
 * @param {Record<string, string|null>} opcoes.status - ramal → descricaoStatus (null = offline)
 * @param {object[]} [opcoes.usuarios] - resposta de /listarusuarios (supervisores e vínculos)
 * @param {number} [opcoes.atrasoTrocaMs] - quanto a discadora demora para trocar o grupo de quem está livre
 */
function criarArgusFake({ grupos, status, usuarios = [], atrasoTrocaMs = 300 }) {
  const estado = {
    grupos: structuredClone(grupos),
    status: { ...status },
    usuarios: structuredClone(usuarios),
    chamadas: [],
    leads: [],
    /** relatório de ligações detalhadas (vigia de callbacks) */
    ligacoes: [],
    responderComStatusHttp: null, // ex.: 403 para simular token inválido
    /** ramal → idGrupo em que a telefonia diz que ele está logado (padrão: o grupo da lista) */
    grupoLogado: {},
    /** ramal → desde quando a troca de grupo espera a discadora */
    trocaPendente: {},
    /** ramais que nunca trocam sozinhos (só logando de novo) */
    travados: new Set(),
  };

  /** A discadora troca o grupo de quem está livre, depois do atraso. */
  const aplicarTrocaPendente = (ramal) => {
    const desde = estado.trocaPendente[ramal];
    const livre = /livre/i.test(String(estado.status[ramal] || ''));
    if (desde == null || estado.travados.has(String(ramal)) || !livre || Date.now() - desde < atrasoTrocaMs) return;
    delete estado.grupoLogado[ramal];
    delete estado.trocaPendente[ramal];
  };

  const grupoDe = (ramal) => estado.grupos.find((g) => g.ramaisOperadores.map(String).includes(String(ramal)));

  const comandos = {
    listargrupos: () => ({ codStatus: 1, grupos: estado.grupos }),
    listarusuarios: () => ({ codStatus: 1, usuarios: estado.usuarios }),
    listarcampanhas: () => ({ codStatus: 1, campanhas: [{ idCampanha: 1, campanhaDesc: 'ROBOS', ativo: true }] }),
    // /report/ligacoesdetalhadas: uma página só
    ligacoesdetalhadas: () => ({ codStatus: 1, ligacoesDetalhadas: estado.ligacoes, endOfTable: true }),

    statusoperador: ({ ramal }) => {
      aplicarTrocaPendente(ramal);
      const grupo = grupoDe(ramal);
      // Como a Argus real: humano não logado recebe HTTP 500; robô desligado
      // (grupo virtual) responde sucesso com o status "Deslogado".
      const virtual = grupo && grupo.idTipoGrupo !== 1;
      const desc = estado.status[ramal] ?? (virtual ? 'Deslogado' : null);
      if (desc == null) return { httpStatus: 500, codStatus: -1, descStatus: 'Erro interno' };
      return {
        codStatus: 1,
        statusOperador: {
          ramal: String(ramal), descricaoStatus: desc, descricaoPausa: '', idGrupo: estado.grupoLogado[ramal] ?? grupo?.idGrupoUsuario,
        },
      };
    },

    transferiroperadorgrupo: ({ idGrupoUsuarioDestino, ramaisOperadores }) => {
      for (const r of ramaisOperadores) {
        const logadoEm = estado.grupoLogado[r] ?? grupoDe(r)?.idGrupoUsuario;
        if (estado.status[r] != null && logadoEm != null) {
          estado.grupoLogado[r] = logadoEm; // a sessão fica onde está até a discadora trocar
          estado.trocaPendente[r] = Date.now();
        }
        for (const g of estado.grupos) g.ramaisOperadores = g.ramaisOperadores.filter((x) => String(x) !== String(r));
        estado.grupos.find((g) => g.idGrupoUsuario === idGrupoUsuarioDestino).ramaisOperadores.push(String(r));
      }
      return {
        codStatus: 1, qtdeTransferidos: ramaisOperadores.length, qtdeFalhas: 0,
        operadores: ramaisOperadores.map((ramal) => ({ ramal, codStatus: 1, descStatus: 'ok' })),
      };
    },

    deslogaroperador: ({ ramal }) => {
      estado.status[ramal] = null;
      delete estado.grupoLogado[ramal]; // ao logar de novo, cai no grupo vinculado
      delete estado.trocaPendente[ramal];
      return { codStatus: 1, descStatus: 'Deslogado' };
    },

    // Humano: loga (ou reloga) no grupo vinculado, como o "deslogar e logar" do operador.
    logaroperador: ({ ramal }) => {
      delete estado.grupoLogado[ramal];
      delete estado.trocaPendente[ramal];
      if (estado.status[ramal] == null) estado.status[ramal] = 'livre';
      return { codStatus: 1, descStatus: 'Operador logado' };
    },

    // Mailing: /apiargus/{hashSkill}/novo e /excluir
    novo: (lead) => {
      estado.leads.push(lead);
      return { codStatus: 1, descStatus: 'Lead incluído', nrLead: estado.leads.length, idLote: 1 };
    },

    excluir: ({ codCliente }) => {
      const antes = estado.leads.length;
      estado.leads = estado.leads.filter((l) => l.codCliente !== codCliente);
      return { items: [], count: antes - estado.leads.length };
    },

    // Um robô ("ramal") ou todos os do grupo ("idGrupoUsuario").
    logaroperadorvirtual: ({ ramal, idGrupoUsuario }) => {
      const ramais = ramal ? [ramal] : estado.grupos.find((g) => g.idGrupoUsuario === idGrupoUsuario)?.ramaisOperadores ?? [];
      for (const r of ramais) estado.status[r] = 'livre';
      return { codStatus: 1, qtdeLogados: ramais.length, qtdeFalhas: 0 };
    },
  };

  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const segmentos = req.url.split('?')[0].split('/');
      const nome = segmentos.pop();
      const dados = corpo ? JSON.parse(corpo) : {};
      const skill = segmentos.pop(); // "cmd" nos comandos; o hash da skill no mailing
      if (!['statusoperador', 'listargrupos', 'listarusuarios'].includes(nome)) estado.chamadas.push({ em: Date.now(), comando: nome, skill, dados });

      if (estado.responderComStatusHttp) {
        res.writeHead(estado.responderComStatusHttp).end('{}');
        return;
      }
      const fn = comandos[nome];
      const { httpStatus = fn ? 200 : 404, ...resposta } = fn ? fn(dados) : { codStatus: -1, descStatus: 'comando desconhecido' };
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resposta));
    });
  });

  return new Promise((resolve) => {
    servidor.listen(0, () => resolve({
      url: `http://127.0.0.1:${servidor.address().port}/apiargus/cmd`,
      estado,
      definirStatus: (ramal, desc) => { estado.status[ramal] = desc; },
      fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }),
    }));
  });
}

module.exports = { criarArgusFake };

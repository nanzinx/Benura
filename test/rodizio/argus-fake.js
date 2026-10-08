'use strict';
/**
 * Argus falsa por HTTP para os cenários do rodízio (argus-automacao).
 *
 * Mantém grupos e status de operadores em memória, registra cada comando
 * recebido e permite que o teste altere status no meio da execução.
 */

const http = require('http');

/**
 * @param {object} opcoes
 * @param {Array<{ idGrupoUsuario, idTipoGrupo, ramaisOperadores }>} opcoes.grupos
 * @param {Record<string, string|null>} opcoes.status - ramal → descricaoStatus (null = offline)
 */
function criarArgusFake({ grupos, status }) {
  const estado = {
    grupos: structuredClone(grupos),
    status: { ...status },
    chamadas: [],
    leads: [],
    responderComStatusHttp: null, // ex.: 403 para simular token inválido
  };

  const grupoDe = (ramal) => estado.grupos.find((g) => g.ramaisOperadores.map(String).includes(String(ramal)));

  const comandos = {
    listargrupos: () => ({ codStatus: 1, grupos: estado.grupos }),

    statusoperador: ({ ramal }) => {
      const desc = estado.status[ramal];
      if (desc == null) return { codStatus: 0, descStatus: 'Operador não está logado' };
      return {
        codStatus: 1,
        statusOperador: { ramal: String(ramal), descricaoStatus: desc, descricaoPausa: '', idGrupo: grupoDe(ramal)?.idGrupoUsuario },
      };
    },

    transferiroperadorgrupo: ({ idGrupoUsuarioDestino, ramaisOperadores }) => {
      for (const r of ramaisOperadores) {
        for (const g of estado.grupos) g.ramaisOperadores = g.ramaisOperadores.filter((x) => String(x) !== String(r));
        estado.grupos.find((g) => g.idGrupoUsuario === idGrupoUsuarioDestino).ramaisOperadores.push(String(r));
      }
      return {
        codStatus: 1, qtdeTransferidos: ramaisOperadores.length, qtdeFalhas: 0,
        operadores: ramaisOperadores.map((ramal) => ({ ramal, codStatus: 1, descStatus: 'ok' })),
      };
    },

    deslogaroperador: () => ({ codStatus: 1, descStatus: 'Deslogado' }),

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

    logaroperadorvirtual: ({ idGrupoUsuario }) => {
      const qtde = estado.grupos.find((g) => g.idGrupoUsuario === idGrupoUsuario)?.ramaisOperadores.length ?? 0;
      return { codStatus: 1, qtdeLogados: qtde, qtdeFalhas: 0 };
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
      if (nome !== 'statusoperador' && nome !== 'listargrupos') estado.chamadas.push({ em: Date.now(), comando: nome, skill, dados });

      if (estado.responderComStatusHttp) {
        res.writeHead(estado.responderComStatusHttp).end('{}');
        return;
      }
      const fn = comandos[nome];
      res.writeHead(fn ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fn ? fn(dados) : { codStatus: -1, descStatus: 'comando desconhecido' }));
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

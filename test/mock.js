const http = require('http');

let grupos = [
  { idGrupoUsuario: 1, idTipoGrupo: 1, ramaisOperadores: [100, 101] }, // Ativo
  { idGrupoUsuario: 2, idTipoGrupo: 1, ramaisOperadores: [] }, // URA
  { idGrupoUsuario: 3, idTipoGrupo: 3, ramaisOperadores: [900, 901] }, // Robos
];

const statusOperador = {
  100: { descricaoStatus: 'Livre', tempoStatus: 5000, idGrupo: 1 },
  101: { descricaoStatus: 'Em Atendimento', tempoStatus: 10000, idGrupo: 1 },
  900: { descricaoStatus: 'Livre', tempoStatus: 0, idGrupo: 3 },
  901: { descricaoStatus: 'Livre', tempoStatus: 0, idGrupo: 3 },
};

http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const data = body ? JSON.parse(body) : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    
    if (req.url.endsWith('listargrupos')) {
      return res.end(JSON.stringify({ codStatus: 1, grupos }));
    }
    if (req.url.endsWith('statusoperador')) {
      const s = statusOperador[data.ramal];
      if (s) return res.end(JSON.stringify({ codStatus: 1, statusOperador: s }));
      return res.end(JSON.stringify({ codStatus: -1, descStatus: 'Not found' }));
    }
    if (req.url.endsWith('transferiroperadorgrupo')) {
      return res.end(JSON.stringify({ codStatus: 1, qtdeTransferidos: 1 }));
    }
    if (req.url.endsWith('deslogaroperador')) {
      return res.end(JSON.stringify({ codStatus: 1, descStatus: 'Já deslogado do sistema' }));
    }
    if (req.url.endsWith('logaroperadorvirtual')) {
      return res.end(JSON.stringify({ codStatus: 1, qtdeLogados: 2, qtdeFalhas: 0 }));
    }
    
    res.end(JSON.stringify({ codStatus: -1, descStatus: 'Endpoint mock não encontrado' }));
  });
}).listen(8080, () => console.log('Mock rodando em http://localhost:8080'));

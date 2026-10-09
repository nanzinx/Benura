'use strict';
/**
 * Vanguard falso por HTTP para testar o robô da esteira: login, tela da esteira
 * com os mesmos ids do sistema real (#tipodata, #data_inicial, #etapa,
 * #cod_equipe, enviarfiltro, "Extrair Excel") e o download do Excel em CSV.
 */

const http = require('http');

const LOGIN = `<!doctype html><form method="post" action="/login">
  <input id="exten" name="exten"><input id="password" name="password" type="password">
  <button id="button-sigin" type="submit">Entrar</button></form>`;

const opcoes = (lista) => lista.map((o) => `<option>${o}</option>`).join('');

const ESTEIRA = (filtrado) => `<!doctype html><form method="post" action="/index.php/esteira">
  <select id="tipodata" name="tipodata">${opcoes(['Data Cadastro', 'Data Pagamento', 'Data Reprovação'])}</select>
  <input id="data_inicial" name="data_inicial" value="01/01/2026"><input id="data_final" name="data_final" value="31/01/2026">
  <select id="etapa" name="etapa" multiple>${opcoes(['Andamento', 'Pendente', 'Pago', 'Reprovado'])}</select>
  <select id="status" name="status" multiple>${opcoes(['X', 'TAXA BAIXA', 'CLIENTE COM  AÇÃO JUDICIAL'])}</select>
  <select id="cod_equipe" name="cod_equipe" multiple>${opcoes(['AMANDA', 'MAYSA'])}</select>
  <button name="enviarfiltro" type="submit">Filtrar</button></form>
  ${filtrado ? '<button data-original-title="Extrair Excel" onclick="location.href=\'/index.php/esteira/excel\'">Excel</button>' : ''}`;

/**
 * @param {{ usuario: string, senha: string, registros: Array<{ Codigo, Status, Nome, Beneficio, Etapa }> }} opcoesFake
 */
function criarVanguardFake({ usuario, senha, registros }) {
  const estado = { filtros: [], logins: 0, logouts: 0 };
  let filtroAtual = null;

  const lerCorpo = (req) => new Promise((r) => {
    let c = '';
    req.on('data', (d) => { c += d; });
    req.on('end', () => r(new URLSearchParams(c)));
  });
  const html = (res, corpo, extra = {}) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extra }).end(corpo);
  const logado = (req) => /sess=ok/.test(req.headers.cookie || '');

  const rotas = {
    'GET /': (req, res) => html(res, LOGIN),
    'POST /login': async (req, res) => {
      const p = await lerCorpo(req);
      if (p.get('exten') !== usuario || p.get('password') !== senha) return html(res, LOGIN);
      estado.logins++;
      return res.writeHead(302, { Location: '/index.php/home', 'Set-Cookie': 'sess=ok; Path=/' }).end();
    },
    'GET /index.php/home': (req, res) => html(res, '<!doctype html><p>Início</p>'),
    'GET /index.php/esteira': (req, res) => html(res, ESTEIRA(false)),
    'POST /index.php/esteira': async (req, res) => {
      const p = await lerCorpo(req);
      filtroAtual = {
        tipodata: p.get('tipodata'), inicial: p.get('data_inicial'), final: p.get('data_final'),
        etapas: p.getAll('etapa'), status: p.getAll('status'), equipes: p.getAll('cod_equipe'),
      };
      estado.filtros.push(filtroAtual);
      html(res, ESTEIRA(true));
    },
    'GET /index.php/esteira/excel': (req, res) => {
      const etapas = filtroAtual?.etapas || [];
      const status = filtroAtual?.status || [];
      const linhas = registros.filter((r) => (!etapas.length || etapas.includes(r.Etapa)) && (!status.length || status.includes(r.Status)));
      const csv = ['Codigo;Status;Nome;Beneficio;Etapa', ...linhas.map((r) => [r.Codigo, r.Status, r.Nome, r.Beneficio, r.Etapa].join(';'))].join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="esteira.csv"' }).end(csv);
    },
    'GET /index.php/auth/logout': (req, res) => {
      estado.logouts++;
      html(res, LOGIN, { 'Set-Cookie': 'sess=; Path=/; Max-Age=0' });
    },
  };

  const servidor = http.createServer((req, res) => {
    const caminho = req.url.split('?')[0];
    const chave = `${req.method} ${caminho}`;
    const precisaLogin = caminho.startsWith('/index.php') && !logado(req);
    if (precisaLogin) return res.writeHead(302, { Location: '/' }).end();
    const rota = rotas[chave];
    if (!rota) return res.writeHead(404).end();
    return rota(req, res);
  });

  return new Promise((resolve) => {
    servidor.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${servidor.address().port}`,
      estado,
      fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }),
    }));
  });
}

/** Navegador para os testes: o Chromium deste ambiente, ou o Chrome instalado (CI). */
function navegadorDeTeste() {
  const fs = require('fs');
  const candidato = process.env.BENURA_TESTE_CHROME || '/opt/pw-browsers/chromium';
  if (fs.existsSync(candidato)) return { executavel: candidato, headless: true };
  return { canal: 'chrome', headless: true };
}

module.exports = { criarVanguardFake, navegadorDeTeste };

// Réplica local do Projudi TJPR para teste E2E da extensão.
// Estrutura fiel: frameset → mainFrame → iframe name="userMainFrame" → telas.
// CSP: inline permitido, eval BLOQUEADO (hipótese da causa raiz v0.8.1).
const https = require('https');
const fs = require('fs');
const path = require('path');

const PAGES = path.join(__dirname, 'pages');
const CSP = "script-src 'self' 'unsafe-inline'; object-src 'none'";

const server = https.createServer({
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
}, (req, res) => {
  const u = new URL(req.url, 'https://x');
  let file = null;
  if (u.pathname === '/' || u.pathname === '/projudi/') file = 'frameset.html';
  else if (u.pathname === '/projudi/juntar.do') file = 'juntar.html';
  else if (u.pathname === '/projudi/processo/tipoDocumento.do') file = 'tipoDocumento.html';
  else if (u.pathname === '/projudi/prelogin') file = 'prelogin-frameset.html';
  else if (u.pathname === '/projudi/prelogin-conteudo') file = 'prelogin.html';
  else file = u.pathname.split('/').pop();
  const p = path.join(PAGES, file);
  if (!fs.existsSync(p)) { res.writeHead(404); res.end('404 ' + u.pathname); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
  res.end(fs.readFileSync(p));
});
server.listen(443, () => console.log('projudi-replica em https://127.0.0.1:443'));

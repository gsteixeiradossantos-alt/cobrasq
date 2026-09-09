# Testbed E2E — réplica local do Projudi TJPR

Reproduz a estrutura real (frameset → mainFrame → iframe `userMainFrame`,
janela da lupa via Prototype Window com iframe `tipoDocumento.do`, árvore de
tipos por AJAX atrasado, botão `#selectButton`) para testar a extensão de
ponta a ponta SEM acesso ao Projudi real.

Foi este laboratório que encontrou a causa raiz v0.8.2: `world:'MAIN'` dentro
do `target` de `chrome.scripting.executeScript` — a API rejeitava a chamada e
NENHUMA função da página rodava (lupa, Selecionar, cartão pré-login).

## Rodar
```bash
cd extension/testbed
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes \
  -subj "/CN=projudi.tjpr.jus.br" -addext "subjectAltName=DNS:projudi.tjpr.jus.br"
node server.js &          # https://projudi.tjpr.jus.br mapeado p/ 127.0.0.1
env -u HTTPS_PROXY -u HTTP_PROXY node run.js   # precisa de playwright + chromium
```
Esperado: `CENÁRIO A … SUCESSO: hid=58` e `CENÁRIO B … SUCESSO`.

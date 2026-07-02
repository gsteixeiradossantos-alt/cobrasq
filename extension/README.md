# Cobrasq · Peticionador eproc TJPR (extensão Chrome)

Extensão MV3 que **auto-preenche o peticionamento no eproc TJPR** a partir das petições
preparadas no app Cobrasq e **para no botão "Protocolar"** para revisão humana (o ato
processual continua sendo do advogado). Faz parte da **Fase 2** do plano eproc.

## Por que extensão (e não bot na nuvem)

O eproc exige login + MFA e não tem API de peticionamento. A extensão roda **na sessão real
do advogado** (ele loga e resolve o MFA), no **IP dele** — então **não guardamos senha nem a
semente do MFA** e o risco de bloqueio é o menor possível. Ver
`docs/specs/eproc-tjpr-integracao-viabilidade.md` e o plano.

> ⚠️ **ToS:** o eproc desencoraja automação externa. Esta extensão mitiga (sessão/IP reais +
> confirmação humana antes de protocolar), mas o risco residual é decisão do advogado.

## Como funciona (fluxo)

1. No app, **Intimações → ＋ Preparar peticionamento**: anexe o PDF, informe tipo/evento e,
   no **inicial**, escolha o **caso** + Comarca/Classe/Assuntos. Cria um job
   `proc_peticionamentos` (status `preparado`; no inicial vai junto o `dados_distribuicao`).
2. Abra o **app logado** numa aba (a extensão lê o token de sessão — nunca a senha) e o
   **eproc** noutra aba.
3. Ícone da extensão → **Buscar petições preparadas** → **Preencher no eproc**.

### Intercorrente (tela única)
A extensão seleciona o **Tipo de Documento**, **anexa o PDF** e **destaca o botão**
(Peticionar/Confirmar). Você revisa e clica; cola o nº no painel → **Confirmar**.

### Inicial / Distribuição (assistente de 5 etapas) — motor multi-etapas
A extensão **detecta a etapa visível** (1 Informações → 2 Assuntos → 3 Requerentes →
4 Requeridos → 5 Documentos) e **preenche os campos daquela etapa** a partir do
`dados_distribuicao`. Ela **destaca "Próxima"** (ou "Finalizar" na etapa 5) mas **nunca
clica** — você revisa e avança; ao carregar a próxima etapa, ela preenche sozinha (o job
ativo fica em `chrome.storage.local` até Finalizar ou "Parar assistente"). Na etapa 5,
cola o nº gerado → **Confirmar**. Autocompletes (Comarca/Classe/Assunto) e o ciclo de
Partes (Consultar→Salvar→Incluir) são destacados para conferência/entrada manual.

5. O resultado volta para o app (`status='protocolado'`, `protocolo_num`).

## Instalar (modo desenvolvedor)

1. `chrome://extensions` → ativar **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecionar a pasta `extension/`.
3. Fixar o ícone na barra.

## ⚠️ Seletores do eproc (calibrados pelos manuais; refinar no DOM real)

`selectors.js` foi **calibrado a partir dos manuais oficiais "Eproc para Advogado"**
(TJPR, out/2025): usa os **rótulos e textos de botão reais** e cobre os dois fluxos —
**inicial/Distribuição** (assistente de 5 etapas, avanço por **"Próxima"**, final em
**"Finalizar"**) e **intercorrente** (juntar documento em processo existente: **"Tipo de
Documento"** → **"Anexar Documento"** → **"Peticionar"/"Confirmar"**). O `content-eproc.js`
tem fallback por rótulo (`byLabel`) e por texto de botão (`acharBotao`).

Os manuais dão rótulos/fluxo, **não** os ids/names exatos do DOM. Então no primeiro uso real
(logado, F12) confira e, se necessário, refine as listas de candidatos: `tipoDocumento`,
`parte`, `anexoPdf`, `botaoAvancar`, `botaoFinal`. Em etapa intermediária do assistente a
extensão preenche o que dá e avisa para avançar via **"Próxima"** até a etapa de documentos.

## Arquivos

- `manifest.json` — MV3; permissões e content scripts (app, eproc, supabase).
- `content-app.js` — no app: lê o token de sessão e envia ao background.
- `background.js` — guarda o token (sessão), fala com `/api/eproc-peticionamento`, baixa o PDF.
- `content-eproc.js` — no eproc: preenche o formulário, para no Protocolar, painel de revisão.
- `selectors.js` — **seletores do eproc (ponto frágil — validar)**.
- `popup.html` / `popup.js` — lista os jobs e dispara o preenchimento.

## Dependências no servidor (Gustavo)

- Aplicar a migration `supabase/migrations/2026-06-23b_peticionamentos.sql`.
- Deploy da edge function `gerar-peticao-pdf` (opcional — só se for gerar o PDF a partir de
  petição montada no app; o fluxo atual aceita upload de PDF pronto). Reusa `GOTENBERG_URL`.
- O endpoint `/api/eproc-peticionamento` já sobe junto com o app (Vercel).

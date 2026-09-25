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
- `content-projudi.js` — no Projudi TJPR: motor completo (ver seção própria abaixo).
- `content-pje.js` — no PJe: **só detecção + botão de captura de tela, ainda sem preencher
  nada** (ver § PJe abaixo).
- `selectors.js` — **seletores do eproc (ponto frágil — validar)**.
- `popup.html` / `popup.js` — lista os jobs e dispara o preenchimento.

## PJe — em fase de calibração (sem automação ainda)

`content-pje.js` roda em domínios `pje*.<algo>.jus.br` (ex.: `pje.tjmt.jus.br`,
`pje1g.trf1.jus.br`) e **não preenche nem clica em nada** — só mostra um painel avisando
que a automação ainda não existe e injeta o botão **📋 HTML (PJe)** para capturar a tela.

Tribunais em PJe usados pelo Gustavo (levantado em 2026-09-19): **TJMT**, **TRF** (Justiça
Federal) e mais algum TJ estadual em PJe (a confirmar qual). Calibração escolhida: **com
capturas reais** (mesmo caminho que funcionou para o Projudi — nunca escrever seletor
"no escuro" contra manual, porque protocolo é irreversível).

Para avançar, precisamos — por tela, com print + o HTML do botão 📋 — de: (1) busca do
processo, (2) petição intercorrente (juntar documento em processo existente), (3) petição
inicial/distribuição (se usada), (4) seleção de tipo de documento, (5) upload de arquivo,
(6) confirmação de protocolo/tela de sucesso. Cada uma vira um `telaX()` em
`content-pje.js`, no mesmo padrão fail-closed do Projudi (confere o número do processo na
tela antes de agir, pausa quando não reconhece, nunca clica no botão final sozinho sem o
toggle de auto-conclusão).

## Dependências no servidor (Gustavo)

- Aplicar a migration `supabase/migrations/2026-06-23b_peticionamentos.sql`.
- Deploy da edge function `gerar-peticao-pdf` (opcional — só se for gerar o PDF a partir de
  petição montada no app; o fluxo atual aceita upload de PDF pronto). Reusa `GOTENBERG_URL`.
- O endpoint `/api/eproc-peticionamento` já sobe junto com o app (Vercel).

## Intercorrentes Projudi — vários arquivos no mesmo processo

PDFs soltos com o mesmo CNJ no nome viram **uma** juntada. A ordem é a do nome
(ordenação numérica), então numere logo depois do CNJ — o 1º é o principal e dá o
tipo do movimento:

    0001220-30.2024.8.16.0209_1_Manifestacao.pdf   ← principal, movimento "Manifestação"
    0001220-30.2024.8.16.0209_2_Calculo.pdf
    0001220-30.2024.8.16.0209_3_Comprovante.pdf

Número depois do tipo (`_Manifestacao_1`, `_Anexo_2`) ordena errado. O tipo continua
editável em "Tipo da petição" na revisão. (Até a v0.10.27 o grupo saía com movimento
"Documentos"; corrigido na v0.10.28.)

## Pendências / ideias futuras (não fazer sem revisar com o Gustavo)

- ~~Sondagem mais rápida em `esperar()`~~ — **feito na v0.10.27**: o passo padrão caiu de
  300ms para 150ms (`passoMs || 150`) em content-projudi.js e content-eproc.js. Os
  `setTimeout` fixos de "deixa assentar" (400-900ms) **não** foram tocados — cada um responde
  a um bug de corrida já reportado (falso sucesso, clique no vazio, tipo de documento errado).

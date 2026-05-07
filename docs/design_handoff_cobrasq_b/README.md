# Handoff: COBRASQ — Redesign B (Operacional Moderno)

## Overview

Redesign completo das **telas internas** do app de gestão da COBRASQ (recuperadora de crédito): Login + 7 telas autenticadas (Painel, Devedores, Processos, ficha do Devedor em modal, Financeiro, Relatórios, WhatsApp).

A direção é **"Operacional Moderno"** — SaaS contemporâneo denso e produtivo no espírito de Linear / Notion / Attio. Sidebar clara, navy de acento, números em monoespaçada. Foi pensada para uso diário intensivo da equipe interna.

## About the Design Files

Os arquivos em `reference/` são **referências de design feitas em HTML+React (Babel inline)** — protótipos mostrando a aparência e o comportamento pretendidos, **não código de produção para copiar diretamente**.

A tarefa é **recriar esses designs no codebase atual** (`gsteixeiradossantos-alt/cobrasq-faturamento`), que é um front-end estático em **HTML/CSS/JS vanilla** servido como SPA pela Vercel, com Serverless Functions Node.js em `/api/*`. Não há bundler, não há React rodando em produção — então traduza o JSX dos arquivos de referência para HTML/CSS/JS puro, mantendo a arquitetura existente.

## Fidelity

**Pixel-perfect (alta fidelidade).** Todos os hex, tamanhos de fonte, pesos, paddings, raios de borda e espaçamentos nos arquivos JSX são os valores finais — copie-os literalmente. Os screenshots em `screenshots/` mostram o resultado visual esperado.

## Stack do projeto-alvo

- Front: `index.html` na raiz + CSS/JS vanilla. SPA via rewrite no `vercel.json` (`"/((?!api/).*)" → "/index.html"`).
- Backend: Vercel Serverless Functions em `/api/*.js` (Node 20–24). Handlers existentes: `asaas.js`, `config.js`, `cron-regua.js`, `mfa.js`, `zapi.js`, `zapsign.js`.
- Build: nenhum (Framework Preset = Other, sem build command). Deploy = push na `main`.
- Local dev: `vercel dev`.

**Implicações para o redesign:**
- Sem JSX/React. Componentes viram funções que retornam strings HTML, ou módulos JS que manipulam o DOM diretamente.
- Sem CSS-in-JS. Todos os `style={{...}}` dos JSX devem virar classes CSS num `styles.css` (ou `<style>` no `index.html`), usando custom properties para os tokens.
- Fontes: usar `<link>` para Google Fonts no `<head>` do `index.html`.

## Design Tokens (copiar exato)

### Cores
```css
:root {
  /* Surfaces */
  --bg:        #FAFAFA;
  --surface:   #FFFFFF;
  --surface-2: #F5F5F5;

  /* Brand */
  --navy:       #002060;
  --navy-hover: #001A4D;
  --gold:       #FABE44;
  --gold-dark:  #E0A820;

  /* Text */
  --text:   #0B0F19;
  --text-2: #525866;
  --text-3: #868F9E;
  --text-4: #B8BEC8;

  /* Lines */
  --border:   #EAECEF;
  --border-2: #D9DCE0;

  /* Status */
  --green: #0E9F6E;
  --red:   #DC2626;
  --amber: #D97706;
  --blue:  #2563EB;

  /* Tints (status pills, highlight rows) */
  --green-bg:  #E8F7F0;
  --amber-bg:  #FEF3C7;
  --red-bg:    #FEE2E2;
  --navy-bg:   #EAF0FB;
  --navy-bd:   #C8D6F0;
  --neutral-bg:#F1F2F4;
}
```

### Tipografia
```css
--font-ui:   'Inter', system-ui, -apple-system, sans-serif;
--font-mono: 'JetBrains Mono', ui-monospace, monospace;
```
Carregar do Google Fonts: `Inter:400;500;600;700` + `JetBrains Mono:400;500;600`.

**Regra geral:** Inter para tudo. JetBrains Mono **apenas** para: valores monetários, datas, CPF/CNPJ, números de processo, contadores ("1–8 de 1.247"), labels de eixo de gráfico, atalhos de teclado (`⌘K`), selo de versão (`v4.2.1`), timestamps em chat.

### Espaçamento e raios
- Border-radius: `4px` (chips, pills, badges) · `6px` (botões, inputs, cards pequenos) · `8px` (cards grandes, tabela) · `10–12px` (modal, painel destacado).
- Padding interno de cards: `14–18px`.
- Gap entre cards no grid: `10–14px`.
- Sidebar: largura **232px**.
- Header (top bar): altura **52px**.
- Conteúdo principal: padding **22px 24px**.

### Sombras
- Modal: `0 32px 80px rgba(0,32,96,0.18)`.
- Toolbar de seleção (sticky bottom): `0 8px 24px rgba(0,0,0,.18)`.
- Active tab segmented: `0 1px 2px rgba(0,0,0,.06)`.
- Cards normais: **sem sombra** — só borda `1px solid var(--border)`.

## Estrutura geral (Shell)

Toda tela autenticada compartilha um shell com 3 zonas (ver `reference/direction-b.jsx` → `function ShellB`):

```
┌────────────┬──────────────────────────────────────────┐
│  Sidebar   │  Header (breadcrumb · top actions · 🔔)  │
│  232px     ├──────────────────────────────────────────┤
│            │                                          │
│  Logo      │                                          │
│  Search    │           Conteúdo (scroll)              │
│  Nav       │                                          │
│  ────      │                                          │
│  User      │                                          │
└────────────┴──────────────────────────────────────────┘
```

**Sidebar** (`background:#fff`, `border-right:1px solid var(--border)`):
- Header com logo (quadrado 28×28 navy com "C" dourado), nome COBRASQ, badge de versão `4.2`.
- Busca cinza-claro com ícone lupa + atalho `⌘K` à direita.
- Nav agrupada (3 grupos: Principal, Financeiro, Comunicação, Sistema). Item ativo: fundo `--navy-bg` + texto `--navy`. Hover: nada (só cursor).
- Item "Painel" tem badge "14" (notifs). "WhatsApp" tem dot verde indicando online.
- Footer da sidebar: avatar 30×30 navy + nome "Gabriel T." + ícone de config.

**Header da página** (52px alto, `background:#fff`, `border-bottom`):
- Esquerda: breadcrumb com `/` cinza separando.
- Direita: botões de ação contextuais + divisor + sino de notificações com dot vermelho.

## Telas (em ordem)

> Para cada tela, **abra o JSX correspondente em `reference/direction-b*.jsx` e o screenshot em `screenshots/` lado a lado**. Os JSX têm os valores literais (cores, fontes, paddings); os screenshots mostram o resultado.

### 1. Login — `screenshots/01-login.png`
Componente: `DirBLogin` em `direction-b.jsx`.

Layout split 1440px: **esquerda flexível** (form, fundo claro `--bg` com dot grid sutil) + **direita 560px** (painel navy com mock de dashboard).

Form (largura 400px, centralizado vertical):
- Logo COBRASQ + badge `v4.2.1` (mono).
- Título 26px/700 "Acesse sua plataforma" + subtítulo 14px/--text-2.
- **Segmented control** com 3 perfis (Gestor / Cedente / Devedor) — fundo `--surface-2`, item ativo `--surface` com sombra `0 1px 2px rgba(0,0,0,.06)`. Cada item: título 12.5px/600 + subtítulo 10.5px/--text-3.
- Inputs: `padding:10px 12px`, `border:1px solid --border-2`, `border-radius:6px`.
- Botão primário: navy fill, branco 13.5px/600, com seta `→` à direita.
- Status pill no fim: dot verde + "Todos os sistemas operacionais. Sincronizado · há 12s".

Painel direito (navy):
- Gradient radial: `radial-gradient(circle at 80% 0%, rgba(250,190,68,.18), transparent 50%), radial-gradient(circle at 20% 100%, rgba(250,190,68,.08), transparent 50%)`.
- Pill "Plataforma 4.2 — Maio 2026" com dot dourado.
- Headline 36px/700 "Cobranças que recuperam a sua margem." (última linha em dourado).
- Card glassmorphism (rgba branco 6%) com KPI "Recuperado · Maio · R$ 612.480 · +18,7%" + sparkline dourada.

### 2. Painel — `screenshots/02-painel.png`
Componente: `DirBDashboard`.

Conteúdo:
- Saudação "Boa tarde, Gabriel." + subtítulo com 14 itens que precisam atenção.
- Toggle `[Hoje] [Semana] [Mês] [Trimestre]` à direita (Mês ativo).
- **4 KPIs em grid 4 colunas**: cada card tem label, delta-pill (verde se up, amber se down), valor mono 22px/600, sparkline SVG na base. Dados em `SHARED.kpis`.
- **Grid 1.6fr / 1fr**:
  - Esquerda: gráfico de barras "Recuperação por mês" (12 barras, navy + dourado opaco). Eixo Y mono `0/200k/400k/600k/800k`.
  - Direita: lista "Precisa de atenção" (4 itens com tag colorida URGENTE/ACORDO/CONTATO/PROCESSO).
- **Card "Atividade da equipe"**: tabs Tudo/Acordos/Pagamentos/Comunicação. Linhas com avatar circular colorido + ação + nome em negrito + valor mono + timestamp.

### 3. Devedores — `screenshots/03-devedores.png`
Componente: `DirBDevedores`.

- Top actions: campo busca "Buscar nome, CPF, CNPJ…" + botão Exportar + botão **Novo** (navy primário).
- Título "Devedores" + subtítulo "1.247 registros · R$ 8.420.190 em carteira".
- **Filter chips** (pílulas arredondadas): inativos `--surface`/`--border`; ativos `--navy-bg`/`--navy-bd`/`--navy`. Chip "+ Filtro" com border tracejado.
- **Tabela** (`background:#fff`, border + radius 8):
  - Header com fundo `--surface-2`, colunas: checkbox · Devedor · Documento · Credor · Valor · Status · Prazo · Resp. · ⋯
  - Linhas com avatar quadrado 26×26 `--navy-bg`/`--navy` (iniciais), nome 600 + id mono 11px.
  - Status: pill com dot da cor + bg tinted (use `StatusPillB`).
  - Resp.: avatar circular 24px navy.
- **Footer da tabela**: paginação numerada com botão ativo navy fill.
- **Toolbar de seleção sticky bottom** (aparece quando há linhas selecionadas): fundo `--text` (preto), botões pill brancos translúcidos, botão "Gerar relatório" dourado à direita. Sombra `0 8px 24px rgba(0,0,0,.18)`.

### 4. Processos — `screenshots/04-processos.png`
Componente: `DirBProcessos` em `direction-b-screens.jsx`.

- Phase summary: 7 cards lado a lado (Distribuição/Citação/Contestação/Audiência/Sentença/Recurso/Execução) com contador grande mono. Card ativo = `--navy-bg`/`--navy-bd`.
- Filtros: busca + 3 dropdowns + indicador "Próx. audiência: 08/05 · 14:30" (amber, mono).
- **Cards de processo** (em vez de tabela): grid `auto 1fr auto auto auto` por linha:
  - Coluna 1 (com border-right): label "Nº PROCESSO" uppercase + número mono + vara cinza.
  - Coluna 2: "DEVEDOR" + nome + barra de progresso de 7 fases. Cada fase é um pílula (4×16px) — `--navy` se já passou, `--border` se não. Fase atual destaca: 6×28px. Texto "Fase atual: <bold navy>".
  - Coluna 3: "VALOR" mono 14px/600.
  - Coluna 4: "PRÓXIMO ATO" — data mono. Amber se próxima.
  - Botão `›` chevron à direita.

### 5. Modal Devedor (ficha) — `screenshots/05-modal-devedor.png`
Componente: `DirBModalDevedor`.

Modal 1200×800 sobre overlay `rgba(11,15,25,0.5)`. Sombra `0 32px 80px rgba(0,32,96,0.18)`.

Header (px 28, py 20):
- Avatar 56×56 `--navy-bg`/`--navy` "RA" + nome 22px/700 + badge id mono + status pill verde "Em acordo".
- Linha de metadados: CPF · Tel · Cliente desde · Resp. (cada campo: label cinza + valor em negrito; valores mono onde aplicável).
- Lado direito: botão Editar (secundário) + **Registrar pagamento** (verde fill primário) + ✕.
- **Tabs** abaixo: Resumo / Histórico (24) / Acordos (2) / Documentos / Comunicação / Auditoria. Tab ativa: borda inferior 2px navy + texto navy.

Body grid `1fr 320px`:
- **Esquerda (scroll)**:
  - 4 stat cards: Dívida total / Pago / Saldo restante (highlight `--navy-bg`) / Próximo venc. (amber).
  - Card "Acordo #A-0184 · Parcelado em 10x": header + grid de 10 parcelas (3 estados — PAGO verde, PRÓX. amber, futuras cinza), cada parcela mostra nº, valor mono, data mono.
  - **Timeline** vertical com linha cinza vertical e dots coloridos por tipo (PAGAMENTO verde, COMUNICAÇÃO azul, ACORDO navy, CONTATO amber, NOTIFICAÇÃO cinza). Cada item: tag uppercase 9.5px/700 letterspacing .08em + descrição + autor + timestamp mono + valor mono à direita (se houver).
- **Direita** (`background:--surface-2`, border-left):
  - "AÇÕES RÁPIDAS" — 5 botões com ícone (WhatsApp / Boleto / Contato / Minuta / Histórico).
  - "CREDOR" — card com logo navy/gold "BA" + "Banco Atlas · Cedente · 184 contratos".
  - "ETIQUETAS" — chips: Boa-fé, Prioritário, PJ, SP capital, + Add (border tracejado).
  - "SCORE INTERNO" — número grande mono "78" verde + "/100" + barra gradiente amber→verde + descrição.

### 6. Financeiro — `screenshots/06-financeiro.png`
Componente: `DirBFinanceiro`.

- Top actions: seletor de mês "Maio 2026 ▾" + Novo lançamento (navy).
- **3 cards de conta bancária** (Itaú PJ laranja / Bradesco vermelho / Caixa azul, cada um cinza-claro se sem movimento): logo 40×40 colorido + nome banco + ag/conta mono + saldo mono 16px + delta do dia.
- **4 cards de resumo do mês**: Entradas verde / Saídas vermelho / Saldo / A receber amber. Mono 18px/600.
- **Tabela de lançamentos** com tabs Tudo/Entradas/Saídas/Honorários/Operacional. Colunas: data mono 60px / descrição / categoria (chip) / conta / valor mono à direita (verde se positivo, neutro se negativo). Sinal de + ou − antes do R$.

### 7. Relatórios — `screenshots/07-relatorios.png`
Componente: `DirBRelatorios`.

- Top actions: seletor de período "Últimos 6 meses ▾" + Exportar PDF (navy).
- Tabs do relatório (segmentadas): Performance (ativo, navy) / Por credor / Por responsável / Aging.
- **Card big chart** "Taxa de recuperação":
  - Legenda: Taxa atual (linha navy sólida) · Meta 8% (linha cinza tracejada) · Mercado (linha dourada).
  - SVG line chart 800×240 com grid horizontal cinza, eixo Y % (mono), linhas: navy (área 10%), gold (área 15%) sobre fundo branco. Pontos navy raio 3.5px nos breakpoints.
- **Grid 1fr/1fr abaixo**:
  - "Recuperação por responsável": para cada pessoa — avatar circular navy + nome + barra horizontal (verde >70, amber >50, vermelho ≤50) + valor mono + nº acordos + percentual mono na cor da barra.
  - "Aging da carteira": 6 faixas (0–30, 31–60, 61–90, 91–180, 181–360, >360). Cada uma: label + valor mono + % + barra horizontal colorida (verde→azul→amber→laranja→vermelho→bordô).

### 8. WhatsApp — `screenshots/08-whatsapp.png`
Componente: `DirBWhatsApp`.

- Top actions: indicador "WhatsApp Business · +55 (11) 4002-8922" com dot verde + Nova conversa (navy).
- **Layout 3 colunas** (`280px 1fr 280px`) dentro de um card único `border-radius:8` `border:1px solid`:

**Coluna 1 — Lista de conversas** (border-right):
- Busca no topo.
- Cada item (12px 14px): avatar circular 36 (navy se ativa, cinza se não) + bloco com nome (700 se unread, 600 normal) + last-msg truncada + timestamp mono + badge verde circular com contador unread. Item ativo: `--navy-bg` + border-left 3px navy.

**Coluna 2 — Chat** (background WhatsApp paper `#F5F0E8`):
- Header (background branco): avatar + nome + status "online agora" cinza mono + botões 📞/⋯.
- Mensagens (gap 8px, padding 18 24): pill central "Hoje" mono. Bubbles:
  - Suas (`me`): `align-self:flex-end`, fundo `#D9F4D6` (verde claro WhatsApp), border-radius `10px 10px 2px 10px`.
  - Delas (`them`): `align-self:flex-start`, fundo branco, radius `10px 10px 10px 2px`.
  - Box-shadow `0 1px 1px rgba(0,0,0,.05)`. Texto 13px/lh 1.45.
  - Timestamp mono 9.5px no canto inferior direito + `✓✓` se enviada por mim.
  - Anexo PDF: card cinza-claro com badge "PDF" vermelho 32×32 + nome + tamanho mono.
- Composer (background branco):
  - Linha de **templates rápidos** (chips com `⚡`): Lembrete de pagamento / Confirmação de acordo / Boleto / Solicitar contato.
  - Input pill (radius 22): 📎 + campo + botão circular verde 32px com seta de envio.

**Coluna 3 — Contexto do contato** (`background:--surface-2`, border-left, padding 18):
- Avatar 60 navy centralizado + nome + CPF mono.
- Cards de Status (pill verde) / Saldo devedor (mono 18) / próx. parcela.
- "AÇÕES" — 4 botões textuais: Ver ficha completa / Enviar boleto / Registrar pagamento / Gerar minuta.

## Dados (mockados → reais)

Em `reference/shared-data.jsx` há um objeto `SHARED` com mocks (KPIs, devedores, navegação). No projeto real, esses dados virão das Vercel Functions:

- KPIs e atividade: provavelmente derivados de `/api/asaas` (cobranças/pagamentos).
- Devedores e cobranças: `/api/asaas`.
- WhatsApp: `/api/zapi`.
- Documentos/acordos: `/api/zapsign`.
- Régua de cobrança: cron em `/api/cron-regua`.
- MFA: `/api/mfa`.
- Config: `/api/config`.

**Mantenha esses endpoints intocados.** O redesign é puramente de apresentação; substitua os mocks por chamadas `fetch('/api/...')` nos lugares apropriados.

## Interações & comportamento

- **Sidebar nav**: clicar troca a view (SPA já tem rewrite). Item ativo persiste por rota.
- **Filter chips** (Devedores): ativo é toggleable, "×" remove.
- **Tabela Devedores**: checkbox seleciona linhas → mostra toolbar sticky bottom.
- **Tabs** (Modal, Atividade, Financeiro, Relatórios): client-side, sem reload.
- **Modal Devedor**: abre por clique numa linha de Devedores. Fecha por ✕, Esc, ou clique no overlay.
- **Acordos**: cada parcela é clicável → abre detalhe.
- **WhatsApp**: clicar conversa carrega thread. Templates inserem texto no input. Enviar via botão verde ou Enter.
- **Hover states**: linhas de tabela ficam levemente cinza (`--surface-2`); botões ganham fundo um tom mais escuro.
- **Loading**: enquanto busca dados, usar skeletons cinza no formato dos cards/linhas (não inventar spinner colorido).
- **Empty states**: "Nenhum resultado" centralizado, ícone monocromático cinza, copy curta.

## Acessibilidade & responsividade

- Designs são para **viewport ≥1280px** (uso desktop intensivo). Em mobile, considere uma versão simplificada — fora do escopo deste handoff.
- Hit targets mínimos 32×32 (botões da topbar). Inputs 36–40px de altura.
- Foco visível: outline navy 2px ou box-shadow `0 0 0 2px rgba(0,32,96,.2)`.
- Contraste: textos sobre `--bg`/`--surface` usam `--text` ou `--text-2`. Nunca `--text-3` para texto longo (só metadados).

## Files

```
design_handoff_cobrasq_b/
├── README.md                  ← este arquivo
├── reference/
│   ├── Redesign COBRASQ.html  ← entrypoint do protótipo
│   ├── design-canvas.jsx      ← wrapper do canvas (ignorar; só pra visualização lado-a-lado)
│   ├── shared-data.jsx        ← mocks de dados
│   ├── direction-b.jsx        ← Login, Shell, Dashboard, Devedores, StatusPillB
│   └── direction-b-screens.jsx← Processos, Modal Devedor, Financeiro, Relatórios, WhatsApp
└── screenshots/
    ├── 01-login.png
    ├── 02-painel.png
    ├── 03-devedores.png
    ├── 04-processos.png
    ├── 05-modal-devedor.png
    ├── 06-financeiro.png
    ├── 07-relatorios.png
    └── 08-whatsapp.png
```

## Como usar este handoff com Claude Code

1. Coloque a pasta `design_handoff_cobrasq_b/` em `docs/` no repo `cobrasq-faturamento`.
2. Abra Claude Code no repo.
3. Prompt sugerido:
   > "Leia `docs/design_handoff_cobrasq_b/README.md` e os arquivos JSX em `reference/`. Compare com os screenshots em `screenshots/`. O projeto é HTML/CSS/JS vanilla (não tem React em produção). Recrie pixel-perfect as 8 telas no `index.html` + `styles.css` (ou divida em módulos JS conforme a estrutura existente do repo), traduzindo o JSX para HTML+JS puro. Mantenha as Vercel Functions em `/api/*` intactas; substitua apenas os mocks de `shared-data.jsx` pelas chamadas `fetch` aos endpoints já existentes. Use os tokens CSS do README e respeite todas as cores, fontes (Inter + JetBrains Mono via Google Fonts), paddings, border-radius e sombras descritos. Comece pelo Shell + Login, depois Painel, e prossiga na ordem do README."
4. Após cada tela implementada, rode `vercel dev` localmente e compare visualmente com o screenshot correspondente.
5. Push na `main` → deploy automático.

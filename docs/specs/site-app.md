# Specs — Site/App COBRASQ Faturamento

Origem: triagem da Fase E, plano `~/.claude/plans/users-gustavoteixeira-desktop-cloude-pr-composed-hamster.md` (10/05/2026).

Arquivo principal: `index.html` (~14k linhas).

Pontos de referência:
- Modal Cliente: linhas 1524-1580
- Modal Devedor: linhas 1314-1521
- Modal Processo: linhas 2444-2506
- IA Beatriz: linhas 5542-5711
- Status default já é "Cobrar" (linha 5801)
- Tema atual: `--navy:#002060`, `--gold:#FABE44`. Fonts: Inter, JetBrains Mono, Newsreader, Playfair Display

Ordem sugerida: **S1, S4, S8, S9, S11 (quick wins) → S2, S3, S7 (Beatriz) → S5, S12 (rascunho/responsável) → S6, S10, S13 (filiais/integrações)**.

---

## S1 — Status default = "Cobrar"

🟢 spec-pronta (verificar)

Já implementado na linha 5801: `status: isPending ? 'Cobrar' : (...||'Cobrar')`.

Verificação: ao abrir modal "Novo devedor", select já mostra "Cobrar" selecionado (não placeholder vazio). Se já está, marcar como concluído. Caso contrário, setar `value="Cobrar"` como padrão no select.

---

## S2 — Múltiplas dívidas mesmo devedor/cliente

🟢 spec-pronta

### Manual

- Dentro do modal devedor, aba Dívida, botão "**+ Adicionar dívida**" claro e visível.
- Cada dívida é uma linha com: valor original, valor atualizado, vencimento, entrada carteira, título/descrição, status próprio.
- **Persistência:** schema novo `dev_dividas` (id UUID, devedor_id UUID FK, valor_original NUMERIC, valor_atualizado NUMERIC, vencimento DATE, entrada_carteira DATE, descricao TEXT, status TEXT, created_at TIMESTAMPTZ).

### IA Beatriz

- Permitir upload de N documentos no modo `mdevSelectMode('doc')`.
- Prompt atualizado pra retornar `{nome, doc, tel, email, endereco, dividas: [{valorOrig, vencimento, descricao}, ...]}` em vez de campos flat.
- Cada doc pode gerar uma dívida ou IA detecta múltiplas num doc só.

### Listagem

- Devedor mostra "soma de dívidas em aberto" em vez de valor único.

---

## S3 — Caixa-alta + IA pedir valor + obrigatórios

🟢 spec-pronta

### Caixa-alta (title case)

- Aplicar `titleCasePtBR()` na função `mdevDiAplicarExtracted()` (linha ~5680) nos campos: nome, endereço, vara, credor.
- Função: lowercase + capitalize cada palavra exceto preposições (de, da, do, das, dos, e). Manter siglas (UF, CNPJ, etc.).
- Aplicar também no save manual (`onblur` dos inputs nome/endereço).

### IA pede valor primeiro

- Mudar UX da Beatriz pra fluxo em 2 etapas:
  1. Input "valor original/capital sem adicionais" com tooltip explicando.
  2. Upload doc.
- Prompt da IA passa a receber `valorOriginalInformado` como input contextual e usar pra:
  - Validar contra o que extrai do PDF.
  - Corrigir campo `valorOrig` extraído se conflitar (com flag de aviso ao user).

### Obrigatoriedade

Mínimo obrigatório: **nome + doc + valor original + cliente vinculado + telefone + endereço**.

Após análise da IA (ou no save manual), modal valida; campos vazios destacados em vermelho; bloquear botão "Salvar" até preencher. Toast: "Preencha os campos obrigatórios destacados".

---

## S4 — Emojis em devedor → SVG

🟢 spec-pronta

Emojis identificados:
- 📝 (linha 1326) → SVG document
- ✦ (linha 1331) → SVG sparkles (mantém vibe IA)
- 📞 (linha 1365) → SVG phone
- ⚒ (linha 1449) → SVG briefcase ou hammer
- Unicode 127963 (linha 1453, judicial) → SVG scale-balance
- Unicode 128190 (linha 1518, salvar) → SVG save / floppy-disk

### Lint

Estender lint pra varrer todo `index.html` por emojis Unicode:
- Regex: `[\u{1F300}-\u{1FAFF}]` + `[\u{2600}-\u{27BF}]`
- Listar pra revisão. CI falha se emoji aparecer em arquivos protegidos.

---

## S5 — Remover responsável

🟢 spec-pronta

- Remover `mdev-responsavel` do modal devedor (linhas ~1314-1521 do `index.html`).
- Buscar uso de `responsavel` em listagens, filtros, relatórios — remover ou substituir por `owner_id` do Supabase (metadata de criação, não responsável de negócio).
- Migração: coluna `responsavel` em `devedores` fica órfã. Drop column após confirmar que nada usa (1 release de gracious deprecation).
- Modal cliente: já não tem campo responsável. Manter assim.

---

## S6 — Empresas com filiais

🔴 feature-grande

### Schema clientes

- Adicionar `cliente_grupo_id UUID NULL` (auto-referência).
- Adicionar `eh_matriz BOOLEAN default false`.
- Matriz tem `cliente_grupo_id = self.id`. Filiais apontam pra matriz.

### Schema users

- Adicionar `pode_ver_grupo BOOLEAN default false`.
- Adicionar `cliente_grupo_id UUID NULL`.
- Quando `pode_ver_grupo=true`, RLS permite leitura/escrita de todos os clientes/devedores cujo `cliente.cliente_grupo_id = user.cliente_grupo_id`.

### UI modal cliente

Dropdown "Vínculo grupo":
- "Independente" (default)
- "Matriz (cria novo grupo)"
- "Filial de [matriz X]"

### UI sidebar

Quando user tem `pode_ver_grupo=true`, sidebar mostra seletor: "Visualizar como: [matriz | filial X | filial Y | todos]".

### Devedores/cobranças

Filtros respeitam o seletor de visualização. Listagens automaticamente expandidas pra grupo se gestor estiver em "todos".

### Migração

- Clientes existentes ficam todos como "Independente".
- Operadores existentes ficam com `pode_ver_grupo=false`.
- Gustavo vira gestor do grupo "COBRASQ" (todos os clientes atuais sob a mesma matriz lógica).

---

## S7 — Cadastro empresa via cartão CNPJ (IA)

🟢 spec-pronta

Botão "Via Documento · IA" no modal cliente, similar ao do devedor.

Prompt enviado pra Claude API: extrair `{razao_social, nome_fantasia, cnpj, endereco, telefone, email}` do documento (cartão CNPJ ou contrato social).

Adicionar campo `nome_fantasia` ao modal cliente:
- Input opcional ao lado de "Nome / Razão Social".
- "Nome / Razão Social" passa a ser explicitamente "Razão Social".

Schema: adicionar `nome_fantasia TEXT NULL` em `clientes`.

---

## S8 — Endereço separado em campos

🟢 spec-pronta

Substituir campo único de endereço (modal devedor linha 1374, modal cliente ~1542) por:
- CEP (com auto-preencher via API ViaCEP ao digitar)
- Rua
- Número
- Complemento
- Bairro
- Cidade
- UF

### Aplicar em

Modal devedor + modal cliente.

### Migração

- Parse string atual via heurística e preencher campos novos.
- Manter coluna antiga `endereco` por 1 release pra fallback.
- Salvar no Supabase como colunas separadas: `cep`, `rua`, `numero`, `complemento`, `bairro`, `cidade`, `uf`.

---

## S9 — Máscara R$ em valores

🟢 spec-pronta

Inputs `mdev-valor-orig` e `mdev-valor-atual` (linhas 1409, 1413) hoje são `<input type="text" placeholder="0,00">` sem máscara.

### Spec

- Aplicar máscara monetária BR (R$ X.XXX,XX) nos inputs ao foco/blur.
- Função `maskMoneyBR(input)` chamada via `oninput`.
- Formato exibição: "R$ 1.335,00".
- Storage: continua salvando em centavos ou number BR — converter via `parseValorBR()` no save (já existe).

### Aplicar em

Todos os inputs de valor financeiro do app — varrer todos `*-valor*`.

---

## S10 — Vincular Google Agenda

🔴 feature-grande

### OAuth

- Google Calendar API com escopos `https://www.googleapis.com/auth/calendar.events` (read+write).
- Token armazenado por usuário em `user_integrations` (encrypted).

### UI

- Página Configurações → Integrações → "Conectar Google Agenda".
- Escolher calendar de destino (ou criar "COBRASQ" auto).

### Eventos sincronizados (bidirecional)

**App → Google:**
- Acordos fechados (1 evento por parcela com data de vencimento).
- Vencimentos de cobrança em aberto (1 evento por vencimento).
- Lembretes agendados pelo operador (item CRM #11).
- Audiências/prazos judiciais cadastrados em processos.

**Google → App:**
- Eventos no calendar conectado com tag/prefixo `#cobrasq:` aparecem na home como "Lembrete agendado".

### Sincronização

- Push imediato do app pro Google ao salvar.
- Pull do Google pelo app a cada 15 min (ou via webhooks Calendar API se simples).

### Cleanup

- Deletar evento no Google quando devedor é "Quitado" ou cobrança cancelada.

---

## S11 — Criar cliente dentro de "nova cobrança"

🟢 spec-pronta

No select `mdev-cliente` (modal devedor), adicionar botão "+ **Novo cliente**" que abre o modal cliente sobreposto.

Após salvar:
- Fechar modal cliente.
- Repopular o select da cobrança.
- Auto-selecionar o cliente recém-criado.
- Estado do modal devedor é preservado (não fecha).

---

## S12 — Rascunhos de cadastro

🟢 spec-pronta

### Botão manual

"Salvar rascunho" ao lado de "Salvar" em cada modal (cliente, devedor, processo, cobrança).

### Auto-save

Ao mudar qualquer campo, debounce 3s, salva como rascunho automaticamente. Indicador visual "Rascunho salvo às HH:mm" no rodapé do modal.

### Schema

Em cada tabela (`clientes`, `devedores`, `processos`, `cobrancas`):
- `is_draft BOOLEAN default false`
- `draft_expires_at TIMESTAMP NULL`

### TTL

- 30 dias após `updated_at` do rascunho.
- Cron diário (Supabase Edge Function ou pg_cron) deleta rascunhos com `is_draft=true AND updated_at < now() - interval '30 days'`.
- Aviso na lista de rascunhos: "Expira em N dias".

### UI rascunhos

- Sidebar mostra item "Rascunhos (N)" com badge.
- Clica → lista de todos os rascunhos do usuário com tipo (cliente/devedor/processo/cobrança), título tentativo, data de criação, dias até expirar.

### Filtros normais

Rascunhos NÃO aparecem nas listagens padrão (devedores, clientes, etc.). Filtro `is_draft=false` aplicado por default.

---

## S13 — Capturar intimações (Escavador)

🔴 feature-grande

### Provedor

**Escavador.** Plano "Acompanhamento Processual + DJEN" (a confirmar com Gustavo no momento da contratação). Custo: ~R$ 200-400/mês.

Razões: API REST documentada (`api.escavador.com`), webhooks pra push de novas intimações, cobre TJ-PR, comunidade ativa.

### Schema

Tabela `proc_intimacoes`:
- `id` UUID PK
- `fonte` ENUM('escavador')
- `processo_num` TEXT
- `oab` TEXT
- `data_publicacao` DATE
- `data_intimacao` DATE
- `conteudo` TEXT
- `link_diario` TEXT
- `lida` BOOLEAN default false
- `devedor_id` UUID NULL

### Captura

**Por CNJ:**
- Pra cada processo cadastrado em `processos`, registrar callback no Escavador.
- Quando há nova movimentação/intimação, webhook do Escavador POST em `/api/intimacoes/webhook` que salva em `proc_intimacoes`.

**Por OAB:**
- Gustavo cadastra a OAB dele em Configurações → Integrações.
- Cron diário 6h consulta endpoint Escavador "intimações por OAB no DJEN".
- Novas intimações entram na tabela com `processo_num` extraído do conteúdo e tentativa de match com `processos` cadastrados.

### UI

- Widget novo na home: "Intimações não lidas (N)" com últimas 5.
- Página "Intimações" com filtros (processo, devedor, data, lida/não lida).
- Push notification (browser API) quando webhook recebe intimação durante uso ativo.
- Vínculo automático: se `processo_num` da intimação bater com processo cadastrado, mostra ele na linha; senão aparece como "Não vinculada — clique pra cadastrar processo".

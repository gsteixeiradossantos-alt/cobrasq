# Specs — Calculadora Jurídica COBRASQ

Origem: triagem da Fase E, plano `~/.claude/plans/users-gustavoteixeira-desktop-cloude-pr-composed-hamster.md` (10/05/2026).

Arquivo principal: `calc-juridica.html` (~79KB, standalone, iframe no faturamento).

Contexto atual:
- LocalStorage 7d, sem Supabase.
- PDF via `window.print()` (linhas 1694-1897).
- Cores: `--navy:#1F3864`, `--green:#1B7E3E`, `--red:#C0392B`, `--yellow:#B8860B`. Sem logo de imagem.
- Form atual tem 6 seções numeradas: 1.Dados, 2.Multa, 3.Honorários contratuais, 4.Honorários sucumbenciais, 5.Pagamentos e estornos, 6.Tabelas de índices.

Ordem de implementação sugerida: **C5, C7 (quick wins) → C4, C6 (simplificar form) → C3 (múltiplas parcelas) → C2 (persistência) → C9 (ID + relatório) → C1 (revisão de fórmulas)**.

---

## C1 — Revisão de fórmulas com Gustavo

🟢 spec-pronta (sessão à parte)

Sessão dedicada onde Claude expõe cada fórmula do motor (correção INPC/IPCA/SELIC/ART406, juros m./a., multa, honorários, imputação 354 CC) num doc curto com snippet do código + fórmula matemática. Gustavo aponta dúvidas, Claude explica/corrige. Não é entrega de código — é revisão técnica colaborativa.

**Output:** `docs/calc/formulas-revisao.md` com cada fórmula validada/ajustada.

---

## C2 — Persistência e duplicação de cálculos

🔴 feature-grande

### Schema novo

Tabela `calc_calculos`:
- `id` UUID PK
- `criado_em` TIMESTAMPTZ default now()
- `atualizado_em` TIMESTAMPTZ default now()
- `owner_id` UUID FK users (RLS por owner)
- `titulo` TEXT default `'Cálculo de {date}'`
- `vinculo_livre` TEXT NULL (texto livre — número CNJ, nome+CPF, etc.)
- `devedor_id` UUID FK devedores NULL
- `processo_num` TEXT NULL
- `snapshot_inputs` JSONB (todos os inputs do form serializados)
- `snapshot_resultado` JSONB (resultado do cálculo serializado)

### UI — Tela "Meus cálculos"

Novo componente no `calc-juridica.html`:
- Lista paginada (25/pg) com colunas: título, vínculo, data, total calculado.
- Busca por título / vinculo_livre / nome de devedor.
- Ações por linha: Abrir / Duplicar e atualizar / Renomear / Excluir.
- "Duplicar e atualizar": abre form pré-preenchido com inputs antigos + `dataFim` setada pra hoje + título "Cópia de {titulo} – {date}".

### Auto-save silencioso

- Após cálculo OK (validação passou e resultado renderizou), criar registro silenciosamente.
- Toast discreto: "Cálculo salvo · Renomear" com link de undo (3s).
- Sem prompt obrigatório de título; usa default editável depois.

### Vínculo opcional

- Campo "Vincular a" no form (opcional). Aceita texto livre OU autocomplete de devedores cadastrados.
- Sem expiração automática (TTL infinito). Usuário deleta manual.

---

## C3 — Múltiplas parcelas/cheques no mesmo cálculo

🔴 feature-grande

### UI

- Lista dinâmica de parcelas com "+ adicionar parcela" e "remover".
- Cada parcela: `valor`, `termo correção`, `termo juros` (default = termo correção).
- Demais inputs (`indice`, `taxaJuros`, `multa`, `honorarios`) ficam **globais** ao cálculo.

### Engine

- Itera parcelas, calcula cada uma (valor → corrigido → juros).
- Soma os corrigidos+juros de todas as parcelas → soma total.
- **Multa incide sobre soma total** (corrigida+juros).
- **Honorários incidem sobre soma total + multa** (Lei 8906 art. 22).

### Relatório

- Nova seção "Composição por parcela" antes da síntese.
- Tabela: parcela | valor original | corrigido | juros | subtotal.
- Síntese consolidada com multa e honorários sobre o total.

---

## C4 — Honorários e multa simplificados

🟢 spec-pronta (depende de C7 e C6)

### Honorários

- Vira **um campo simples**: `honorarios` (input + toggle %/R$).
- Default 20%.
- Base de cálculo fixa: `corrigido + juros + multa`.
- Datas: usa as do principal (sem campos próprios).

### Multa

- Mantém input + toggle %/R$ (default 2%).
- Mantém termo de incidência (vazio = mesma do termo de juros).

### Sucumbenciais

- **Removidos de vez** (todos os campos `honSAplicar`, `honSTipo`, `honSValor`, `honSBase`, `honSDataCorr`, `honSDataJuros`, `honSTaxaJuros` saem do DOM e do engine).
- Migração C2: ao ler snapshot antigo com `honS*` populados, soma com `honC*` no campo único `honorarios` durante leitura.

---

## C5 — Default termo juros = termo correção

🟢 spec-pronta

- Quando usuário preenche `dataCorrecao` e `dataJuros` está vazia, auto-preencher `dataJuros = dataCorrecao`.
- Se usuário alterar `dataJuros` manualmente, parar de auto-preencher (flag `dataJurosTouched`).
- Trocar label/placeholder do `dataJuros` pra "Termo inicial juros (vazio = mesmo da correção)".

---

## C6 — Simplificação do form (seções 2,3,4,6)

🟢 spec-pronta

Print recebido em 10/05/2026. Decodificação das seções:
- **Seção 2 (Multa contratual):** não some, só **simplifica** (per C4). Header "2." e accordion saem; multa vira parte do bloco principal.
- **Seção 3 (Honorários contratuais):** não some, só **simplifica** (per C4). Header "3." e subcampos avançados (Base de cálculo, Termo correção/juros honorários, Taxa juros honorários) vão embora (per C7).
- **Seção 4 (Honorários sucumbenciais):** **remove de vez** (per C4 final).
- **Seção 6 (Tabelas de índices):** some da UI; sync com BCB roda automático em background. Botão "Atualizar do BCB" pode ficar discreto na barra superior.

### Resultado pós-C4+C6+C7

Form fica plano, sem accordions numerados:
- Bloco principal: valor original, índice, termos, taxa juros, data final.
- Bloco multa: checkbox + valor + toggle %/R$ + termo.
- Bloco honorários: checkbox + valor + toggle %/R$.
- Bloco "Pagamentos e estornos" (seção 5 atual) renomeado e mantido.

### Permitir cálculo com índice menor

- Ao detectar `dataFim` posterior ao último índice publicado, aplicar último índice disponível.
- Exibir aviso no relatório: "Cálculo extrapolado a partir de DD/MM/YYYY (último índice publicado: {fonte})".
- **Não bloquear** o cálculo.

---

## C7 — Remover subcampos avançados de honorários

🟢 spec-pronta

Remover do DOM os inputs:
- `honCBase`, `honCDataCorr`, `honCDataJuros`, `honCTaxaJuros`
- `honSBase`, `honSDataCorr`, `honSDataJuros`, `honSTaxaJuros` (já cobertos por C4 que remove sucumbenciais)

No engine: usar sempre base = `CORRIGIDO_JUROS_MULTA`, datas = principal, taxa juros honorários = mesma do principal.

Garantir que o relatório não cite mais essas variáveis.

---

## C8 — Conversa aberta (prints)

🟢 spec-pronta (fechado)

Aguardando prints adicionais de calculadoras de referência. Itens C10+ ficam pra ser adicionados se aparecerem casos novos no uso.

---

## C9 — Aplicar identidade COBRASQ + novo modelo de relatório

🔴 feature-grande

Assets: `~/Desktop/Cloude/Projetos/ID COBRASQ/` (Rebrand Book v3 PDF + handoff zip + Ativos/social/).
URL design Anthropic: `https://api.anthropic.com/v1/design/h/DUM-4_2dyErP-e76pGLFxw`.

### Fase 1 — Design tokens

- Ler `COBRASQ — Rebrand Book v3 · PDF.pdf` + handoff zip + Ativos/social/.
- Tentar fetch da URL Anthropic do design file (se inacessível, usar só assets locais — flagar pra Gustavo).
- Extrair tokens em `assets/brand-tokens.css`:
  - Cores: primary, secondary, neutral, success, danger, warning.
  - Tipografia: family, weights, scale.
  - Logo SVG inline + variantes monocromáticas.

### Fase 2 — UI da calc

- Aplicar tokens na própria interface do `calc-juridica.html`.
- Substituir `--navy:#1F3864`, `--green:#1B7E3E`, `--red:#C0392B`, `--yellow:#B8860B` atuais pelos da identidade.
- Header com logo. Inputs, botões, accordions usando tokens.

### Fase 3 — Relatório

- Reescrever HTML do `exportarPDF()` (linhas 1694-1897) seguindo o design fetched.
- Capa com logo, paleta nova, layout do design file.
- Tabela mês-a-mês com tipografia oficial.
- Síntese final com cards.

### Bloqueio

Confirmar acessibilidade da URL Anthropic na implementação. Se não acessível, Claude desenha o relatório só com base no Rebrand Book + intuição (e Gustavo aprova mock).

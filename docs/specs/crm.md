# Specs — CRM COBRASQ

Origem: triagem da Fase E, plano `~/.claude/plans/users-gustavoteixeira-desktop-cloude-pr-composed-hamster.md` (10/05/2026).

## Estado do código

CRM rodava como app separado em `crm-cobrasq.vercel.app`. No repo `cobrasq-faturamento`, o branch `merge-crm` foi **revertido** (commit c8cf459) — código atual existe só nos backups:
- `backups/2026-05-08/crm_scripts_extracted.js` (scripts, ~600+ linhas)
- `backups/2026-05-08/crm/casos.json` (15 casos exemplo)

Implementação dos 17 itens vai exigir **re-criação do CRM no faturamento** ou ressuscitar `merge-crm`. Recomendação Claude: ressuscitar branch `merge-crm` e mergear no `index.html` do faturamento. Ganho: app único, single sign-on, dados unificados no Supabase.

Decisão de "onde implementa" fica pra fase de execução, não trava aprovação do plano.

## Ordem sugerida

1. **#2, #16** — destravamento Z-API + assinatura (afeta confiabilidade dos demais blocos)
2. **#4, #8, #12, #13** — quick wins 🟢
3. **#1, #5, #11** — blocos novos
4. **#7, #10** — features visuais + reversão de fluxo
5. **#3, #15, #17, #14** — gestão e copy
6. **#6, #9** — parcelamento avançado

---

## #1 — Bloco "não vou pagar juros/advogado/acréscimos"

🟢 spec-pronta

### UI

Botão "Reclamação de juros/honorários" sempre visível na barra de ações do caso (não só em etapa específica). Ao clicar, abre modal/seção com 3 opções.

### 3 sub-fluxos

**Opção A — Rebatida (sem concessão):**
- Envia script padronizado argumentando legalidade contratual de juros e honorários.
- Texto curto, gatilhado (conforme item #14).
- Após envio, status do caso volta pra etapa anterior (segue negociação normal).

**Opção B — Escalar pro gestor:**
- Dispara solicitação de autorização que aparece na "mesa do gestor" (item #15).
- Caso fica em estado "aguardando autorização do gestor".
- Gestor pode aprovar com desconto de X% nos adicionais ou rejeitar.

**Opção C — Concessão de capital:**
- Caso entra direto em fluxo de acordo só com valor capital (sem juros/honorários/adicionais).
- Sem autorização. Atalho pra fechamento rápido.

### Estado

Novo campo `objecao_adicionais` no caso (timestamp + opção escolhida) pra rastrear frequência. Útil pro relatório do CRM (#3).

---

## #2 — Atualização auto de etapa após envio Z-API

🔴 feature-grande

### Auditoria

- Mapear no código (a) função que chama Z-API, (b) lógica de avanço de etapa pós-envio, (c) detecção de "alterado por outro usuário".
- Provavelmente comparação de `updated_at` ou versão.

### Comportamento esperado

- **Z-API erro:** etapa NÃO avança, toast vermelho com mensagem clara, caso entra em lista "mensagens com falha de envio" pra retry manual ou automático.
- **Z-API sucesso:** etapa avança automaticamente, sem toast de conflito (a própria escrita pós-envio não deve disparar conflito).
- **Conflito otimista:** só aparece quando há de fato outro operador editando — usar lock leve por `updated_at` mas suprimir o aviso pro próprio operador que acabou de salvar.

### Logs

Instrumentar `console.log` no envio Z-API + atualização de etapa pra reproduzir e capturar gatilhos do "alterado por outro usuário".

### Teste obrigatório

Rodar Script D (1ª abordagem - curiosidade) end-to-end e confirmar que status atualiza sem erro.

---

## #3 — Relatório geral do CRM

🟢 spec-pronta

### Métricas iniciais

- Taxa de conversão (negociado/total)
- Tempo médio por etapa
- Casos por operador (volume + status atual)
- Valor total negociado (soma dos acordos fechados no período)
- Falhas de contato (cases com >N tentativas sem resposta)

### Filtros

- Período (default: últimos 30 dias)
- Operador
- Cliente
- Tipo (extrajudicial / judicial)

### UI

Página `/crm/relatorio` com cards de KPIs no topo + 3 gráficos (timeline conversão, distribuição etapas, pareto operadores).

Reavaliar métricas após primeiro uso.

---

## #4 — Renomear "pediu contexto" + reordenar

🟢 spec-pronta

### Renomear

- Key: `pediu-contexto` → `explicar-contexto`.
- Display name: "Explicar o contexto".

### Reordenar

Colocar como **2ª opção** após o script de contato inicial / saudação. Contexto em 2º lugar; formas de pagamento depois.

### Migração

Atualizar referências no código (transitions, defaults). Atualizar histórico de casos antigos: trocar `pediu-contexto` → `explicar-contexto` no campo `passo_atual`.

---

## #5 — Confirmar endereço ao aceitar acordo

🟢 spec-pronta

### Spec

- Bloco no CRM **antes** de mandar pro ZapSign.
- Operador confirma endereço com devedor por escrito (mensagem padrão de confirmação enviada via Z-API).
- Devedor responde com endereço completo (rua, nº, complemento, CEP, cidade, UF) ou confirma o que já está cadastrado.
- Operador clica "Endereço confirmado" → caso avança pra envio do ZapSign.

### Razão

Reduz fricção pós-assinatura (corretivo é caro depois que o doc tá assinado).

---

## #6 — Cálculo por valor de parcela / parcelamento >12x

🟢 spec-pronta

### Bloco "Cálculo reverso por parcela"

- Input: "valor que o devedor topa pagar por mês".
- Calcula automaticamente em quantas parcelas se encaixa (com a taxa de juros vigente).
- Mostra: "X parcelas de R$ Y, total R$ Z, primeira parcela em DD/MM".

### Bloco "Solicitar parcelamento >12x"

- Operador escolhe N parcelas (limite máximo: **24x**).
- >24x bloqueado mesmo com autorização (proteção contra parcelamentos absurdos).
- Operador preenche justificativa.
- Dispara envio pra "mesa do gestor" (#15) com proposta calculada.
- Caso fica em estado `aguardando_autorizacao_parcelamento`.
- Gestor aprova/rejeita; aprovação destrava envio do parcelamento ao devedor.

---

## #7 — Cronômetro com cores

🔴 feature-grande

### Schema

Tabela `crm_etapa_prazos`:
- `etapa_key` TEXT PK
- `prazo_minutos` INTEGER
- `threshold_amarelo_pct` INTEGER default 70

Configurável pelo gestor.

### Defaults iniciais

- Contato inicial: 60 min
- Explicar contexto: 30 min
- Formas de pagamento: 15 min
- Fechamento: 10 min

Gestor pode reconfigurar depois em painel.

### UI

Componente `<Cronometro caso={caso}>` no card do caso.

JS calcula `agora - etapa_atualizada_em`. Cores:
- **Verde:** tempo < threshold_amarelo_pct * prazo
- **Amarelo:** ≥ threshold_amarelo até prazo
- **Vermelho:** > prazo (continua girando, sem parar)

Animação: tick a cada segundo. Formato "MM:SS" (ou "HH:MM:SS" se >1h).

---

## #8 — Bloco "reclamou dos juros do parcelamento"

🟢 spec-pronta

### Spec

Novo script no CRM:
- Key: `reclama-juros-parcelamento`
- Display: "Reclama dos juros do parcelamento"

### Texto (curto, humano — per #14)

Explica que juros do parcelamento são a remuneração do prazo concedido (lei do mercado), oferece:
- À vista com desconto
- Parcelamento em menos vezes (juros menores)

Sugere caminhos: "Quer reduzir? Posso te oferecer X parcelas com juros menores ou desconto à vista de Y%".

### Após enviado

Status passa pra "negociando juros parcelamento". Operador pode acionar bloco de cálculo reverso (#6) ou desconto à vista.

---

## #9 — Taxas Mercado Pago vs. boleto

🟢 spec-pronta

### Spec

- Mercado Pago vira gateway novo (a integrar).
- Mostrar valor com taxa **embutida** ao devedor (transparente).
- Comparativo lado-a-lado no script:
  - "Boleto: R$ X (sem taxa adicional)"
  - "Cartão MP: R$ X+taxa MP"
- Operador escolhe qual oferecer.

### Verificação

Confirmar na implementação que a taxa MP atual deixa o cartão MAIS atrativo que boleto. Se não for, escalar pro Gustavo decidir nova ideia.

---

## #10 — Reabrir acordo "fechado"

🔴 feature-grande

### Ação "Reabrir acordo"

- Disponível em casos com status `Fechado/Acordo`.
- Permissões:
  - **Operador dono:** pode reabrir em **<24h** após fechamento.
  - **Gestor:** sempre pode reabrir.

### Comportamento

Ao clicar:
- Status volta para etapa anterior (configurável: "Negociação" como default).
- Histórico íntegro mantido.
- Registra evento "Acordo reaberto por X em DD/MM motivo: Y".
- Invalida documento ZapSign se ainda não assinado.
- Gera novo acordo se valores mudaram.

---

## #11 — Lembrete/agendamento de mensagem

🟢 spec-pronta

### Mensagem agendada manual

- Botão "Agendar envio" ao lado de "Enviar".
- Operador escolhe data/hora + mensagem.
- Salva em tabela `crm_mensagens_agendadas` (id, caso_id, operador_id, mensagem, agendada_para, status).

### Worker

Supabase Edge Function ou cron a cada 5 min envia mensagens cuja `agendada_para <= now() AND status='pendente'` via Z-API.

### Auto-cobrança de assinatura

Caso com status `Aguardando assinatura ZapSign`:
- **24h:** dispara mensagem auto de cobrança ("Oi, vi que você ainda não assinou...").
- **48h:** segunda mensagem.
- **72h:** marca como "abandonado" e move pra fila de retomada manual.

---

## #12 — Emojis infantis no CRM

🟢 spec-pronta

### Spec

- Lint: rodar regex `[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]` no código do CRM (quando localizado) e em `casos.json`.
- Substituir cada ocorrência por SVG inline (mesmo padrão do item S4).
- Adicionar regra ESLint/CI pra falhar se emoji aparecer em arquivos do CRM.

### Estado

Explore não achou emojis no `crm_scripts_extracted.js`. Se a feature é "remover", não há nada nos scripts; pode estar na UI do CRM (não nos scripts) ou em casos antigos. Validar na implementação.

---

## #13 — Botão direto WhatsApp

🟢 spec-pronta

### Spec

- Botão "Abrir WhatsApp" no header do caso.
- Link: `https://wa.me/55{telefone}` (formatar: tirar `()`, `-`, espaços, prefixar 55 se não tiver).
- Ícone WhatsApp (SVG, não emoji).
- Tooltip: "Abre a conversa no WhatsApp Web/App em nova aba".

### Tracking

Registrar evento "abriu_whatsapp" no histórico do caso.

---

## #14 — Revisão geral de copy + remover taxa de serviço

🟢 spec-pronta

### Taxa de serviço

Assumida como **menção apenas** (custo COBRASQ, não cobrado do devedor). Remover toda menção dos scripts.

Confirmar na sessão de copy review.

### Copy review

Sessão dedicada onde Claude:
- Lê todos os scripts.
- Propõe versão curta (target: <80 palavras por script, sem jargão, tom de conversa humana).
- Gustavo aprova/ajusta.

Output: PR com nova versão dos scripts.

### Princípios de copy

- Curto (<80 palavras)
- Cirúrgico (sem rodeios)
- Gatilhado (cada parágrafo tem propósito)
- Humano (parecer conversa, não IA)
- Sem mencionar "taxa de serviço"

---

## #15 — "Mesa do gestor" na home

🔴 feature-grande

### Widget "Minha mesa" na home do CRM

Lista casos onde gestor precisa agir. **5 categorias confirmadas:**

1. **Acordos a conferir** (status `Aguardando conferência gestor`)
2. **Parcelamentos >12x pendentes** (#6, status `aguardando_autorizacao_parcelamento`)
3. **Concessões de capital pendentes** (#1 opção B/C)
4. **Ações judiciais a revisar** (cases recém-encaminhadas pro judicial)
5. **Casos vencidos sem ação** (cronômetro vermelho do #7 há >24h)

Cada categoria mostra contagem + 3 últimos casos com link direto.

Filtro pra outros gestores se houver mais de 1.

Adicionar 6ª categoria depois se surgir necessidade.

---

## #16 — Assinatura operador no início da mensagem

🟢 spec-pronta

### Lookup

Ao enviar:
- Sistema pega `assigned_to` do caso (e não o usuário logado).
- Busca `nome` em `users.nome` ou `users.full_name`.
- Prepend `*{nome}:*\n\n` na mensagem.

### Fallback

Se `assigned_to` for null, usa o user logado.

### Override gestor

- Se gestor envia mensagem em caso de colaborador **sem reatribuir**: mantém assinatura do colaborador.
- Se gestor **reatribui** o caso pra si antes de enviar: assinatura passa a ser o gestor.
- Lookup é sempre `assigned_to` no momento do envio.

### Substituir placeholder

Substituir placeholder `[OPERADORA]` pelo nome também (já estava previsto).

---

## #17 — Menu CRM para ações judiciais

🟢 spec-pronta

### Item de menu/sidebar "Judicial"

Lista todos os casos com status `Ação judicial` ou `Encaminhado ao judicial`.

Filtros: por fase processual, comarca, próxima audiência, etapa atual.

### Detalhe judicial por caso

Quando caso vira "Ação judicial", abrir aba dedicada com **checklist**:
- Registrar no Astrea
- Notificar Dr. Gustavo
- Congelar negociação extrajudicial
- Gerar peça inicial (placeholder; geração via template fica pra fase 2)

Cada item do checklist marca data/responsável.

### Escopo inicial

Só lista filtrável + checklist por caso. Geração de peças via template fica pra **fase 2** (após estabilizar checklist).

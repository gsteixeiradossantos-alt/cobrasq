# COBRASQ — Inventário de Fase 0
**Data:** 2026-05-04 | **Auditor:** Claude Code (Sonnet 4.6) | **Versão auditada:** commit 52ddc6d

---

## 🚨 RISCOS CRÍTICOS DE SEGURANÇA — LEIA ANTES DE TUDO

> Estes itens exigem decisão de Gustavo **antes** de qualquer avanço para Fase 1.

| # | Risco | Localização | Severidade |
|---|-------|-------------|-----------|
| SEC-01 | **Credenciais do gestor hardcoded no código-fonte** — email `gustavo@cobrasq.com.br` + hash SHA-256 da senha presentes como valor default no objeto `DB` (linha 2235). Qualquer pessoa que acesse o repositório (público ou privado com acesso compartilhado) obtém o e-mail e pode tentar reverter o hash. | `index.html:2235` | 🔴 CRÍTICO |
| SEC-02 | **CNPJ da empresa hardcoded** — `34.626.848/0001-42` está fixo como default no código-fonte. Expõe dado jurídico sensível no repositório. | `index.html:2236` | 🟠 ALTO |
| SEC-03 | **Chave da API Anthropic (Claude) exposta no browser** — `claudeApiKey` é armazenada em `localStorage` e enviada diretamente do frontend para `api.anthropic.com` (linha 7200). Qualquer usuário com DevTools vê a chave. Risco de uso não-autorizado e vazamento de dados submetidos à API. | `index.html:7200`, `localStorage['cobrasq_v6']` | 🔴 CRÍTICO |
| SEC-04 | **Chaves Asaas, ZapSign e Z-API em `localStorage`** — todas as API keys de integração ficam expostas no DevTools do browser. Se o browser do usuário for comprometido ou num equipamento compartilhado, todas as integrações financeiras ficam acessíveis. | `index.html:2237`, `localStorage['cobrasq_v6']` | 🔴 CRÍTICO |
| SEC-05 | **Hashing de senha fraco sem salt real** — `hashSenha()` usa `SHA-256('cobrasq:v1:' + senha)`. O prefixo fixo não é um salt — ataques de rainbow table adaptados são viáveis. Além disso, `compareSenha()` aceita senha em texto plano como fallback "legado" (linha 2618). | `index.html:2608–2618` | 🔴 CRÍTICO |
| SEC-06 | **RLS sem isolamento de tenant** — as políticas do Supabase permitem que qualquer usuário autenticado leia e escreva **todo** o `cobrasq_data` (tabela única com dados de todos os clientes). Se dois tenants usarem a mesma instância Supabase, um vê os dados do outro. | `index.html:6609–6614` | 🟠 ALTO (depende de setup) |

**Recomendação imediata:**
- SEC-01: remover credenciais do código, migrar para `ENV` ou Supabase Auth puro
- SEC-03/04: criar servidor-proxy (já existe `/api/asaas` — replicar para Claude e demais APIs); nunca passar chaves para o frontend
- SEC-05: migrar para bcrypt/argon2 via edge function quando houver backend real

---

## 1. Stack Real (descoberta)

| Camada | O que existe | O que a spec presumia |
|--------|-------------|----------------------|
| **Frontend** | HTML/CSS/JS vanilla — single file `index.html` (~9 069 linhas, ~496 KB) | Next.js + React + Tailwind + shadcn/ui |
| **Backend** | Nenhum — toda lógica no browser. Proxy mínimo em `/api/asaas` (Vercel Edge) | Server Actions |
| **Banco** | Supabase Postgres — 1 tabela `cobrasq_data` (JSONB único `key='main'`) + `app_users` | Supabase multi-tabela com RLS granular |
| **Auth** | Supabase Auth (gestor) + hash local SHA-256 (cedente/devedor) | Supabase Auth puro |
| **Deploy** | Vercel (`cobrasq-faturamento.vercel.app`) | Vercel |
| **CDNs** | Chart.js 4.4.0, XLSX 0.18.5, html-docx-js 0.3.1, @supabase/supabase-js@2 | — |
| **Fontes** | Inter + JetBrains Mono (Google Fonts) | — |

---

## 2. Mapa de Páginas e Módulos

### 2.1 Telas internas (Gestor)

| ID | Função principal | Estado atual | Prioridade Fase 1 |
|----|-----------------|--------------|-------------------|
| `painel` | Dashboard com KPIs, vencimentos, atividade recente | Parcialmente refatorado para Design B (commit 52ddc6d) | ✅ feito |
| `devedores` | Lista de devedores, filtros, drawer lateral com acordos/processo/WhatsApp | Design A (visual antigo) | Alta |
| `processos` | Kanban de processos jurídicos | Design A (visual antigo) | Alta |
| `clientes` | Cadastro de cedentes (clientes da COBRASQ) | Design A (visual antigo) | Alta |
| `docs` | Gerador de minutas jurídicas (30+ tipos), Word/PDF | Design A (visual antigo) | Média |
| `fin` | Financeiro: visão geral, lançamentos, contas, cartões, Asaas | Design A (visual antigo) | Alta |
| `relat` | Relatórios: mensal, cobranças, financeiro, performance, comissão | Design A (visual antigo) | Média |
| `wa` | WhatsApp: configuração Z-API, régua de cobrança, templates | Design A (visual antigo) | Média |
| `config` | Configurações: perfil, usuários, integrações, segurança, simulador | Design A (visual antigo) | Baixa |
| `auditoria` | Log de auditoria de operações | Existe estrutura, sem dados reais | Baixa |

### 2.2 Portais externos

| Portal | Acesso | Estado atual |
|--------|--------|-------------|
| **Portal Cedente** | Hash de URL (`#cedente`) — CPF do cedente como login | Funcional, visual antigo |
| **Portal Devedor** | Hash de URL (`#devedor`) — CPF + data nascimento | Funcional, visual antigo |

---

## 3. Modelo de Dados

### 3.1 Supabase (opcional — fallback para localStorage)

```
cobrasq_data
  key: TEXT PRIMARY KEY = 'main'
  data: JSONB  ← TODO o banco do app em um único objeto
  updated_at: TIMESTAMPTZ
  updated_by: UUID → auth.users

app_users
  id: UUID → auth.users (CASCADE DELETE)
  nome, papel (proprietario|colaborador|cedente|devedor), ref_id, cargo, ativo
```

### 3.2 Estrutura do objeto `DB` (JavaScript/localStorage)

```
DB {
  config: { nome, email, senha(hash), empresa, cnpj, avatar, tema,
            metaMensal, claudeApiKey, supabaseUrl, supabaseAnonKey,
            colaboradores[], usuarios[], categorias{},
            whatsapp{ numero, apiToken, templates[], regua[] },
            asaasKey, zapiInstanceId, zapiToken, zapsignToken,
            asaasEnv, notif{} }
  clientes: [ { id, nome, cnpj, status, ... } ]
  devedores: [ { id, nome, cpf, clienteId, valor, status, vencimento,
                 parcelas[], acordos[], processos[], historico[], ... } ]
  lancamentos: [ { id, tipo, categoria, valor, data, ... } ]
  contas: [ { id, nome, saldo, ... } ]
  minutas: [ { id, tipo, devId, conteudo, ... } ]
  processos: [ { id, devId, fase, andamentos[], ... } ]
  audit_log: [ { ts, user, action, ref } ]   ← manual, não via trigger
}
```

**Ponto crítico:** Todo o banco (potencialmente MBs de dados) é sincronizado por `upsert` como um único JSONB. Sem versionamento de conflito — last-write-wins.

---

## 4. Fluxos de Autenticação

| Perfil | Mecanismo | Armazenamento de sessão |
|--------|-----------|------------------------|
| **Gestor** | Supabase Auth (se configurado) OU SHA-256 local | `currentUser` em memória + `localStorage` |
| **Cedente** | CPF digitado — busca em `DB.clientes` por `cpf` e valida senha local | `currentUser` em memória |
| **Devedor** | CPF + data de nascimento — busca em `DB.devedores` | `currentUser` em memória |

Não há refresh token, não há expiração de sessão, não há 2FA.

---

## 5. Integrações Externas

| Serviço | Finalidade | Chamada de | Chave armazenada em |
|---------|-----------|-----------|---------------------|
| **Supabase** | Auth + banco | Frontend | `localStorage` (URL + anon key) |
| **Asaas** | Cobranças, clientes, boletos | Proxy `/api/asaas` (Vercel) | `localStorage` |
| **Anthropic Claude** | Geração de minutas (IA) | **Frontend direto** 🚨 | `localStorage` |
| **ZapSign** | Assinatura eletrônica | Frontend direto | `localStorage` |
| **Z-API** | Envio WhatsApp | Frontend direto | `localStorage` |

---

## 6. Inventário de Funções (por módulo)

### Core (~12 funções)
`save`, `load`, `getSupabase`, `fetchServerConfig`, `syncToSupabase`, `loadFromSupabase`, `testarSupabase`, `doLogin`, `doLogout`, `showPage`, `hashSenha`, `compareSenha`

### UI/UX (~10 funções)
`showToast`, `openModal`, `closeModal`, `initTabs`, `toggleTheme`, `closeSidebar`, `openSidebar`, `promptModal`, `togglePw`, `updateNotifBadge`

### Dashboard (3 funções)
`renderPainel`, `buildMiniCalendar`, `calcMetaProgresso`

### Devedores (~20 funções)
`renderDevedores`, `openDrawer`, `closeDrawer`, `renderDrawerBody`, `renderDrawerAsaas`, `calcScore`, `getBadgeClass`, `toggleDevFilterStatus`, `toggleClientFilter`, `toggleFilterPopover`, `toggleDevViewMode`, `toggleParcela`, `toggleDevSelection`, `toggleSelectionMode`, `updateBulkToolbar`, `toggleBulkDropdown`, `closeBulkDropdown`, `renderMdevTags`, `removeMdevTag`

### Processos (~2 funções)
`renderProcessos`, `renderProcessoTab`

### Clientes (~2 funções)
`renderClientes`, `salvarCliente`

### Documentos/Minutas (~10 funções)
`renderDocs`, `renderDocsTable`, `mv2Gerar`, `mv2EnviarZapSign`, `mv2EnviarLinkWhatsApp`, `mv2EnviarWhatsApp`, `mv2EmitirCobrancasAcordo`, `downloadImportTemplate`

### Financeiro (~10 funções)
`renderFinanceiro`, `renderFinTab`, `renderFinVisao`, `_carregarResumoAsaasVisao`, `_asaasGetBalance`, `renderFinLancamentos`, `renderFinContas`, `renderContasGrid`, `renderFinCartoes`, `renderCartoesGrid`, `renderFinAsaas`, `cancelarCobrancaAsaasGlobal`

### Relatórios (~6 funções)
`renderRelatorios`, `renderRelatTab`, `renderRelatMensal`, `renderRelatCobr`, `renderRelatFin`, `renderRelatPerf`, `renderRelatComissao`, `buildReportHtml`

### WhatsApp (~5 funções)
`renderWhatsApp`, `addRegraStep`, `removerRegua`, `removerTemplate`, `executarPassoRegua`, `executarReguaCompleta`, `enviarCobrancaWhatsApp`

### Configurações (~15 funções)
`renderConfiguracoes`, `renderCfgSection`, `exportarBackup`, `importarBackup`, `addColaborador`, `criarUsuario`, `addCategoria`, `testarAsaas`, `testarZapSign`, `testarZApi`, `salvarSenha`, `salvarNovaSenha`, `enviarResetSenha`, `sincronizarAgora`, `calcSimulador`

### Asaas helpers (~5 funções)
`salvarCobrancaAsaas`, `cancelarCobrancaAsaas`, `segundaViaAsaas`, `verCobrancaAsaas`, `vincularClienteAsaas`, `asaasEnsureCustomer`

### Auditoria (~2 funções)
`renderAuditoria`, `getAlertas`

### Portais (~4 funções)
`renderPortalCedente`, `cpAlterarSenha`, `renderPortalDevedor`

**Total estimado: ~130 funções**

---

## 7. Débito Técnico (não-crítico)

| Item | Detalhe | Impacto |
|------|---------|---------|
| Single-file de 9 069 linhas | Manutenção difícil, sem modularização | Desenvolvimento lento |
| Sem testes automatizados | Nenhum Vitest/Playwright — toda validação manual | Risco de regressão |
| `audit_log` manual | Sem trigger Postgres — registros dependem de chamada JS | Dados incompletos |
| Sincronização last-write-wins | Sem versionamento no JSONB — edição simultânea corrompe dados | Risco de perda |
| Sem expiração de sessão | Usuário autenticado para sempre até logout manual | Risco de segurança |
| html-docx-js sem SRI | CDN carregado sem `integrity` hash | Supply-chain attack |
| CPF/CNPJ exibidos sem máscara | Dados pessoais visíveis em listas sem mascaramento | LGPD |

---

## 8. Mapeamento Design B × Estado atual

| Componente | Spec Direção B | Estado atual |
|-----------|---------------|--------------|
| Login | ✅ Aplicado (commit 52ddc6d) | ✅ |
| Topbar + breadcrumbs | ✅ Aplicado | ✅ |
| Sidebar | ✅ CSS tokens aplicados | Parcial (HTML correto) |
| Dashboard/Painel | ✅ KPIs com sparkline, atividade | ✅ |
| Devedores | ❌ Não aplicado | Pendente Fase 1 |
| Processos | ❌ Não aplicado | Pendente Fase 1 |
| Clientes | ❌ Não aplicado | Pendente Fase 1 |
| Docs | ❌ Não aplicado | Pendente Fase 1 |
| Financeiro | ❌ Não aplicado | Pendente Fase 1 |
| Relatórios | ❌ Não aplicado | Pendente Fase 1 |
| WhatsApp | ❌ Não aplicado | Pendente Fase 1 |
| Configurações | ❌ Não aplicado | Pendente Fase 1 |
| Portal Cedente | ❌ Não aplicado | Pendente Fase 1 |
| Portal Devedor | ❌ Direção A (Newsreader) não implementada | Pendente Fase 1 |

---

## 9. Checklist de Aprovação para Fase 1

Antes de iniciar qualquer desenvolvimento da Fase 1, Gustavo deve responder:

- [ ] **SEC-01** — Remover credenciais hardcoded do código? (recomendado: sim)
- [ ] **SEC-03/04** — Criar proxy server-side para Claude/ZapSign/Z-API? (recomendado: sim, Vercel Edge Functions)
- [ ] **SEC-05** — Aceitar o risco do SHA-256 fraco por enquanto e migrar na Fase 3? (ou migrar agora?)
- [ ] **SEC-06** — Confirmar que não há multi-tenancy previsto (Supabase é instância privada da COBRASQ)
- [ ] Confirmar versão: exibir como **v1** (não v4.2) no sistema

---

*Este documento não implica nenhuma alteração de código. Aguarda revisão e OK explícito de Gustavo antes de prosseguir para Fase 1.*

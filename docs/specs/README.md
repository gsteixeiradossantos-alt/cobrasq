# Specs — Triagem Fase E

39 itens de mudança triados em 10/05/2026 a partir de lista enviada por Gustavo. Cada item tem classificação 🟢 trivial / 🟡 perguntas / 🔴 feature-grande e spec consolidada.

## Arquivos

- [calculadora.md](calculadora.md) — 9 itens (C1-C9). Calc Jurídica (`calc-juridica.html`).
- [site-app.md](site-app.md) — 13 itens (S1-S13). App principal (`index.html`).
- [crm.md](crm.md) — 17 itens. CRM (branch `merge-crm` revertido + backups).

## Resumo

| Bloco | 🟢 | 🔴 | Total |
|---|---|---|---|
| Calculadora | 6 | 3 | 9 |
| Site/App | 10 | 3 | 13 |
| CRM | 13 | 4 | 17 |
| **Total** | **29** | **10** | **39** |

## Ordem de implementação sugerida

| # | Bloco | Itens | Razão |
|---|---|---|---|
| 1 | Quick wins cross-product | C5, C7, S1, S4, S8, S9, S11, #4, #8, #12, #13 | Baixo risco, 1 release |
| 2 | CRM destravamento | #2 (Z-API), #16 (assinatura) | Destrava confiabilidade |
| 3 | CRM blocos novos | #1, #5, #11 | Fluxos de negócio |
| 4 | CRM cronômetro + reabrir | #7, #10 | Visual + reversão |
| 5 | CRM gestão | #3, #15, #17, #14 | Trabalho de gestor |
| 6 | CRM parcelamento | #6, #9 | Cálculo |
| 7 | IA Beatriz | S2, S3, S7 | Reformula IA |
| 8 | Calc reescrita | C2, C3, C4, C6, C9 | Refator pesado |
| 9 | Rascunhos + Filiais | S5, S6, S12 | Schema changes |
| 10 | Integrações | S10 (Google), S13 (Escavador) | Standalone |
| 11 | Revisão fórmulas | C1 | Sessão dedicada |

## Plano original

`~/.claude/plans/users-gustavoteixeira-desktop-cloude-pr-composed-hamster.md`

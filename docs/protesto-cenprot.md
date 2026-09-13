# Protesto pela CRA — API CENPROT Empresas (IEPTB)

Integração preparada em 13/09/2026 a partir do manual **"API CENPROT Empresas — Requisições e
Consultas, v2.2 (04/06/2024)"**. Fica **desligada** até o convênio sair: sem
`CENPROT_USUARIO`/`CENPROT_SENHA` na Vercel, toda chamada responde `{ pendente: true }` e nada
é gravado.

## Arquivos

| Arquivo | Papel |
|---|---|
| `api/_cenprot.js` | cliente SOAP: `Autenticar`, `EnviarTitulo`, `ConsultarTitulo`, `OperacaoTitulo`; monta o XML, lê a resposta, valida espécie/declaração/status |
| `api/_protesto.js` | ação `protesto` de `api/automacao.js` (exige sessão do painel): `status`, `enviar`, `consultar`, `operacao`, `listar`; grava em `protesto_titulos` |
| `supabase/migrations/20260914_01_protesto_titulos.sql` | tabela + RLS (staff lê, proprietário escreve; inserts pelo backend) — **não aplicada** |
| `test/f40_cenprot_envelope.test.js` | envelope, formatos, parser da consulta (exemplo do manual) e tabela status→operação |

## Como ligar (depois do convênio com o IEPTB-PR)

1. Convênio: convenio@paranaprotesto.com.br · (41) 3779-9731 · WhatsApp (41) 98402-4852.
   Pedir: usuário, senha, **código de apresentante** e, se houver, código/nome de portador.
2. Vercel → Environment Variables:
   - `CENPROT_USUARIO`, `CENPROT_SENHA`, `CENPROT_APRESENTANTE`
   - `CENPROT_AMBIENTE=hml` (homologação; trocar para `prod` só depois do teste abaixo)
   - opcionais: `CENPROT_COD_PORTADOR`, `CENPROT_NOME_PORTADOR`
3. Aplicar a migração `20260914_01` (gated — só com autorização).
4. Teste em homologação, logado no painel (console do navegador):
   ```js
   const tok = (await getSupabase().auth.getSession()).data.session.access_token;
   const call = (b) => fetch('/api/automacao?action=protesto', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(b) }).then(r => r.json());
   await call({ op: 'status' });                       // { configurado: true, ambiente: 'hml' }
   await call({ op: 'enviar', caso_id: '<id>', titulo: { divida: { especie: 'DMI', numero: '123', valor: 1500.5, emissao: '2026-01-10', vencimento: '2026-02-10', declaracaoPortador: 'D' } } });
   await call({ op: 'consultar', id: '<protesto_titulos.id>' });
   ```
5. Só então `CENPROT_AMBIENTE=prod`.

## Regras que o código impõe (do manual)

- Valores com ponto e 2 casas (`185.60`); sem ponto o CRA lê como centavos `00`.
- Datas `DD/MM/AAAA`; vencimento à vista = `99/99/9999` (`divida.vencimentoAVista: true`).
- `documentoTipo` 1 = CPF, 2 = CNPJ; vários devedores → `devedores: [...]` com `principal` N nos secundários.
- Espécies: siglas do manual (`DMI`, `DSI`, `NP`, `CH`, `CD`, `TA`, `SJ` …). Para **sentença/acordo
  homologado** (`SJ`), o cartório exige certidão de teor da decisão (Prov. 53/2015).
- `declaracaoPortador`: `D` (DMI/DSI com documentação em posse), `A` (exige original), `G` (dispensa),
  `I` (envia imagem em `documentoBase64`, até 5 MB), `C` (CCB/CBI).
- Operações só nos status certos: `REMOCAO` ← COLETADO/GERADO · `DESISTENCIA` ← CONFIRMADO ·
  `CANCELAMENTO` ← PROTESTADO. `_protesto.js` exige `justificativa` porque desistência e
  cancelamento sem pagamento podem gerar custas para o apresentante.

## Custo (Paraná)

Lei estadual 19.350/2017: sem depósito prévio; o devedor paga emolumentos ao quitar. O IEPTB-PR
anuncia gratuidade para o credor em título com **até 1 ano de vencimento**. Acima disso, ou em
desistência/cancelamento sem pagamento, as custas ficam com o apresentante — regra exata a
confirmar no convênio.

## Pendências

- Tela no painel (botão "Protestar" na cobrança + lista de títulos) — não feita nesta rodada.
- Job de consulta periódica de status (`cron`), se o volume justificar.
- Contrato real pode divergir do manual (o `Autenticar` de exemplo usa `apresentante=999`).

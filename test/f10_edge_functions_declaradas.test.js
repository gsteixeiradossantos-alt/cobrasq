/*
 * Teste F-10 (supabase/config.toml) — toda Edge Function do repo declara o seu
 * `verify_jwt`, e o CI sabe publicá-la.
 *
 * Dois defeitos, a mesma raiz: o repo não mandava em nada do que roda no Supabase.
 *
 *  1. Merge na main NÃO publicava Edge Function (a Vercel publica o site; function
 *     só subia à mão). Em 31/08/2026 a auditoria achou a `quita-fechar` no ar com a
 *     versão de 17/07 — sem o fix do #463, mergeado em 30/07 — e o #590 do
 *     `zapsign-webhook`, mergeado três dias antes, nunca publicado.
 *  2. Sem `config.toml`, a CLI deploya com `verify_jwt` LIGADO por padrão. Isso
 *     derrubou a `bia-cobranca` (25-26/08/2026): o gateway passou a rejeitar o token
 *     do cron, cada ciclo virava `POST | 401`, e `cron.job_run_details` marcava
 *     "succeeded" — porque o pg_net recebeu resposta HTTP; ela é que era 401.
 *
 * O que este teste trava: função nova sem entrada no config.toml. Sem a entrada ela
 * subiria com o padrão — que é justamente o defeito 2. Falhar aqui é barato; achar
 * um mês depois, olhando o cron, não é.
 *
 * Como rodar:
 *   node test/f10_edge_functions_declaradas.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DIR_FN = path.join(RAIZ, 'supabase', 'functions');
const CONFIG = path.join(RAIZ, 'supabase', 'config.toml');
const CI = path.join(RAIZ, '.github', 'workflows', 'ci.yml');

let falhas = 0;
function ok(nome, cond, detalhe) {
  if (cond) { console.log(`  ok  ${nome}`); return; }
  falhas++;
  console.error(`  FALHOU  ${nome}${detalhe ? ' — ' + detalhe : ''}`);
}

console.log('\nF-10 · Edge Functions declaradas.\n');

// ── O config.toml existe e é legível ────────────────────────────────────────
ok('supabase/config.toml existe', fs.existsSync(CONFIG),
  'sem ele a CLI usa verify_jwt=true por padrão em todo deploy');
if (!fs.existsSync(CONFIG)) { console.error('\n1 falha(s).'); process.exit(1); }

const toml = fs.readFileSync(CONFIG, 'utf8');

// Parser mínimo: só o que interessa é [functions.<slug>] + verify_jwt = <bool>.
// Não vale trazer dependência nova para o CI por causa de duas linhas.
const declarado = {};
let atual = null;
for (const linha of toml.split('\n')) {
  const cab = linha.match(/^\s*\[functions\.([A-Za-z0-9_-]+)\]\s*$/);
  if (cab) { atual = cab[1]; declarado[atual] = undefined; continue; }
  if (/^\s*\[/.test(linha)) { atual = null; continue; }
  const vj = linha.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/);
  if (vj && atual) declarado[atual] = vj[1] === 'true';
}

// ── Toda pasta de função tem entrada, e toda entrada tem pasta ──────────────
const noRepo = fs.readdirSync(DIR_FN, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_'))
  .map(d => d.name).sort();

ok(`todas as ${noRepo.length} funções do repo estão no config.toml`,
  noRepo.every(f => f in declarado),
  'sem declaração: ' + noRepo.filter(f => !(f in declarado)).join(', '));

ok('nenhuma entrada do config.toml aponta para pasta inexistente',
  Object.keys(declarado).every(f => noRepo.includes(f)),
  'órfãs: ' + Object.keys(declarado).filter(f => !noRepo.includes(f)).join(', '));

ok('todas as entradas dizem verify_jwt explicitamente',
  Object.entries(declarado).every(([, v]) => typeof v === 'boolean'),
  'sem valor: ' + Object.entries(declarado).filter(([, v]) => typeof v !== 'boolean')
    .map(([k]) => k).join(', '));

// ── verify_jwt = false exige autenticação PRÓPRIA no código ─────────────────
// Desligar o gateway sem colocar nada no lugar deixa o endpoint aberto. Estas duas
// bancadas de teste já estão assim em produção e são a exceção conhecida; qualquer
// função NOVA com false e sem checagem própria falha aqui.
//
// LIMITE DESTA GUARDA, para ninguém se sentir protegido demais: ela é TEXTUAL. Vê se
// o arquivo menciona um segredo, não se a checagem funciona. A `bia-cobranca-sync`
// passa aqui e mesmo assim estava aberta em 31/08/2026, porque fazia
//   `if (provided && provided !== segredo) return 401`
// — sem header nenhum, `provided` é vazio, o && curto-circuita e a função executa.
// Trava que só barra quem chuta errado. Correção é trabalho à parte; esta guarda não
// substitui ler o código de quem desliga o gateway.
const ABERTAS_CONHECIDAS = new Set(['bia-chat-teste', 'carlos-teste']);
const semTrava = [];
for (const [slug, vj] of Object.entries(declarado)) {
  if (vj !== false || ABERTAS_CONHECIDAS.has(slug)) continue;
  const idx = path.join(DIR_FN, slug, 'index.ts');
  if (!fs.existsSync(idx)) continue;
  const src = fs.readFileSync(idx, 'utf8');
  const temTrava = /(WEBHOOK_SECRET|INVOKE_SECRET|safeEqual|unauthorized)/i.test(src);
  if (!temTrava) semTrava.push(slug);
}
ok('toda função com verify_jwt=false valida um segredo próprio',
  semTrava.length === 0,
  'sem gateway E sem trava própria (endpoint aberto): ' + semTrava.join(', '));

// ── O CI sabe publicar ──────────────────────────────────────────────────────
const ci = fs.readFileSync(CI, 'utf8');
ok('o CI tem o passo de publicação das Edge Functions', ci.includes('deploy-functions'),
  'sem ele, merge na main volta a não publicar function');
ok('a publicação só roda em push na main',
  /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/.test(ci),
  'publicar a partir de PR/branch subiria código não revisado para produção');
ok('a publicação espera os testes passarem', /deploy-functions:\s*\n\s*needs:\s*test-and-lint/.test(ci),
  'sem `needs`, o deploy correria em paralelo com a suíte');

console.log('');
if (falhas) { console.error(`${falhas} falha(s).`); process.exit(1); }
console.log('F-10 · toda Edge Function declara verify_jwt e o CI publica o que muda.');

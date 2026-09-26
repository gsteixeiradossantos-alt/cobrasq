// Worker da coleta patrimonial (v4).
// Fontes públicas: base CNPJ no Supabase (sócio, endereço, telefone, e-mail),
// BrasilAPI (cadastro + QSA), ViaCEP, Portal da Transparência (CGU), PNCP e o
// que o Vigia de ações já gravou do DJEN. Sistemas restritos, CAPTCHA e
// credenciais de terceiros ficam fora.
//
// v4 (26/09/2026): telefone/e-mail → empresas, Portal da Transparência (flags
// federais do CPF/CNPJ e contratos federais), PNCP (contratos públicos, confere
// o documento do fornecedor) e processos do Vigia (polo A = crédito no rosto dos
// autos; polo P = rastro de bens).
//
// v3 (26/09/2026) parte da v2 publicada em 16/09 (o repo tinha ficado na v1, sem
// CORS) e corrige: vínculo por nome sem CPF conferido era gravado como
// "confirmada"; duas chamadas simultâneas processavam a mesma investigação;
// investigação presa em "em_andamento" (função derrubada no meio) nunca mais
// podia ser reprocessada; evidência de endereço de uma empresa sobrescrevia a
// da outra; "fontes concluídas" listava fonte que não chegou a rodar.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...cors },
});
const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const key = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const maskCnpj = (v: string) => {
  const d = dig(v);
  if (d.length !== 14) return d;
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
};
// Minutos sem conclusão a partir dos quais "em_andamento" é tratado como travado.
const TRAVADA_MIN = 10;
const REPROCESSAVEIS = ['pendente', 'falhou', 'aguardando_acesso'];

async function hash(v: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function evento(id: string, tipo: string, mensagem: string, dados = {}) {
  await sb.from('investigacao_eventos').insert({ investigacao_id: id, tipo, mensagem, dados });
}
async function evidencia(inv: string, entidade: string, fonte: string, titulo: string, trecho: string, url = '') {
  const h = await hash([fonte, titulo, trecho, url].join('|'));
  await sb.from('investigacao_evidencias').upsert({
    investigacao_id: inv, entidade_id: entidade, fonte_codigo: fonte, titulo, trecho,
    url: url || null, confianca: fonte === 'receita_rf' ? 85 : 75, hash_conteudo: h,
  }, { onConflict: 'investigacao_id,fonte_codigo,hash_conteudo' });
}
async function entidade(inv: string, tipo: string, nome: string, documento: string, profundidade: number, confianca: number, status: string, dados = {}) {
  const chave = dig(documento) || key(nome);
  const { data, error } = await sb.from('investigacao_entidades').upsert({
    investigacao_id: inv, tipo, nome: nome || null, documento: dig(documento) || null,
    chave_normalizada: chave, profundidade, confianca, status_verificacao: status, dados,
  }, { onConflict: 'investigacao_id,tipo,chave_normalizada' }).select('id').single();
  if (error) throw error;
  return data.id as string;
}
async function vinculo(inv: string, origem: string, destino: string, tipo: string, confianca: number, justificativa: string) {
  await sb.from('investigacao_vinculos').upsert({
    investigacao_id: inv, origem_entidade_id: origem, destino_entidade_id: destino, tipo, confianca, justificativa,
  }, { onConflict: 'investigacao_id,origem_entidade_id,destino_entidade_id,tipo' });
}

async function brasilApiCnpj(cnpj: string) {
  const url = `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`BrasilAPI HTTP ${res.status}`);
  return { url, json: await res.json() as any };
}

type Contadores = { pessoas: number; enriquecidas: number; confirmadas: number; pistas: number; recebiveis: number; processosAutor: number; processosReu: number; fontes: Set<string> };

// Situação cadastral da base CNPJ vem em código.
const SITUACAO: Record<string, string> = { '01': 'nula', '02': 'ativa', '03': 'suspensa', '04': 'inapta', '08': 'baixada' };
const situacaoTexto = (v: unknown) => { const c = String(v ?? '').padStart(2, '0'); return SITUACAO[c] || (v ? String(v) : null); };

// O QSA público mascara o CPF (***513639**). Se o nome do sócio é o da raiz e os
// seis dígitos batem com o CPF da raiz, é a própria raiz: reaproveita a entidade
// em vez de criar uma "pista" duplicada do devedor.
function ehRaiz(raiz: any, nome: string, docMascarado: string) {
  const cpf = dig(raiz?.documento), d = dig(docMascarado);
  return raiz?.tipo === 'pessoa' && cpf.length === 11 && d.length === 6 && cpf.slice(3, 9) === d && key(nome) === key(raiz.nome);
}

async function enriquecerEmpresa(inv: any, raiz: any, empresaId: string, cnpj: string, contadores: Contadores, naoConclusivas: string[]) {
  try {
    const { url, json: j } = await brasilApiCnpj(cnpj);
    contadores.enriquecidas++;
    contadores.fontes.add('brasilapi');
    const sit = j.descricao_situacao_cadastral || 'não informada';
    const porte = j.porte || j.descricao_porte || '';
    const cap = j.capital_social != null ? String(j.capital_social) : '';
    const cidade = [j.municipio, j.uf].filter(Boolean).join('/');
    await evidencia(inv.id, empresaId, 'brasilapi', 'Cadastro CNPJ consultado',
      `${j.razao_social || cnpj} · ${maskCnpj(cnpj)} · situação ${sit}${porte ? ' · porte ' + porte : ''}${cap ? ' · capital ' + cap : ''}${cidade ? ' · ' + cidade : ''}`, url);
    for (const q of (Array.isArray(j.qsa) ? j.qsa : []).slice(0, 30)) {
      const nome = String(q.nome_socio || '').trim();
      if (!nome) continue;
      const propria = ehRaiz(raiz, nome, q.cnpj_cpf_do_socio || '');
      if (propria && empresaId === raiz.id) continue;
      const idPessoa = propria ? raiz.id : await entidade(inv.id, 'pessoa', nome, q.cnpj_cpf_do_socio || '', 2, 60, 'pista', {
        qualificacao: q.qualificacao_socio || null, fonte: 'brasilapi',
      });
      if (propria) {
        await evidencia(inv.id, empresaId, 'brasilapi', 'Devedor no quadro societário',
          `${nome}${q.qualificacao_socio ? ' · ' + q.qualificacao_socio : ''} · em ${maskCnpj(cnpj)} · dígitos do CPF conferem`, url);
        continue;
      }
      await vinculo(inv.id, empresaId, idPessoa, 'tem_socio', 60, 'Quadro societário público da BrasilAPI; documento pode estar mascarado.');
      await evidencia(inv.id, idPessoa, 'brasilapi', 'Sócio no quadro societário',
        `${nome}${q.qualificacao_socio ? ' · ' + q.qualificacao_socio : ''} · em ${maskCnpj(cnpj)}`, url);
      contadores.pessoas++;
    }
  } catch (e) {
    naoConclusivas.push(`BrasilAPI ${maskCnpj(cnpj)}: ` + (e instanceof Error ? e.message : String(e)));
  }
}

// ── Fontes da v4 ────────────────────────────────────────────────────────────
type Achada = { id: string; cnpj: string; nome: string; confirmada: boolean };
const erroTxt = (e: unknown) => e instanceof Error ? e.message : String(e);
// Contrato encerrado não gera crédito a penhorar hoje: só o vigente conta como recebível.
const vigente = (fim: unknown) => !fim || String(fim).slice(0, 10) >= new Date().toISOString().slice(0, 10);
const brl = (v: unknown) => Number.isFinite(Number(v)) ? Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '';

// Telefone/e-mail → empresas (base CNPJ). O cadastro do MEI traz o telefone e o
// e-mail pessoais do titular: por isso as empresas confirmadas também entram
// como ponto de partida. Resultado é sempre pista (o contato pode ser de
// contador ou parente), salvo a própria empresa já achada.
async function porContato(inv: any, raiz: any, achadas: Map<string, Achada>, c: Contadores, nc: string[]) {
  const tels = new Map<string, string>(), emails = new Map<string, string>();
  const addTel = (t: unknown, origem: string) => { const d = dig(t); if (d.length >= 10) tels.set(d.slice(-11), tels.get(d.slice(-11)) || origem); };
  const addEmail = (e: unknown, origem: string) => { const v = String(e ?? '').trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) emails.set(v, emails.get(v) || origem); };
  if (inv.devedor_id) {
    const { data: d } = await sb.from('devedores').select('telefone,email').eq('id', inv.devedor_id).maybeSingle();
    String(d?.telefone || '').split(/[,;/]/).forEach(t => addTel(t, 'cadastro do devedor'));
    addEmail(d?.email, 'cadastro do devedor');
  }
  for (const a of [...achadas.values()].filter(a => a.confirmada)) {
    const { data: est } = await sb.from('rf_estabelecimentos').select('telefone1,telefone2,email')
      .eq('cnpj_basico', a.cnpj.slice(0, 8)).eq('cnpj_ordem', a.cnpj.slice(8, 12)).eq('cnpj_dv', a.cnpj.slice(12)).maybeSingle();
    addTel(est?.telefone1, `cadastro de ${maskCnpj(a.cnpj)}`);
    addTel(est?.telefone2, `cadastro de ${maskCnpj(a.cnpj)}`);
    addEmail(est?.email, `cadastro de ${maskCnpj(a.cnpj)}`);
  }
  if (!tels.size && !emails.size) { nc.push('Telefone/e-mail: devedor e empresas confirmadas sem telefone ou e-mail cadastrado.'); return; }
  const consultas = [
    ...[...tels].slice(0, 4).map(([v, o]) => ({ tipo: 'telefone', v, o, rpc: 'buscar_empresas_por_telefone', arg: { p_tel: v } })),
    ...[...emails].slice(0, 3).map(([v, o]) => ({ tipo: 'e-mail', v, o, rpc: 'buscar_empresas_por_email', arg: { p_email: v } })),
  ];
  for (const q of consultas) {
    const { data: rows, error } = await sb.rpc(q.rpc, q.arg);
    if (error) { nc.push(`Base CNPJ por ${q.tipo} indisponível: ${error.message}`); continue; }
    c.fontes.add('receita_rf');
    for (const r of (rows || []).slice(0, 10)) {
      const cnpj = dig(r.cnpj);
      if (cnpj.length !== 14 || achadas.has(cnpj)) continue;
      const compart = Number(r.compartilhado_com || 0);
      const escritorio = compart > 3;
      const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 1, escritorio ? 30 : 55, 'pista', {
        situacao: situacaoTexto(r.situacao), fonte: 'receita_rf', criterio: q.tipo === 'telefone' ? 'telefone' : 'email',
        municipio: r.municipio || null, uf: r.uf || null, compartilhado_com: compart || null,
      });
      achadas.set(cnpj, { id, cnpj, nome: r.nome || cnpj, confirmada: false });
      await vinculo(inv.id, raiz.id, id, q.tipo === 'telefone' ? 'compartilha_telefone' : 'compartilha_email', escritorio ? 30 : 55,
        `Mesmo ${q.tipo} (${q.o}) no cadastro CNPJ${escritorio ? `; usado por ${compart} CNPJs, provável contador/escritório` : ''}. Requer confirmação.`);
      await evidencia(inv.id, id, 'receita_rf', `Empresa com o mesmo ${q.tipo}`,
        `${r.nome || r.fantasia || cnpj} · ${maskCnpj(cnpj)} · ${q.tipo} ${q.v} (${q.o})${situacaoTexto(r.situacao) ? ' · ' + situacaoTexto(r.situacao) : ''}${compart ? ` · ${compart} CNPJ(s) usam este contato` : ''}`);
      c.pistas++;
    }
  }
}

// Portal da Transparência (CGU): flags federais do CPF e contratos federais do
// CPF/CNPJ. Chave pessoal no segredo PORTAL_TRANSPARENCIA_KEY.
const PT_BASE = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const PT_FLAGS: Record<string, string> = {
  servidor: 'servidor público federal (salário penhorável no limite legal)', servidorInativo: 'servidor federal inativo',
  pensionistaOuRepresentanteLegal: 'pensionista federal', contratado: 'contratado pelo governo federal',
  favorecidoDespesas: 'recebeu pagamentos federais', participanteLicitacao: 'participou de licitação federal',
  permissionario: 'permissionário federal', beneficiarioDiarias: 'recebeu diárias federais',
  sancionadoCEIS: 'sancionado (CEIS)', sancionadoCNEP: 'sancionado (CNEP)', sancionadoCEAF: 'expulso da Administração (CEAF)',
  favorecidoBpc: 'recebe BPC (impenhorável)', favorecidoNovoBolsaFamilia: 'recebe Bolsa Família (impenhorável)',
  favorecidoBolsaFamilia: 'recebeu Bolsa Família (impenhorável)', favorecidoAuxilioBrasil: 'recebeu Auxílio Brasil (impenhorável)',
  auxilioEmergencial: 'recebeu Auxílio Emergencial', favorecidoSeguroDefeso: 'recebeu Seguro-Defeso',
  favorecidoTransferencias: 'favorecido em transferências federais',
};
const PJ_FLAGS: Record<string, string> = {
  possuiContratacao: 'tem contrato com o governo federal', favorecidoDespesas: 'recebeu pagamentos federais',
  participanteLicitacao: 'participou de licitação federal', convenios: 'tem convênio federal',
  favorecidoTransferencias: 'favorecida em transferências federais', sancionadoCEIS: 'sancionada (CEIS)',
  sancionadoCNEP: 'sancionada (CNEP)', sancionadoCEPIM: 'impedida (CEPIM)',
};
async function ptGet(path: string, chave: string) {
  const res = await fetch(PT_BASE + path, { headers: { 'chave-api-dados': chave, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = await res.text();
  return t.trim() ? JSON.parse(t) : null;
}
async function portalTransparencia(inv: any, raiz: any, achadas: Map<string, Achada>, c: Contadores, nc: string[]) {
  const chave = Deno.env.get('PORTAL_TRANSPARENCIA_KEY') || '';
  if (!chave) { nc.push('Portal da Transparência: chave não configurada no Supabase.'); return false; }
  const alvos = [] as { id: string; doc: string; nome: string }[];
  if (dig(raiz.documento).length === 11 || dig(raiz.documento).length === 14) alvos.push({ id: raiz.id, doc: dig(raiz.documento), nome: raiz.nome || '' });
  for (const a of achadas.values()) if (a.confirmada && a.cnpj !== dig(raiz.documento)) alvos.push({ id: a.id, doc: a.cnpj, nome: a.nome });
  if (!alvos.length) { nc.push('Portal da Transparência: sem CPF/CNPJ conferido para consultar.'); return false; }
  let recebe = false, ok = false;
  for (const a of alvos.slice(0, 6)) {
    const pf = a.doc.length === 11;
    try {
      const p = await ptGet(pf ? `/pessoa-fisica?cpf=${a.doc}` : `/pessoa-juridica?cnpj=${a.doc}`, chave);
      ok = true;
      c.fontes.add('portal_transparencia');
      const flags = Object.entries(pf ? PT_FLAGS : PJ_FLAGS).filter(([k]) => p?.[k] === true).map(([, v]) => v);
      // Pagamento/contrato no passado não é recebível hoje; servidor e pensionista são.
      if (p?.servidor === true || p?.servidorInativo === true || p?.pensionistaOuRepresentanteLegal === true) recebe = true;
      await evidencia(inv.id, a.id, 'portal_transparencia', pf ? 'Cadastro federal do CPF' : 'Cadastro federal do CNPJ',
        `${a.nome || a.doc} · ${pf ? 'CPF' : maskCnpj(a.doc)} · ${p ? (flags.length ? flags.join('; ') : 'nenhum vínculo federal registrado') : 'documento sem registro no Portal'}`,
        `https://portaldatransparencia.gov.br/${pf ? 'pessoa-fisica/busca/lista?termo=' + encodeURIComponent(a.nome) : 'pessoa-juridica/' + a.doc}`);
      const contratos = await ptGet(`/contratos/cpf-cnpj?cpfCnpj=${a.doc}&pagina=1`, chave);
      for (const k of (Array.isArray(contratos) ? contratos : []).slice(0, 10)) {
        const ativo = vigente(k?.dataFimVigencia);
        const orgao = k?.unidadeGestora?.orgaoMaximo?.nome || k?.unidadeGestora?.nome || 'órgão federal';
        const vig = [k?.dataInicioVigencia, k?.dataFimVigencia].filter(Boolean).join(' a ');
        await evidencia(inv.id, a.id, 'portal_transparencia', 'Contrato federal',
          `Contrato ${k?.numero || k?.id || ''} · ${orgao}${k?.valorFinalCompra != null ? ' · ' + brl(k.valorFinalCompra) : k?.valorInicialCompra != null ? ' · ' + brl(k.valorInicialCompra) : ''}${vig ? ' · vigência ' + vig : ''} · ${String(k?.objeto || '').replace(/^Objeto:\s*/i, '').slice(0, 240)} · ${ativo ? 'vigente: crédito penhorável junto ao órgão pagador' : 'encerrado'}`,
          k?.id ? `https://portaldatransparencia.gov.br/contratos/${k.id}` : '');
        if (ativo) { recebe = true; c.recebiveis++; }
      }
    } catch (e) {
      nc.push(`Portal da Transparência ${pf ? 'CPF' : maskCnpj(a.doc)}: ${erroTxt(e)}`);
    }
  }
  return ok ? recebe : null;
}

// PNCP: busca textual de contratos por nome; o detalhe de cada contrato traz o
// CPF/CNPJ do fornecedor. Confirma quando o documento bate; mesmo nome sem
// documento igual fica como pista; o resto é ruído da busca textual.
const PNCP_UA = { 'User-Agent': 'Mozilla/5.0 (compatible; COBRASQ investigacao)', Accept: 'application/json' };
async function pncp(inv: any, raiz: any, achadas: Map<string, Achada>, c: Contadores, nc: string[]) {
  const alvos = [] as { id: string; doc: string; nome: string }[];
  if (raiz.nome) alvos.push({ id: raiz.id, doc: dig(raiz.documento), nome: raiz.nome });
  for (const a of achadas.values()) if (a.confirmada && a.cnpj !== dig(raiz.documento)) alvos.push({ id: a.id, doc: a.cnpj, nome: a.nome });
  let recebe = false, ok = false;
  for (const a of alvos.slice(0, 4)) {
    const nomeBusca = a.nome.replace(/\s*\d{11}\s*$/, '').trim();   // MEI: tira o CPF da razão social
    if (nomeBusca.length < 8) continue;
    try {
      const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent('"' + nomeBusca + '"')}&tipos_documento=contrato&ordenacao=-data&pagina=1&tam_pagina=8`;
      const res = await fetch(url, { headers: PNCP_UA, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      ok = true;
      c.fontes.add('pncp');
      for (const it of (Array.isArray(j?.items) ? j.items : []).slice(0, 8)) {
        if (!it?.item_url) continue;
        const dr = await fetch(`https://pncp.gov.br/api/pncp/v1/orgaos${String(it.item_url).replace(/^\/contratos/, '').replace(/^\/(\d{14})\/(\d{4})\/(\d+)$/, '/$1/contratos/$2/$3')}`,
          { headers: PNCP_UA, signal: AbortSignal.timeout(15000) });
        if (!dr.ok) continue;
        const d: any = await dr.json();
        const ni = dig(d?.niFornecedor);
        const mesmoDoc = !!a.doc && ni === a.doc;
        const mesmoNome = key(d?.nomeRazaoSocialFornecedor) === key(nomeBusca) || key(d?.nomeRazaoSocialFornecedor) === key(a.nome);
        if (!mesmoDoc && !mesmoNome) continue;
        const link = `https://pncp.gov.br/app${it.item_url}`;
        const trecho = `${d?.nomeRazaoSocialFornecedor || ''} · ${ni.length === 14 ? maskCnpj(ni) : ni.length === 11 ? 'CPF do fornecedor' : 'fornecedor'} · ${it.orgao_nome || ''}${it.municipio_nome ? ' (' + it.municipio_nome + '/' + (it.uf || '') + ')' : ''} · ${brl(d?.valorGlobal ?? it.valor_global)} · vigência ${it.data_inicio_vigencia || '?'} a ${it.data_fim_vigencia || '?'} · ${String(d?.objetoContrato || it.description || '').slice(0, 200)}`;
        if (mesmoDoc) {
          const ativo = vigente(it.data_fim_vigencia);
          if (ativo) { recebe = true; c.recebiveis++; }
          await evidencia(inv.id, a.id, 'pncp', 'Contrato público (documento confere)', trecho + (ativo ? ' · vigente: crédito penhorável junto ao órgão contratante' : ' · encerrado'), link);
        } else {
          await evidencia(inv.id, a.id, 'pncp', 'Contrato público com o mesmo nome (conferir documento)', trecho + ' · documento do fornecedor não conferido: homônimo possível', link);
          c.pistas++;
        }
      }
    } catch (e) {
      nc.push(`PNCP (${nomeBusca}): ${erroTxt(e)}`);
    }
  }
  return ok ? recebe : null;
}

// DJEN via Vigia de ações: não consulta o DJEN (ele bloqueia chamadas do
// Supabase); reaproveita o que o Vigia já gravou em vigia_acoes para o devedor.
// Polo A (devedor é autor) = crédito a penhorar no rosto dos autos; polo P
// (réu) = outros credores e rastro de bens. cpf_confere decide confirmada/pista.
async function vigiaDjen(inv: any, raiz: any, c: Contadores, nc: string[]) {
  if (!inv.devedor_id) { nc.push('DJEN/Vigia: investigação sem devedor vinculado.'); return; }
  const { data: rows, error } = await sb.from('vigia_acoes')
    .select('id,numero_processo,digitos,polo,tribunal,classe,orgao,link,primeira_data,ultima_data,qtd_comunicacoes,cpf_confere,nome_encontrado,status')
    .eq('devedor_id', inv.devedor_id).neq('status', 'descartado').order('ultima_data', { ascending: false }).limit(30);
  if (error) { nc.push('DJEN/Vigia indisponível: ' + error.message); return; }
  c.fontes.add('djen');
  if (!rows?.length) { nc.push('DJEN/Vigia: o Vigia de ações ainda não encontrou (ou não varreu) processo deste devedor.'); return; }
  for (const r of rows) {
    const num = String(r.numero_processo || '').trim();
    const d = dig(r.digitos || num);
    if (!d) continue;
    const confirmado = r.cpf_confere === true;
    const papel = r.polo === 'A' ? 'autor' : r.polo === 'P' ? 'réu' : 'parte (polo não identificado)';
    const uso = r.polo === 'A' ? 'devedor é autor: possível crédito a penhorar no rosto dos autos'
      : r.polo === 'P' ? 'devedor é réu: outros credores disputando os mesmos bens e rastro patrimonial nos autos'
      : 'conferir o polo nos autos';
    const id = await entidade(inv.id, 'processo', num || d, d, 1, confirmado ? 85 : 55, confirmado ? 'confirmada' : 'pista', {
      numero: num, tribunal: r.tribunal || null, classe: r.classe || null, orgao: r.orgao || null, polo: r.polo || null,
      primeira_data: r.primeira_data || null, ultima_data: r.ultima_data || null, fonte: 'djen', vigia_id: r.id, link: r.link || null,
    });
    await vinculo(inv.id, raiz.id, id, r.polo === 'A' ? 'autor_em' : r.polo === 'P' ? 'reu_em' : 'parte_em', confirmado ? 85 : 55,
      confirmado ? 'CPF do devedor conferido na comunicação do DJEN.' : `Encontrado pelo nome${r.nome_encontrado ? ' "' + r.nome_encontrado + '"' : ''}; CPF não conferido: homônimo possível.`);
    await evidencia(inv.id, id, 'djen', r.polo === 'A' ? 'Processo em que o devedor é autor' : 'Processo com o devedor no polo passivo',
      `${num} · ${[r.tribunal, r.orgao].filter(Boolean).join(' · ')}${r.classe ? ' · ' + r.classe : ''} · ${papel} · ${r.qtd_comunicacoes || 0} comunicação(ões) de ${r.primeira_data || '?'} a ${r.ultima_data || '?'} · ${uso}${confirmado ? '' : ' · CPF não conferido'}`,
      r.link || '');
    if (confirmado) c.confirmadas++; else c.pistas++;
    if (r.polo === 'A') c.processosAutor++; else c.processosReu++;
  }
}

async function processar(inv: any) {
  const { data: raizes, error } = await sb.from('investigacao_entidades').select('*').eq('investigacao_id', inv.id).eq('profundidade', 0).limit(1);
  if (error || !raizes?.[0]) throw error || new Error('Entidade-raiz ausente');
  const raiz = raizes[0];
  let empresas = 0;
  const contadores: Contadores = { pessoas: 0, enriquecidas: 0, confirmadas: 0, pistas: 0, recebiveis: 0, processosAutor: 0, processosReu: 0, fontes: new Set() };
  const achadas = new Map<string, Achada>();
  const naoConclusivas: string[] = [];
  const teto = Math.max(0, Math.min(Number(inv.entidades_maximas || 80) - 1, 40));
  await evento(inv.id, 'fonte_iniciada', 'Iniciada consulta em fontes públicas.', { fontes: ['receita_rf', 'brasilapi', 'viacep', 'portal_transparencia', 'pncp', 'djen'] });

  if (raiz.tipo === 'pessoa' && raiz.nome) {
    const { data: rows, error: rpcError } = await sb.rpc('buscar_empresas_por_socio', { p_nome: raiz.nome, p_cpf: dig(raiz.documento) || null });
    if (rpcError) naoConclusivas.push('Receita/base CNPJ indisponível: ' + rpcError.message);
    else contadores.fontes.add('receita_rf');
    for (const r of (rows || []).slice(0, teto)) {
      const cnpj = dig(r.cnpj);
      if (cnpj.length !== 14) continue;
      // Só o CPF conferido nos dígitos públicos do QSA confirma o vínculo. Sem
      // essa conferência (confere null/false) é homônimo possível: fica como pista.
      // MEI leva o CPF do titular na razão social: isso também confirma.
      const cpfRaiz = dig(raiz.documento);
      const cpfNaRazao = cpfRaiz.length === 11 && dig(r.nome).endsWith(cpfRaiz);
      const conferido = r.confere === true || cpfNaRazao;
      const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 1, conferido ? 90 : 65, conferido ? 'confirmada' : 'pista', {
        situacao: situacaoTexto(r.situacao), papel: r.papel || null, fonte: 'receita_rf',
      });
      await vinculo(inv.id, raiz.id, id, 'socio_de', conferido ? 90 : 65,
        r.confere === true ? 'CPF confirmado pelos seis dígitos públicos do QSA.'
          : cpfNaRazao ? 'MEI: CPF do devedor consta na razão social.'
          : 'Vínculo por nome; requer confirmação antes de uso.');
      await evidencia(inv.id, id, 'receita_rf', 'Empresa vinculada na base CNPJ',
        `${r.nome || r.fantasia || cnpj} · CNPJ ${maskCnpj(cnpj)} · ${r.papel || 'vínculo societário'}${situacaoTexto(r.situacao) ? ' · ' + situacaoTexto(r.situacao) : ''}`);
      empresas++;
      achadas.set(cnpj, { id, cnpj, nome: r.nome || r.fantasia || cnpj, confirmada: conferido });
      if (conferido) contadores.confirmadas++; else contadores.pistas++;
      await enriquecerEmpresa(inv, raiz, id, cnpj, contadores, naoConclusivas);
    }

    const end = (raiz.dados || {}).endereco || {};
    const cep = dig(end.cep), numero = String(end.numero || '').trim();
    if (cep.length === 8 && numero) {
      try {
        const vr = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(10000) });
        const v: any = await vr.json();
        const rua = String(v?.logradouro || '').trim();
        contadores.fontes.add('viacep');
        if (!rua || v?.erro) {
          naoConclusivas.push(`ViaCEP: CEP ${cep} sem logradouro específico; cruzamento de endereço não executado.`);
        } else {
          const { data: porEndereco, error: ee } = await sb.rpc('buscar_empresas_por_endereco', { p_cep: cep, p_numero: numero, p_logradouro: rua });
          if (ee) naoConclusivas.push('Receita/endereço indisponível: ' + ee.message);
          for (const r of (porEndereco || []).slice(0, 20)) {
            const cnpj = dig(r.cnpj);
            // Empresa já achada pelo sócio não é rebaixada a pista pelo endereço.
            if (cnpj.length !== 14 || achadas.has(cnpj)) continue;
            const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 1, 45, 'pista', {
              situacao: situacaoTexto(r.situacao), fonte: 'receita_rf', criterio: 'endereco_fiscal',
            });
            await vinculo(inv.id, raiz.id, id, 'compartilha_endereco_fiscal', 45,
              'Endereço fiscal compatível; requer confirmação independente antes de qualquer medida.');
            // O CNPJ entra no trecho: sem ele o hash era igual para todas as
            // empresas do endereço e cada upsert roubava a evidência da anterior.
            await evidencia(inv.id, id, 'viacep', 'CEP validado antes do cruzamento', `${rua}, ${numero} · CEP ${cep} · ${maskCnpj(cnpj)}`, 'https://viacep.com.br/');
            achadas.set(cnpj, { id, cnpj, nome: r.nome || cnpj, confirmada: false });
            contadores.pistas++;
          }
        }
      } catch (e) {
        naoConclusivas.push('ViaCEP não conclusivo: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  } else if (raiz.tipo === 'empresa' && dig(raiz.documento).length === 14) {
    const cnpj = dig(raiz.documento);
    empresas = 1;
    achadas.set(cnpj, { id: raiz.id, cnpj, nome: raiz.nome || cnpj, confirmada: true });
    await enriquecerEmpresa(inv, raiz, raiz.id, cnpj, contadores, naoConclusivas);
  } else {
    naoConclusivas.push('Pessoa sem nome: a base CNPJ só é pesquisada por nome (com CPF para conferir).');
  }

  // Cada fonte nova isola as próprias falhas: uma que cair não derruba as outras.
  const segura = async <T>(nome: string, f: () => Promise<T>) => {
    try { return await f(); } catch (e) { naoConclusivas.push(`${nome}: ${erroTxt(e)}`); return null; }
  };
  await segura('Telefone/e-mail', () => porContato(inv, raiz, achadas, contadores, naoConclusivas));
  const recebePt = await segura('Portal da Transparência', () => portalTransparencia(inv, raiz, achadas, contadores, naoConclusivas));
  const recebePncp = await segura('PNCP', () => pncp(inv, raiz, achadas, contadores, naoConclusivas));
  await segura('DJEN/Vigia', () => vigiaDjen(inv, raiz, contadores, naoConclusivas));
  const recebeEntePublico = recebePt === true || recebePncp === true ? true : (recebePt === false && recebePncp !== null ? false : null);

  const componentes = [] as any[];
  if (empresas) componentes.push({ rotulo: 'Empresas vinculadas', pontos: Math.min(empresas * 10, 20), explicacao: `${empresas} vínculo(s) societário(s) retornado(s) por fonte pública.` });
  if (contadores.pessoas) componentes.push({ rotulo: 'Quadro societário identificado', pontos: Math.min(contadores.pessoas * 4, 15), explicacao: `${contadores.pessoas} pessoa(s) listada(s) no CNPJ; são pistas até confirmação.` });
  if (contadores.enriquecidas) componentes.push({ rotulo: 'Cadastro CNPJ enriquecido', pontos: Math.min(contadores.enriquecidas * 5, 10), explicacao: `${contadores.enriquecidas} empresa(s) consultada(s) na BrasilAPI (situação, capital, QSA).` });
  if (contadores.recebiveis) componentes.push({ rotulo: 'Recebe de ente público', pontos: Math.min(contadores.recebiveis * 10, 25), explicacao: `${contadores.recebiveis} contrato(s) público(s) vigente(s) com documento conferido: crédito penhorável junto ao órgão pagador.` });
  if (contadores.processosAutor) componentes.push({ rotulo: 'Processos como autor', pontos: Math.min(contadores.processosAutor * 5, 15), explicacao: `${contadores.processosAutor} processo(s) em que o devedor é autor (Vigia/DJEN): possível penhora no rosto dos autos.` });
  if (contadores.processosReu) componentes.push({ rotulo: 'Processos como réu', pontos: Math.min(contadores.processosReu * 2, 10), explicacao: `${contadores.processosReu} processo(s) com o devedor no polo passivo (Vigia/DJEN): outros credores e rastro de bens.` });
  const score = Math.min(100, componentes.reduce((s, x) => s + Number(x.pontos || 0), 0));
  const resumo = {
    entidades_confirmadas: contadores.confirmadas + (raiz.status_verificacao === 'confirmada' ? 1 : 0),
    entidades_pista: contadores.pistas + contadores.pessoas,
    fontes_concluidas: [...contadores.fontes],
    fontes_nao_conclusivas: naoConclusivas,
    recebe_ente_publico: recebeEntePublico,
    processos_autor: contadores.processosAutor,
    processos_reu: contadores.processosReu,
    cobertura_processual: 'Processos vêm só do que o Vigia de ações já achou no DJEN (comunicações publicadas). Ausência de processo no relatório não significa ausência de ação.',
  };
  await sb.from('investigacoes_patrimoniais').update({
    status: naoConclusivas.length && !(empresas || contadores.pessoas || contadores.confirmadas || contadores.pistas || contadores.recebiveis) ? 'aguardando_acesso' : 'concluida',
    concluido_em: new Date().toISOString(),
    score_prioridade: score,
    score_componentes: componentes,
    resumo,
  }).eq('id', inv.id);
  await evento(inv.id, naoConclusivas.length ? 'fonte_nao_conclusiva' : 'fonte_concluida',
    naoConclusivas.length ? naoConclusivas.join(' | ') : 'Fontes públicas concluídas.', resumo);
  return { id: inv.id, empresas, pessoas: contadores.pessoas, naoConclusivas };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const authorization = req.headers.get('authorization') || '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: 'unauthorized' }, 401);
  const body = await req.json().catch(() => ({}));
  const id = String(body.investigacao_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json({ error: 'investigacao_id inválido' }, 400);
  // A consulta usa a sessão do CRM e a RLS: o service role só entra depois de
  // comprovar que este usuário pode ler exatamente esta investigação.
  const { data: inv, error } = await userClient.from('investigacoes_patrimoniais').select('*').eq('id', id).single();
  if (error || !inv) return json({ error: 'investigação não encontrada ou sem acesso' }, 404);
  // Reserva atômica: só um chamado passa do "pendente" para "em_andamento". Um
  // "em_andamento" parado há mais de TRAVADA_MIN minutos é tomado de volta.
  const travadaAntes = new Date(Date.now() - TRAVADA_MIN * 60000).toISOString();
  const { data: reservada } = await sb.from('investigacoes_patrimoniais')
    .update({ status: 'em_andamento', iniciado_em: new Date().toISOString() })
    .eq('id', id)
    .or(`status.in.(${REPROCESSAVEIS.join(',')}),and(status.eq.em_andamento,iniciado_em.lt."${travadaAntes}")`)
    .select('*');
  if (!reservada?.length) return json({ ok: true, id, status: inv.status, mensagem: inv.status === 'em_andamento' ? 'Investigação já está sendo processada.' : 'Investigação já processada.' });
  try { return json({ ok: true, resultado: await processar(reservada[0]) }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('investigacoes_patrimoniais').update({ status: 'falhou', resumo: { erro: msg } }).eq('id', id);
    await evento(id, 'status', 'Falha na coleta: ' + msg);
    return json({ error: msg }, 500);
  }
});

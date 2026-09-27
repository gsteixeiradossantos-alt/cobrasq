// Worker da coleta patrimonial (v8).
// v8 (26/09/2026): INPI (marcas do devedor pelo nome + CPF conferido; marcas e
// patentes das empresas pelo CNPJ; CPF completo do sócio quando o INPI mostra e
// os 6 dígitos do QSA batem), DataJud (classe, assuntos, órgão e último
// andamento dos processos; segredo DATAJUD_API_KEY) e sinais de bem/dinheiro no
// texto das publicações do DJEN. O INPI não responde a IP dos EUA: o worker se
// chama com x-region: sa-east-1 (acao 'sp'), e o braço de São Paulo só busca e lê,
// sem gravar. O texto do DJEN vai pelo mesmo braço; se falhar, fica o
// ultimo_texto que o Vigia gravou.
// v7 (26/09/2026): com profundidade 2, busca as outras empresas dos sócios das
// empresas confirmadas (nome + 6 dígitos do CPF) e cruza o endereço fiscal
// delas; detalha sanções CEIS/CNEP; grava capital social; resumo.cortes lista o
// que ficou de fora por limite.
// v6 (26/09/2026): investigação avulsa (sem devedor) consulta o DJEN pelo nome:
// o painel busca no navegador e manda as comunicações em body.djen.
// v5 (26/09/2026): grava a data de abertura (BrasilAPI data_inicio_atividade) em
// dados.data_abertura de cada empresa enriquecida.
//
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
// Filtro do Vigia reaproveitado. Mudou logica.mjs? Republicar também este worker
// (o CI só republica a pasta que mudou).
import { agruparAchados, filtrarTruncado } from "../vigia-acoes/logica.mjs";
// Leitura pura das fontes da v8 (INPI, DataJud, texto do DJEN): testada no F-49.
import { aliasDatajud, datajudResumo, inpiMarcas, inpiPatentes, inpiTitulares, marcaViva, sinaisTexto, titularConfere } from "./fontes.mjs";

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
async function entidade(inv: string, tipo: string, nome: string, documento: string, profundidade: number, confianca: number, status: string, dados: Record<string, unknown> = {}) {
  const chave = dig(documento) || key(nome);
  // Pista confirmada à mão no painel (botão "Confirmar pista") sobrevive ao reprocessamento.
  const { data: ant } = await sb.from('investigacao_entidades').select('dados').eq('investigacao_id', inv).eq('tipo', tipo).eq('chave_normalizada', chave).maybeSingle();
  const manual = (ant?.dados as any)?.confirmado_manual;
  if (manual) { status = 'confirmada'; dados = { ...dados, confirmado_manual: manual }; }
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

// `cortes` lista os limites que deixaram algo de fora: vai ao relatório para o
// leitor saber que a busca não foi exaustiva (e onde).
type Contadores = { pessoas: number; enriquecidas: number; confirmadas: number; pistas: number; recebiveis: number; processosAutor: number; processosReu: number; marcasVivas: number; patentes: number; sinais: number; fontes: Set<string>; cortes: string[] };
type Socio = { id: string; nome: string; miolo: string; empresa: string };

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

async function enriquecerEmpresa(inv: any, raiz: any, empresaId: string, cnpj: string, contadores: Contadores, naoConclusivas: string[]): Promise<Socio[]> {
  const socios: Socio[] = [];
  try {
    const { url, json: j } = await brasilApiCnpj(cnpj);
    contadores.enriquecidas++;
    contadores.fontes.add('brasilapi');
    const sit = j.descricao_situacao_cadastral || 'não informada';
    const porte = j.porte || j.descricao_porte || '';
    const cap = j.capital_social != null ? String(j.capital_social) : '';
    const cidade = [j.municipio, j.uf].filter(Boolean).join('/');
    const abertura = /^\d{4}-\d{2}-\d{2}$/.test(String(j.data_inicio_atividade || '')) ? j.data_inicio_atividade : null;
    // Data de abertura alimenta o sinal "sócio em várias empresas recém-abertas" no
    // painel. Mescla em dados sem apagar o que a base CNPJ já gravou.
    // Capital social numérico alimenta o sinal "capital irrisório perto da dívida".
    const capital = Number.isFinite(Number(j.capital_social)) ? Number(j.capital_social) : null;
    if (abertura || capital != null) {
      const { data: atual } = await sb.from('investigacao_entidades').select('dados').eq('id', empresaId).single();
      await sb.from('investigacao_entidades').update({ dados: {
        ...(atual?.dados || {}), ...(abertura ? { data_abertura: abertura } : {}), ...(capital != null ? { capital_social: capital } : {}),
      } }).eq('id', empresaId);
    }
    await evidencia(inv.id, empresaId, 'brasilapi', 'Cadastro CNPJ consultado',
      `${j.razao_social || cnpj} · ${maskCnpj(cnpj)} · situação ${sit}${abertura ? ' · aberta em ' + abertura.split('-').reverse().join('/') : ''}${porte ? ' · porte ' + porte : ''}${cap ? ' · capital ' + cap : ''}${cidade ? ' · ' + cidade : ''}`, url);
    const qsa = Array.isArray(j.qsa) ? j.qsa : [];
    if (qsa.length > 30) contadores.cortes.push(`Quadro societário de ${maskCnpj(cnpj)}: ${qsa.length} sócios, lidos os 30 primeiros.`);
    for (const q of qsa.slice(0, 30)) {
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
      const miolo = dig(q.cnpj_cpf_do_socio);
      if (miolo.length === 6) socios.push({ id: idPessoa, nome, miolo, empresa: cnpj });
    }
  } catch (e) {
    naoConclusivas.push(`BrasilAPI ${maskCnpj(cnpj)}: ` + erroTxt(e));
  }
  return socios;
}

// Empresas dos sócios: o QSA público só mostra 6 dígitos do CPF, e a RPC da base
// CNPJ confere exatamente esses 6 (miolo). Passa o CPF "000"+miolo+"00" e só
// aceita confere=true: nome igual com miolo diferente é homônimo e fica de fora.
// Sai sempre como pista: é a teia do devedor (grupo econômico, confusão
// patrimonial), não bem dele. Cada consulta leva até ~11 s com o cache frio,
// por isso há teto de sócios e de tempo.
const SOCIOS_MAX = 6;
async function empresasDosSocios(inv: any, socios: Socio[], achadas: Map<string, Achada>, c: Contadores, nc: string[], prazo: number) {
  const unicos = [...new Map(socios.map(s => [key(s.nome) + s.miolo, s])).values()];
  if (unicos.length > SOCIOS_MAX) c.cortes.push(`Empresas dos sócios: ${unicos.length} sócios nas empresas confirmadas, pesquisados os ${SOCIOS_MAX} primeiros.`);
  let feitos = 0;
  for (const s of unicos.slice(0, SOCIOS_MAX)) {
    if (Date.now() > prazo) { c.cortes.push(`Empresas dos sócios: tempo esgotado, ${unicos.slice(0, SOCIOS_MAX).length - feitos} sócio(s) não pesquisado(s).`); break; }
    const arg = { p_nome: s.nome, p_cpf: '000' + s.miolo + '00' };
    let { data: rows, error } = await sb.rpc('buscar_empresas_por_socio', arg);
    if (error && /timeout/i.test(error.message)) ({ data: rows, error } = await sb.rpc('buscar_empresas_por_socio', arg));
    feitos++;
    if (error) { nc.push(`Empresas do sócio ${s.nome}: ${erroTxt(error.message)}`); continue; }
    c.fontes.add('receita_rf');
    const delas = (rows || []).filter((r: any) => r.confere === true && dig(r.cnpj).length === 14 && !achadas.has(dig(r.cnpj)));
    if (delas.length > 10) c.cortes.push(`Empresas do sócio ${s.nome}: ${delas.length} empresas, gravadas as 10 primeiras.`);
    for (const r of delas.slice(0, 10)) {
      const cnpj = dig(r.cnpj);
      const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 2, 60, 'pista', {
        situacao: situacaoTexto(r.situacao), papel: r.papel || null, fonte: 'receita_rf', criterio: 'empresa_do_socio',
      });
      await vinculo(inv.id, s.id, id, 'socio_de', 60,
        `Sócio de ${maskCnpj(s.empresa)}; nome e seis dígitos públicos do CPF conferem na base CNPJ.`);
      await evidencia(inv.id, id, 'receita_rf', 'Outra empresa do sócio',
        `${r.nome || r.fantasia || cnpj} · CNPJ ${maskCnpj(cnpj)} · ${r.papel || 'sócio'}: ${s.nome} (também sócio de ${maskCnpj(s.empresa)})${situacaoTexto(r.situacao) ? ' · ' + situacaoTexto(r.situacao) : ''}`);
      achadas.set(cnpj, { id, cnpj, nome: r.nome || cnpj, confirmada: false });
      c.pistas++;
    }
  }
}

// Endereço das empresas confirmadas → outras empresas no mesmo endereço fiscal.
// Endereço com muitos CNPJs é de contador, coworking ou galeria: registra a
// ressalva e não gera pista (seria só ruído).
const ENDERECO_ESCRITORIO = 3, ENDERECO_MASSA = 10;
async function enderecoDasEmpresas(inv: any, achadas: Map<string, Achada>, c: Contadores, nc: string[], prazo: number) {
  const confirmadas = [...achadas.values()].filter(a => a.confirmada);
  if (confirmadas.length > 4) c.cortes.push(`Endereço das empresas: ${confirmadas.length} empresas confirmadas, cruzados os endereços das 4 primeiras.`);
  const vistos = new Set<string>();
  for (const a of confirmadas.slice(0, 4)) {
    if (Date.now() > prazo) { c.cortes.push('Endereço das empresas: tempo esgotado antes de cruzar todos os endereços.'); break; }
    const { data: est } = await sb.from('rf_estabelecimentos').select('cep,numero,logradouro,tipo_logradouro,municipio')
      .eq('cnpj_basico', a.cnpj.slice(0, 8)).eq('cnpj_ordem', a.cnpj.slice(8, 12)).eq('cnpj_dv', a.cnpj.slice(12)).maybeSingle();
    const cep = dig(est?.cep), numero = dig(est?.numero), rua = String(est?.logradouro || '').trim();
    if (cep.length !== 8 || !numero || numero === '0' || !rua) continue;
    if (vistos.has(cep + '|' + numero)) continue;
    vistos.add(cep + '|' + numero);
    const { data: rows, error } = await sb.rpc('buscar_empresas_por_endereco', { p_cep: cep, p_numero: numero, p_logradouro: rua });
    if (error) { nc.push(`Endereço de ${maskCnpj(a.cnpj)}: ${erroTxt(error.message)}`); continue; }
    c.fontes.add('receita_rf');
    const outras = (rows || []).filter((r: any) => dig(r.cnpj).length === 14 && dig(r.cnpj) !== a.cnpj);
    const endTxt = `${[est?.tipo_logradouro, rua].filter(Boolean).join(' ')}, ${numero} · CEP ${cep}`;
    const { data: atual } = await sb.from('investigacao_entidades').select('dados').eq('id', a.id).single();
    await sb.from('investigacao_entidades').update({ dados: {
      ...(atual?.dados || {}), endereco_fiscal: endTxt, endereco_compartilhado_com: outras.length,
    } }).eq('id', a.id);
    if (!outras.length) continue;
    if (outras.length >= ENDERECO_MASSA) {
      await evidencia(inv.id, a.id, 'receita_rf', 'Endereço fiscal compartilhado por muitas empresas',
        `${endTxt} · ${outras.length >= 49 ? '49 ou mais' : outras.length} outros CNPJs no mesmo endereço: provável escritório de contabilidade, coworking ou galeria. Não gera pista de vínculo.`);
      continue;
    }
    const escritorio = outras.length >= ENDERECO_ESCRITORIO;
    for (const r of outras) {
      const cnpj = dig(r.cnpj);
      if (achadas.has(cnpj)) continue;
      const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 2, escritorio ? 30 : 45, 'pista', {
        situacao: situacaoTexto(r.situacao), fonte: 'receita_rf', criterio: 'endereco_da_empresa', compartilhado_com: outras.length,
      });
      await vinculo(inv.id, a.id, id, 'compartilha_endereco_fiscal', escritorio ? 30 : 45,
        `Mesmo endereço fiscal de ${maskCnpj(a.cnpj)}${escritorio ? `; ${outras.length} CNPJs no endereço, pode ser escritório de contabilidade` : ''}. Requer confirmação.`);
      await evidencia(inv.id, id, 'receita_rf', 'Empresa no mesmo endereço de empresa do devedor',
        `${r.nome || r.fantasia || cnpj} · ${maskCnpj(cnpj)} · ${endTxt} (endereço de ${maskCnpj(a.cnpj)})${situacaoTexto(r.situacao) ? ' · ' + situacaoTexto(r.situacao) : ''}`);
      achadas.set(cnpj, { id, cnpj, nome: r.nome || cnpj, confirmada: false });
      c.pistas++;
    }
  }
}

// ── Fontes da v4 ────────────────────────────────────────────────────────────
type Achada = { id: string; cnpj: string; nome: string; confirmada: boolean };
// Erro de rede cru (IP, URL, "os error 104") vai para o relatório do cliente: vira texto leigo.
const erroTxt = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/timed? ?out|timeout|aborted/i.test(m)) return 'não respondeu a tempo';
  if (/error sending request|os error|connection (reset|refused|error)|dns error|tcp connect/i.test(m)) return 'não respondeu (falha de conexão)';
  return m;
};
// Contrato encerrado não gera crédito a penhorar hoje: só o vigente conta como recebível.
const _fmtBR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const vigente = (fim: unknown) => !fim || String(fim).slice(0, 10) >= _fmtBR.format(new Date());
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
  if (tels.size > 4) c.cortes.push(`Telefone: ${tels.size} telefones conhecidos, pesquisados os 4 primeiros.`);
  if (emails.size > 3) c.cortes.push(`E-mail: ${emails.size} e-mails conhecidos, pesquisados os 3 primeiros.`);
  const consultas = [
    ...[...tels].slice(0, 4).map(([v, o]) => ({ tipo: 'telefone', v, o, rpc: 'buscar_empresas_por_telefone', arg: { p_tel: v } })),
    ...[...emails].slice(0, 3).map(([v, o]) => ({ tipo: 'e-mail', v, o, rpc: 'buscar_empresas_por_email', arg: { p_email: v } })),
  ];
  for (const q of consultas) {
    const { data: rows, error } = await sb.rpc(q.rpc, q.arg);
    if (error) { nc.push(`Base CNPJ por ${q.tipo} indisponível: ${error.message}`); continue; }
    c.fontes.add('receita_rf');
    if ((rows || []).length > 10) c.cortes.push(`Base CNPJ por ${q.tipo} ${q.v}: ${rows.length} empresas, lidas as 10 primeiras.`);
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
  if (alvos.length > 6) c.cortes.push(`Portal da Transparência: ${alvos.length} documentos conferidos, consultados os 6 primeiros.`);
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
      // Sanção vigente de contratar com o poder público: detalhe só quando a flag
      // do cadastro acusa (poupa duas chamadas por documento limpo).
      for (const [flag, ep, rot] of [['sancionadoCEIS', 'ceis', 'CEIS'], ['sancionadoCNEP', 'cnep', 'CNEP']]) {
        if (p?.[flag] !== true) continue;
        const lista = await ptGet(`/${ep}?codigoSancionado=${a.doc}&pagina=1`, chave);
        for (const s of (Array.isArray(lista) ? lista : []).slice(0, 5)) {
          const orgao = s?.orgaoSancionador?.nome || s?.fonteSancao?.nomeExibicao || 'órgão não informado';
          const multa = String(s?.valorMulta || '').replace(/[^\d,]/g, '');
          await evidencia(inv.id, a.id, 'portal_transparencia', `Sanção ${rot}`,
            `${s?.tipoSancao?.descricaoResumida || 'sanção'} · ${orgao} · de ${s?.dataInicioSancao || '?'} a ${s?.dataFimSancao || 'sem prazo'}${s?.numeroProcesso ? ' · processo ' + s.numeroProcesso : ''}${multa && multa !== '0,00' ? ' · multa R$ ' + multa : ''}${s?.abrangenciaDefinidaDecisaoJudicial ? ' · abrangência: ' + s.abrangenciaDefinidaDecisaoJudicial : ''}`,
            pf ? 'https://portaldatransparencia.gov.br/sancoes/consulta' : `https://portaldatransparencia.gov.br/sancoes/consulta?cpfCnpj=${a.doc}`);
        }
      }
      const contratos = await ptGet(`/contratos/cpf-cnpj?cpfCnpj=${a.doc}&pagina=1`, chave);
      if (Array.isArray(contratos) && contratos.length > 10) c.cortes.push(`Portal da Transparência ${pf ? 'CPF' : maskCnpj(a.doc)}: ${contratos.length}+ contratos federais, lidos os 10 primeiros.`);
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
// A API do PNCP às vezes derruba a conexão ou devolve 5xx: a busca tenta de novo
// uma vez, 2 s depois, antes de virar "não conclusivo".
async function pncpBusca(url: string) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const res = await fetch(url, { headers: PNCP_UA, signal: AbortSignal.timeout(20000) });
      if (res.ok || tentativa >= 2 || (res.status < 500 && res.status !== 429)) return res;
    } catch (e) {
      if (tentativa >= 2) throw e;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
async function pncp(inv: any, raiz: any, achadas: Map<string, Achada>, c: Contadores, nc: string[]) {
  const alvos = [] as { id: string; doc: string; nome: string }[];
  if (raiz.nome) alvos.push({ id: raiz.id, doc: dig(raiz.documento), nome: raiz.nome });
  for (const a of achadas.values()) if (a.confirmada && a.cnpj !== dig(raiz.documento)) alvos.push({ id: a.id, doc: a.cnpj, nome: a.nome });
  if (alvos.length > 4) c.cortes.push(`PNCP: ${alvos.length} nomes para pesquisar, pesquisados os 4 primeiros.`);
  let recebe = false, ok = false;
  for (const a of alvos.slice(0, 4)) {
    const nomeBusca = a.nome.replace(/\s*\d{11}\s*$/, '').trim();   // MEI: tira o CPF da razão social
    if (nomeBusca.length < 8) continue;
    try {
      const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent('"' + nomeBusca + '"')}&tipos_documento=contrato&ordenacao=-data&pagina=1&tam_pagina=8`;
      const res = await pncpBusca(url);
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

// ── Fontes da v8 ────────────────────────────────────────────────────────────
// O INPI não responde a quem chama dos EUA (26/09/2026: timeout de conexão a
// partir de us-east-1, 200 em 0,1 s a partir de sa-east-1). O worker chama a si
// mesmo com o cabeçalho x-region: sa-east-1, repassando a sessão do usuário; a
// instância de São Paulo só busca e devolve o resultado lido (acao 'sp'), sem
// gravar nada.
const SUPA_URL = Deno.env.get('SUPABASE_URL') ?? '';
async function viaSP(auth: string, invId: string, tarefas: any[], timeout = 75000): Promise<any[]> {
  const res = await fetch(`${SUPA_URL}/functions/v1/investigacao-patrimonial-worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth, apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '', 'x-region': 'sa-east-1' },
    body: JSON.stringify({ investigacao_id: invId, acao: 'sp', tarefas }),
    signal: AbortSignal.timeout(timeout),
  });
  const j: any = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(j?.resultados)) throw new Error(j?.error || `HTTP ${res.status}`);
  return j.resultados;
}
async function mesclarDados(id: string, extra: Record<string, unknown>) {
  const { data: atual } = await sb.from('investigacao_entidades').select('dados').eq('id', id).single();
  await sb.from('investigacao_entidades').update({ dados: { ...(atual?.dados || {}), ...extra } }).eq('id', id);
}
// Até n tarefas ao mesmo tempo, na ordem da lista.
async function emLotes<T, R>(lista: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(lista.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
    while (i < lista.length) { const k = i++; out[k] = await f(lista[k]); }
  }));
  return out;
}

// pePI do INPI: sessão anônima por cookie; a lista de titulares da última busca
// fica na sessão e o link "pos=N" abre as marcas de um deles.
const INPI = 'https://busca.inpi.gov.br/pePI/servlet/';
const INPI_PATENTE_CAMPOS = ['NumPedido', 'NumPrioridade', 'CodigoPct', 'DataDeposito1', 'DataDeposito2', 'DataPrioridade1', 'DataPrioridade2',
  'DataDepositoPCT1', 'DataDepositoPCT2', 'DataPublicacaoPCT1', 'DataPublicacaoPCT2', 'ClassificacaoIPC', 'CatchWordIPC', 'Titulo', 'Resumo',
  'NomeDepositante', 'NomeInventor'];
async function inpiSessao() {
  const cookies = new Map<string, string>();
  const guarda = (r: Response) => {
    for (const c of ((r.headers as any).getSetCookie?.() || []) as string[]) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  };
  const cab = () => ({ Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'User-Agent': 'Mozilla/5.0 (compatible; COBRASQ investigacao)' });
  const texto = async (r: Response) => { guarda(r); return new TextDecoder('latin1').decode(await r.arrayBuffer()); };
  const post = async (p: string, campos: Record<string, string>) => texto(await fetch(INPI + p, {
    method: 'POST', headers: { ...cab(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(campos).toString(), redirect: 'manual', signal: AbortSignal.timeout(20000),
  }));
  const get = async (p: string) => texto(await fetch(INPI + p, { headers: cab(), signal: AbortSignal.timeout(20000) }));
  await post('LoginController', { T_Login: '', T_Senha: '', action: 'login', Usuario: '' });
  return { post, get };
}
// Tarefa INPI (roda em São Paulo). alvo = { cpf, nome } | { miolo, nome } | { cnpj }.
// Pessoa vai pelo nome (a busca por CPF não acha pessoa física no pePI) e só
// aceita o titular cujo CPF confere. Empresa vai pelo CNPJ; titular com outro
// documento na mesma busca volta marcado confere=false.
async function tarefaInpi(alvo: any) {
  const s = await inpiSessao();
  const h = await s.post('MarcasServletController', {
    Action: 'searchNome', tipoPesquisa: 'BY_CNPJ_NOME', precisao: 'exata',
    cpf_cgc_numINPI: alvo.cnpj || '', nomeTitular: alvo.cnpj ? '' : String(alvo.nome || ''), registerPerPage: '20', botao: ' pesquisar » ',
  });
  const titulares = [] as any[];
  for (const t of inpiTitulares(h).slice(0, 20)) {
    const confere = titularConfere(t, alvo);
    if (!confere && !alvo.cnpj) continue;
    if (titulares.length >= 3) break;
    const m = inpiMarcas(await s.get(`MarcasServletController?Action=searchMarca&tipoPesquisa=BY_CNPJ_NOME&pos=${t.pos}`));
    titulares.push({ nome: t.nome, doc: t.doc, confere, total: m.total, marcas: m.itens.slice(0, 20) });
  }
  let patentes = null;
  if (alvo.cnpj) {
    const campos: Record<string, string> = { Action: 'SearchAvancado', CpfCnpjDepositante: alvo.cnpj, RegisterPerPage: '20', botao: ' pesquisar » ' };
    for (const k of INPI_PATENTE_CAMPOS) campos[k] = '';
    patentes = inpiPatentes(await s.post('PatenteServletController', campos));
  }
  return { titulares, patentes };
}
// Comunicações do DJEN de um processo, lidas em São Paulo. Volta só as que
// têm sinal de bem, dinheiro ou paradeiro no texto (o texto inteiro não viaja).
async function tarefaDjenProcesso(numero: string) {
  const d = dig(numero);
  const res = await fetch(`https://comunicaapi.pje.jus.br/api/v1/comunicacao?numeroProcesso=${d}&itensPorPagina=100&pagina=1`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DJEN HTTP ${res.status}`);
  const j: any = await res.json();
  const itens = Array.isArray(j?.items) ? j.items : [];
  return { total: itens.length, comSinal: itens.map(comunicacaoComSinal).filter(Boolean) };
}
function comunicacaoComSinal(it: any) {
  const sinais = sinaisTexto(it?.texto);
  if (!sinais.length) return null;
  return { data: it?.data_disponibilizacao || null, tipo: [it?.tipoComunicacao, it?.tipoDocumento].filter(Boolean).join(' · ') || null, link: it?.link || null, sinais };
}
async function executarSP(tarefas: any[]) {
  return await emLotes((Array.isArray(tarefas) ? tarefas : []).slice(0, 40), 5, async (t: any) => {
    try {
      if (t?.tipo === 'inpi') return { ok: true, dados: await tarefaInpi(t) };
      if (t?.tipo === 'djen_proc') return { ok: true, dados: await tarefaDjenProcesso(String(t.numero || '')) };
      return { ok: false, erro: 'tarefa desconhecida' };
    } catch (e) { return { ok: false, erro: erroTxt(e) }; }
  });
}

const fmtCpf = (d: string) => d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
// Marcas e patentes. Marca registrada (ou pedido em andamento) é bem penhorável
// (CPC art. 835, XIII, "outros direitos"). Sócio que aparece como titular com o
// CPF inteiro ganha o CPF completo em dados.cpf_completo (o QSA só mostra 6 dígitos).
async function inpi(inv: any, raiz: any, socios: Socio[], achadas: Map<string, Achada>, c: Contadores, nc: string[], auth: string) {
  const { data: fonte } = await sb.from('investigacao_fontes').select('codigo').eq('codigo', 'inpi').maybeSingle();
  if (!fonte) { nc.push('INPI: fonte ainda não cadastrada no banco (migração 20260926_06 pendente).'); return; }
  const alvos = [] as { id: string; nome: string; papel: 'devedor' | 'socio' | 'empresa'; t: any }[];
  const cpfRaiz = dig(raiz.documento);
  if (raiz.tipo === 'pessoa' && raiz.nome) {
    if (cpfRaiz.length === 11) alvos.push({ id: raiz.id, nome: raiz.nome, papel: 'devedor', t: { tipo: 'inpi', nome: raiz.nome, cpf: cpfRaiz } });
    else nc.push('INPI: devedor sem CPF para conferir o titular; marcas da pessoa não pesquisadas.');
  }
  const unicos = [...new Map(socios.map(s => [key(s.nome) + s.miolo, s])).values()];
  if (unicos.length > SOCIOS_MAX) c.cortes.push(`INPI: ${unicos.length} sócios, pesquisados os ${SOCIOS_MAX} primeiros.`);
  for (const s of unicos.slice(0, SOCIOS_MAX)) alvos.push({ id: s.id, nome: s.nome, papel: 'socio', t: { tipo: 'inpi', nome: s.nome, miolo: s.miolo } });
  const empresas = [...achadas.values()].sort((a, b) => Number(b.confirmada) - Number(a.confirmada));
  if (empresas.length > 10) c.cortes.push(`INPI: ${empresas.length} empresas na teia, pesquisadas 10 (confirmadas primeiro).`);
  for (const a of empresas.slice(0, 10)) alvos.push({ id: a.id, nome: a.nome, papel: 'empresa', t: { tipo: 'inpi', cnpj: a.cnpj } });
  if (!alvos.length) { nc.push('INPI: nenhum CPF ou CNPJ conferido para pesquisar.'); return; }

  let resultados: any[];
  try { resultados = await viaSP(auth, inv.id, alvos.map(a => a.t)); }
  catch (e) { nc.push('INPI (consulta via São Paulo): ' + erroTxt(e)); return; }
  const url = 'https://busca.inpi.gov.br/pePI/';
  let algum = false;
  for (let i = 0; i < alvos.length; i++) {
    const a = alvos[i], r = resultados[i];
    if (!r?.ok) { nc.push(`INPI (${a.nome}): ${r?.erro || 'sem resposta'}`); continue; }
    algum = true;
    const { titulares = [], patentes = null } = r.dados || {};
    let marcas = 0, vivas = 0;
    for (const t of titulares) {
      if (a.papel === 'socio' && t.confere && dig(t.doc).length === 11) {
        await mesclarDados(a.id, { cpf_completo: dig(t.doc), cpf_fonte: 'inpi' });
        await evidencia(inv.id, a.id, 'inpi', 'CPF completo do sócio (INPI)',
          `${a.nome} · CPF ${fmtCpf(dig(t.doc))} no cadastro de titular do INPI · nome e os 6 dígitos públicos do QSA conferem`, url);
      }
      const deOutro = !t.confere;
      for (const m of (t.marcas || []).slice(0, 10)) {
        const viva = marcaViva(m.situacao);
        marcas++; if (viva) vivas++;
        await evidencia(inv.id, a.id, 'inpi', deOutro ? 'Marca na busca pelo CNPJ, em nome de outro titular' : 'Marca no INPI',
          `${m.marca} · processo ${m.numero}${m.classe ? ' · ' + m.classe : ''} · ${m.situacao || 'situação não informada'}${deOutro ? ` · titular ${t.nome || '?'}` : ''}${viva && !deOutro ? (a.id === raiz.id ? ' · penhorável (CPC art. 835, XIII)' : a.papel === 'empresa' ? ' · bem da empresa: alcança o devedor pelas quotas ou por desconsideração' : ' · bem do sócio: alcança o devedor só por desconsideração') : ''}`, url);
      }
      if ((t.total || 0) > 10) c.cortes.push(`INPI: ${t.nome || a.nome} tem ${t.total} marcas, gravadas as 10 primeiras.`);
    }
    if (patentes?.total) {
      await evidencia(inv.id, a.id, 'inpi', 'Patentes no INPI',
        `${patentes.total} pedido(s) de patente com este CNPJ como depositante · ${(patentes.itens || []).slice(0, 5).map((p: any) => `${p.pedido} (${p.deposito || '?'})${p.titulo ? ' ' + String(p.titulo).slice(0, 80) : ''}`).join('; ')}`, url);
    }
    if (marcas || patentes?.total) {
      await mesclarDados(a.id, { inpi: { marcas, marcas_vivas: vivas, patentes: patentes?.total || 0 } });
      c.marcasVivas += vivas; c.patentes += patentes?.total || 0;
    }
  }
  if (algum) c.fontes.add('inpi');
}

// DataJud (CNJ): completa os processos já achados com classe, assuntos, órgão e
// último andamento. Não traz partes nem valor da causa. Chave pública do CNJ no
// segredo DATAJUD_API_KEY.
async function datajud(inv: any, c: Contadores, nc: string[]) {
  const chave = Deno.env.get('DATAJUD_API_KEY') || '';
  const { data: procs } = await sb.from('investigacao_entidades').select('id,documento,dados').eq('investigacao_id', inv.id).eq('tipo', 'processo').limit(30);
  if (!procs?.length) return;
  if (!chave) { nc.push('DataJud: chave não configurada no Supabase; processos sem classe/andamento do CNJ.'); return; }
  let ok = 0, falhas = 0, semIndice = 0;
  await emLotes(procs, 5, async (p: any) => {
    const alias = aliasDatajud(p.documento);
    if (!alias) { semIndice++; return; }
    try {
      const res = await fetch(`https://api-publica.datajud.cnj.jus.br/${alias}/_search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `APIKey ${chave}` },
        body: JSON.stringify({ query: { match: { numeroProcesso: dig(p.documento) } }, size: 5 }), signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      // Um número pode ter um registro por grau: fica o de andamento mais recente.
      const regs = (j?.hits?.hits || []).map((h: any) => datajudResumo(h?._source)).filter(Boolean)
        .sort((a: any, b: any) => String(b.ultimo_andamento?.data || '').localeCompare(String(a.ultimo_andamento?.data || '')));
      ok++;
      if (!regs.length) return;
      const r = regs[0];
      await mesclarDados(p.id, { datajud: r, ...(p.dados?.classe ? {} : { classe: r.classe }), ...(p.dados?.orgao ? {} : { orgao: r.orgao }) });
      await evidencia(inv.id, p.id, 'datajud', 'Dados do processo no DataJud (CNJ)',
        `${r.classe || 'classe não informada'}${r.assuntos.length ? ' · ' + r.assuntos.join(', ') : ''}${r.orgao ? ' · ' + r.orgao : ''}${r.grau ? ' · ' + r.grau : ''}${r.ajuizamento ? ' · ajuizado em ' + r.ajuizamento.split('-').reverse().join('/') : ''}${r.ultimo_andamento ? ` · último andamento: ${r.ultimo_andamento.nome || '?'} em ${r.ultimo_andamento.data.split('-').reverse().join('/')}` : ''}`,
        'https://datajud-wiki.cnj.jus.br/api-publica/');
    } catch (e) { falhas++; if (falhas <= 3) nc.push(`DataJud ${p.documento}: ${erroTxt(e)}`); }
  });
  if (ok) c.fontes.add('datajud');
  if (semIndice) nc.push(`DataJud: ${semIndice} processo(s) de tribunal sem índice público mapeado (superiores, eleitoral, militar).`);
}

// Sinais no texto das publicações (Renajud, alvará, penhora, Sisbajud, leilão,
// imóvel, Infojud, desconsideração, paradeiro): vira evidência no processo, um
// por tipo de sinal, com a publicação mais recente. É pista a conferir nos autos.
async function gravarSinais(inv: any, procId: string, numero: string, comunicacoes: any[], c: Contadores) {
  const porTipo = new Map<string, any>();
  const ordenadas = comunicacoes.slice().sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
  for (const k of ordenadas) for (const s of k.sinais || []) if (!porTipo.has(s.tipo)) porTipo.set(s.tipo, { ...s, data: k.data, tipoCom: k.tipo, link: k.link });
  if (!porTipo.size) return;
  for (const s of porTipo.values()) {
    await evidencia(inv.id, procId, 'djen', `Sinal no texto: ${s.rotulo}`,
      `${numero} · publicação de ${s.data ? String(s.data).slice(0, 10).split('-').reverse().join('/') : '?'}${s.tipoCom ? ' (' + s.tipoCom + ')' : ''}: "${s.trecho}"`, s.link || '');
  }
  await mesclarDados(procId, { sinais: [...porTipo.keys()] });
  c.sinais += porTipo.size;
}

// Um processo do DJEN vira entidade + vínculo + evidência. Polo A (devedor é
// autor) = crédito a penhorar no rosto dos autos; polo P (réu) = outros credores
// e rastro de bens. cpf_confere decide confirmada/pista.
async function gravarProcesso(inv: any, raiz: any, c: Contadores, r: any) {
  const num = String(r.numero_processo || '').trim();
  const d = dig(r.digitos || num);
  if (!d) return null;
  const confirmado = r.cpf_confere === true;
  const papel = r.polo === 'A' ? 'autor' : r.polo === 'P' ? 'réu' : 'parte (polo não identificado)';
  const uso = r.polo === 'A' ? 'devedor é autor: possível crédito a penhorar no rosto dos autos'
    : r.polo === 'P' ? 'devedor é réu: outros credores disputando os mesmos bens e rastro patrimonial nos autos'
    : 'conferir o polo nos autos';
  const id = await entidade(inv.id, 'processo', num || d, d, 1, confirmado ? 85 : 55, confirmado ? 'confirmada' : 'pista', {
    numero: num, tribunal: r.tribunal || null, classe: r.classe || null, orgao: r.orgao || null, polo: r.polo || null,
    primeira_data: r.primeira_data || null, ultima_data: r.ultima_data || null, fonte: 'djen', vigia_id: r.vigia_id || null, link: r.link || null,
  });
  await vinculo(inv.id, raiz.id, id, r.polo === 'A' ? 'autor_em' : r.polo === 'P' ? 'reu_em' : 'parte_em', confirmado ? 85 : 55,
    confirmado ? 'CPF do devedor conferido na comunicação do DJEN.' : `Encontrado pelo nome${r.nome_encontrado ? ' "' + r.nome_encontrado + '"' : ''}; CPF não conferido: homônimo possível.`);
  await evidencia(inv.id, id, 'djen', r.polo === 'A' ? 'Processo em que o devedor é autor' : 'Processo com o devedor no polo passivo',
    `${num} · ${[r.tribunal, r.orgao].filter(Boolean).join(' · ')}${r.classe ? ' · ' + r.classe : ''} · ${papel} · ${r.qtd_comunicacoes || 0} comunicação(ões) de ${r.primeira_data || '?'} a ${r.ultima_data || '?'} · ${uso}${confirmado ? '' : ' · CPF não conferido'}`,
    r.link || '');
  if (confirmado) c.confirmadas++; else c.pistas++;
  if (r.polo === 'A') c.processosAutor++; else c.processosReu++;
  return id;
}

// DJEN via Vigia de ações: o Supabase não consulta o DJEN (ele bloqueia essas
// chamadas); reaproveita o que o Vigia já gravou em vigia_acoes para o devedor.
// Investigação avulsa (sem devedor) não tem Vigia: o painel consulta o DJEN
// pelo navegador (CORS aberto) e manda as comunicações em body.djen.
// Devolve o texto de cobertura processual do relatório.
async function vigiaDjen(inv: any, raiz: any, djen: any, c: Contadores, nc: string[], auth: string): Promise<string> {
  if (!inv.devedor_id) return await djenDireto(inv, raiz, djen, c, nc);
  const cobertura = 'Processos vêm só do que o Vigia de ações já achou no DJEN (comunicações publicadas). Ausência de processo no relatório não significa ausência de ação.';
  const { data: rows, error } = await sb.from('vigia_acoes')
    .select('id,numero_processo,digitos,polo,tribunal,classe,orgao,link,primeira_data,ultima_data,qtd_comunicacoes,cpf_confere,nome_encontrado,status,ultimo_texto')
    .eq('devedor_id', inv.devedor_id).neq('status', 'descartado').order('ultima_data', { ascending: false }).limit(30);
  if (error) { nc.push('DJEN/Vigia indisponível: ' + error.message); return cobertura; }
  c.fontes.add('djen');
  if (!rows?.length) { nc.push('DJEN/Vigia: o Vigia de ações ainda não encontrou (ou não varreu) processo deste devedor.'); return cobertura; }
  const gravados = [] as { id: string; numero: string; d: string; ultimo: string; data: string | null; link: string | null }[];
  for (const r of rows) {
    const id = await gravarProcesso(inv, raiz, c, { ...r, vigia_id: r.id });
    const d = dig(r.digitos || r.numero_processo);
    if (id && d.length === 20 && !/^0+$/.test(d)) gravados.push({ id, numero: r.numero_processo || d, d, ultimo: r.ultimo_texto || '', data: r.ultima_data || null, link: r.link || null });
  }
  // Texto das publicações: o Vigia guarda só o último trecho (1.200 caracteres).
  // Busca todas as comunicações de cada processo pelo número, via São Paulo; se
  // falhar, lê o trecho que o Vigia guardou.
  let lidos: any[] | null = null;
  try { lidos = gravados.length ? await viaSP(auth, inv.id, gravados.map(g => ({ tipo: 'djen_proc', numero: g.d }))) : []; }
  catch (e) { nc.push('DJEN (texto das publicações via São Paulo): ' + erroTxt(e) + '; lido só o último trecho guardado pelo Vigia.'); }
  let falhas = 0;
  for (let i = 0; i < gravados.length; i++) {
    const g = gravados[i], r = lidos?.[i];
    if (r?.ok) { await gravarSinais(inv, g.id, g.numero, r.dados?.comSinal || [], c); continue; }
    if (lidos) falhas++;
    const k = comunicacaoComSinal({ texto: g.ultimo, data_disponibilizacao: g.data, link: g.link });
    if (k) await gravarSinais(inv, g.id, g.numero, [k], c);
  }
  if (falhas) nc.push(`DJEN: texto completo de ${falhas} processo(s) não lido (${lidos?.find((r: any) => !r?.ok)?.erro || 'falha'}); usado o último trecho guardado pelo Vigia.`);
  return cobertura + ' O texto das publicações foi lido em busca de sinais de bens (Renajud, alvará, penhora, Sisbajud, leilão, imóvel, Infojud, desconsideração, paradeiro).';
}

// Mesmo filtro do Vigia (logica.mjs): destinatário com o nome exato, processo
// da casa fora, busca cortada só aproveita achado com CPF no texto. Sem filtro
// de UF: a avulsa não tem processo nosso que defina a UF.
async function djenDireto(inv: any, raiz: any, djen: any, c: Contadores, nc: string[]): Promise<string> {
  const semConsulta = 'Não feita: investigação sem devedor cadastrado e o DJEN não foi consultado pelo painel.';
  if (!djen || typeof djen !== 'object') { nc.push('DJEN: investigação sem devedor cadastrado; use "Processar agora" no painel para consultar o DJEN pelo nome.'); return semConsulta; }
  if (djen.erro) { nc.push('DJEN não respondeu à consulta do painel: ' + String(djen.erro).slice(0, 200)); return semConsulta; }
  if (!raiz.nome) { nc.push('DJEN: investigação sem nome; o DJEN só é pesquisado por nome.'); return semConsulta; }
  const itens = Array.isArray(djen.itens) ? djen.itens.slice(0, 300) : [];
  const total = Number(djen.total) || itens.length;
  const truncado = djen.truncado === true;
  const { achados, descartados } = agruparAchados(itens, raiz.nome, new Set(), null, raiz.documento || null);
  const { achados: ficam, descartados: semCpf } = filtrarTruncado(achados, truncado);
  c.fontes.add('djen');
  const lista = ficam.slice().sort((a: any, b: any) => String(b.ultima_data || '').localeCompare(String(a.ultima_data || ''))).slice(0, 30);
  // O painel já manda o texto de cada comunicação: os sinais saem daqui mesmo.
  const porProcesso = new Map<string, any[]>();
  for (const it of itens) {
    const k = comunicacaoComSinal(it);
    if (!k) continue;
    const d = dig(it?.numero_processo || it?.numeroprocessocommascara);
    porProcesso.set(d, [...(porProcesso.get(d) || []), k]);
  }
  for (const a of lista) {
    const id = await gravarProcesso(inv, raiz, c, { ...a, qtd_comunicacoes: (a.comunicacoes || []).length });
    const d = dig(a.digitos || a.numero_processo);
    if (id && porProcesso.has(d)) await gravarSinais(inv, id, a.numero_processo || d, porProcesso.get(d)!, c);
  }
  const notas = [
    `Consultado direto no DJEN pelo nome "${String(djen.nome || raiz.nome)}", histórico completo (${total} comunicação(ões) publicadas${truncado ? `, lidas ${itens.length}` : ''}).`,
    descartados.nosso ? `${descartados.nosso} comunicação(ões) de processo do escritório ficaram de fora.` : '',
    truncado ? `Nome com muitas comunicações: só entram processos com o CPF/CNPJ no texto${semCpf ? ` (${semCpf} processo(s) sem CPF deixados de fora)` : ''}.` : '',
    ficam.length > lista.length ? `Relatório mostra os ${lista.length} processos mais recentes de ${ficam.length}.` : '',
    'O DJEN só traz processos com comunicação publicada: ausência de processo no relatório não significa ausência de ação.',
  ];
  return notas.filter(Boolean).join(' ');
}

async function processar(inv: any, djen: any = null, auth = '') {
  const { data: raizes, error } = await sb.from('investigacao_entidades').select('*').eq('investigacao_id', inv.id).eq('profundidade', 0).limit(1);
  if (error || !raizes?.[0]) throw error || new Error('Entidade-raiz ausente');
  const raiz = raizes[0];
  let empresas = 0;
  const contadores: Contadores = { pessoas: 0, enriquecidas: 0, confirmadas: 0, pistas: 0, recebiveis: 0, processosAutor: 0, processosReu: 0, marcasVivas: 0, patentes: 0, sinais: 0, fontes: new Set(), cortes: [] };
  // Sócios das empresas confirmadas, para a busca das empresas deles (profundidade 2).
  const socios: Socio[] = [];
  const inicio = Date.now();
  const achadas = new Map<string, Achada>();
  const naoConclusivas: string[] = [];
  const teto = Math.max(0, Math.min(Number(inv.entidades_maximas || 80) - 1, 40));
  await evento(inv.id, 'fonte_iniciada', 'Iniciada consulta em fontes públicas.', { fontes: ['receita_rf', 'brasilapi', 'viacep', 'portal_transparencia', 'pncp', 'djen', 'datajud', 'inpi'] });

  if (raiz.tipo === 'pessoa' && raiz.nome) {
    // Com o cache frio a busca por nome passa do limite de 8 s (26/09/2026: timeout
    // na 1ª chamada, 0,4 s na seguinte). Uma nova tentativa resolve.
    let { data: rows, error: rpcError } = await sb.rpc('buscar_empresas_por_socio', { p_nome: raiz.nome, p_cpf: dig(raiz.documento) || null });
    if (rpcError && /timeout/i.test(rpcError.message)) ({ data: rows, error: rpcError } = await sb.rpc('buscar_empresas_por_socio', { p_nome: raiz.nome, p_cpf: dig(raiz.documento) || null }));
    if (rpcError) naoConclusivas.push('Receita/base CNPJ indisponível: ' + rpcError.message);
    else contadores.fontes.add('receita_rf');
    if ((rows || []).length > teto) contadores.cortes.push(`Base CNPJ: ${rows.length >= 50 ? '50 ou mais' : rows.length} empresas com o nome do devedor, analisadas as ${teto} primeiras.`);
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
      const qsa = await enriquecerEmpresa(inv, raiz, id, cnpj, contadores, naoConclusivas);
      if (conferido) socios.push(...qsa);
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
          if ((porEndereco || []).length > 20) contadores.cortes.push(`Endereço do devedor: ${porEndereco.length >= 50 ? '50 ou mais' : porEndereco.length} empresas no endereço, gravadas as 20 primeiras.`);
          for (const r of (porEndereco || []).slice(0, 20)) {
            const cnpj = dig(r.cnpj);
            // Empresa já achada pelo sócio não é rebaixada a pista pelo endereço.
            if (cnpj.length !== 14 || achadas.has(cnpj)) continue;
            const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 1, 45, 'pista', {
              situacao: situacaoTexto(r.situacao), fonte: 'receita_rf', criterio: 'endereco_fiscal', compartilhado_com: (porEndereco || []).length,
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
        naoConclusivas.push('ViaCEP não conclusivo: ' + erroTxt(e));
      }
    }
  } else if (raiz.tipo === 'empresa' && dig(raiz.documento).length === 14) {
    const cnpj = dig(raiz.documento);
    empresas = 1;
    achadas.set(cnpj, { id: raiz.id, cnpj, nome: raiz.nome || cnpj, confirmada: true });
    socios.push(...await enriquecerEmpresa(inv, raiz, raiz.id, cnpj, contadores, naoConclusivas));
  } else {
    naoConclusivas.push('Pessoa sem nome: a base CNPJ só é pesquisada por nome (com CPF para conferir).');
  }

  // Cada fonte nova isola as próprias falhas: uma que cair não derruba as outras.
  const segura = async <T>(nome: string, f: () => Promise<T>) => {
    try { return await f(); } catch (e) { naoConclusivas.push(`${nome}: ${erroTxt(e)}`); return null; }
  };
  // Teia de 2º nível (sócios e endereço das empresas): para de abrir consultas
  // 90 s depois do início. Só quando a investigação pede profundidade 2 ou mais.
  const prazo = inicio + 90000;
  // INPI roda em São Paulo e em paralelo com o resto: parte das empresas e dos
  // sócios já conhecidos no 1º nível (as pistas do 2º nível ficam de fora).
  const inpiEmCurso = segura('INPI', () => inpi(inv, raiz, socios, new Map(achadas), contadores, naoConclusivas, auth));
  if (Number(inv.profundidade_maxima || 1) >= 2) {
    if (socios.length) await segura('Empresas dos sócios', () => empresasDosSocios(inv, socios, achadas, contadores, naoConclusivas, prazo));
    await segura('Endereço das empresas', () => enderecoDasEmpresas(inv, achadas, contadores, naoConclusivas, prazo));
  }
  await segura('Telefone/e-mail', () => porContato(inv, raiz, achadas, contadores, naoConclusivas));
  const recebePt = await segura('Portal da Transparência', () => portalTransparencia(inv, raiz, achadas, contadores, naoConclusivas));
  const recebePncp = await segura('PNCP', () => pncp(inv, raiz, achadas, contadores, naoConclusivas));
  const cobertura = await segura('DJEN/Vigia', () => vigiaDjen(inv, raiz, djen, contadores, naoConclusivas, auth));
  await segura('DataJud', () => datajud(inv, contadores, naoConclusivas));
  await inpiEmCurso;
  const recebeEntePublico = recebePt === true || recebePncp === true ? true : (recebePt === false && recebePncp !== null ? false : null);

  const componentes = [] as any[];
  if (empresas) componentes.push({ rotulo: 'Empresas vinculadas', pontos: Math.min(empresas * 10, 20), explicacao: `${empresas} vínculo(s) societário(s) retornado(s) por fonte pública.` });
  if (contadores.pessoas) componentes.push({ rotulo: 'Quadro societário identificado', pontos: Math.min(contadores.pessoas * 4, 15), explicacao: `${contadores.pessoas} pessoa(s) listada(s) no CNPJ; são pistas até confirmação.` });
  if (contadores.enriquecidas) componentes.push({ rotulo: 'Cadastro CNPJ enriquecido', pontos: Math.min(contadores.enriquecidas * 5, 10), explicacao: `${contadores.enriquecidas} empresa(s) consultada(s) na BrasilAPI (situação, capital, QSA).` });
  if (contadores.recebiveis) componentes.push({ rotulo: 'Recebe de ente público', pontos: Math.min(contadores.recebiveis * 10, 25), explicacao: `${contadores.recebiveis} contrato(s) público(s) vigente(s) com documento conferido: crédito penhorável junto ao órgão pagador.` });
  if (contadores.processosAutor) componentes.push({ rotulo: 'Processos como autor', pontos: Math.min(contadores.processosAutor * 5, 15), explicacao: `${contadores.processosAutor} processo(s) em que o devedor é autor (Vigia/DJEN): possível penhora no rosto dos autos.` });
  if (contadores.processosReu) componentes.push({ rotulo: 'Processos como réu', pontos: Math.min(contadores.processosReu * 2, 10), explicacao: `${contadores.processosReu} processo(s) com o devedor no polo passivo (Vigia/DJEN): outros credores e rastro de bens.` });
  if (contadores.marcasVivas || contadores.patentes) componentes.push({ rotulo: 'Marcas e patentes (INPI)', pontos: Math.min(contadores.marcasVivas * 5 + (contadores.patentes ? 5 : 0), 15), explicacao: `${contadores.marcasVivas} marca(s) em vigor ou em andamento${contadores.patentes ? ` e ${contadores.patentes} pedido(s) de patente` : ''} no INPI: penhoráveis (CPC art. 835, XIII).` });
  if (contadores.sinais) componentes.push({ rotulo: 'Sinais nas publicações', pontos: Math.min(contadores.sinais * 2, 10), explicacao: `${contadores.sinais} sinal(is) de bem, dinheiro ou paradeiro no texto das publicações do DJEN (Renajud, alvará, penhora, Sisbajud etc.): conferir nos autos.` });
  const score = Math.min(100, componentes.reduce((s, x) => s + Number(x.pontos || 0), 0));
  const resumo = {
    entidades_confirmadas: contadores.confirmadas + (raiz.status_verificacao === 'confirmada' ? 1 : 0),
    entidades_pista: contadores.pistas + contadores.pessoas,
    fontes_concluidas: [...contadores.fontes],
    fontes_nao_conclusivas: naoConclusivas,
    recebe_ente_publico: recebeEntePublico,
    processos_autor: contadores.processosAutor,
    processos_reu: contadores.processosReu,
    cobertura_processual: cobertura || 'DJEN não consultado (falha na consulta, ver fontes não conclusivas).',
    cortes: contadores.cortes,
    marcas_vivas: contadores.marcasVivas,
    patentes: contadores.patentes,
    sinais_publicacoes: contadores.sinais,
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

// Botão "Confirmar pista" do painel. A tabela só tem política de leitura: a
// escrita passa por aqui, restrita ao proprietário (mesma regra de escrita de
// investigacoes_patrimoniais). confirmar=false desfaz.
async function confirmarPista(userClient: any, user: any, inv: any, body: any) {
  const { data: papel } = await userClient.rpc('current_user_papel');
  if (papel !== 'proprietario') return json({ error: 'Só o proprietário confirma pistas.' }, 403);
  const entId = String(body.entidade_id || '');
  const { data: ent } = await sb.from('investigacao_entidades').select('id,nome,documento,status_verificacao,dados,profundidade')
    .eq('id', entId).eq('investigacao_id', inv.id).maybeSingle();
  if (!ent || ent.profundidade === 0) return json({ error: 'entidade não encontrada nesta investigação' }, 404);
  const dados: Record<string, unknown> = { ...(ent.dados || {}) };
  const confirmar = body.confirmar !== false;
  if (confirmar) {
    if (ent.status_verificacao === 'confirmada' && !dados.confirmado_manual) return json({ ok: true, status: 'confirmada' });
    dados.confirmado_manual = { por: user.email || user.id, em: new Date().toISOString(), status_anterior: ent.status_verificacao, motivo: String(body.motivo || '').slice(0, 300) || null };
  } else if (!dados.confirmado_manual) return json({ error: 'esta entidade não foi confirmada à mão' }, 400);
  const anterior = (dados.confirmado_manual as any)?.status_anterior || 'pista';
  if (!confirmar) delete dados.confirmado_manual;
  const status = confirmar ? 'confirmada' : anterior;
  const { error } = await sb.from('investigacao_entidades').update({ status_verificacao: status, dados }).eq('id', ent.id);
  if (error) return json({ error: error.message }, 500);
  await evento(inv.id, 'nota', `${confirmar ? 'Pista confirmada' : 'Confirmação desfeita'} por ${user.email || user.id}: ${ent.nome || ent.documento}${confirmar && body.motivo ? ' · ' + String(body.motivo).slice(0, 300) : ''}`);
  return json({ ok: true, status });
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
  if (body.acao === 'confirmar_pista') return confirmarPista(userClient, user, inv, body);
  // Braço de São Paulo (ver viaSP): só busca e lê fontes que não respondem aos
  // EUA; não grava nada. Fora de sa-east-1 recusa, para não virar laço.
  if (body.acao === 'sp') {
    if (Deno.env.get('SB_REGION') !== 'sa-east-1') return json({ error: `acao sp só roda em sa-east-1 (esta instância: ${Deno.env.get('SB_REGION') || '?'})` }, 400);
    return json({ ok: true, resultados: await executarSP(body.tarefas) });
  }
  // Reserva atômica: só um chamado passa do "pendente" para "em_andamento". Um
  // "em_andamento" parado há mais de TRAVADA_MIN minutos é tomado de volta.
  const travadaAntes = new Date(Date.now() - TRAVADA_MIN * 60000).toISOString();
  const { data: reservada } = await sb.from('investigacoes_patrimoniais')
    .update({ status: 'em_andamento', iniciado_em: new Date().toISOString() })
    .eq('id', id)
    .or(`status.in.(${REPROCESSAVEIS.join(',')}),and(status.eq.em_andamento,iniciado_em.lt."${travadaAntes}")`)
    .select('*');
  if (!reservada?.length) return json({ ok: true, id, status: inv.status, mensagem: inv.status === 'em_andamento' ? 'Investigação já está sendo processada.' : 'Investigação já processada.' });
  try { return json({ ok: true, resultado: await processar(reservada[0], body.djen || null, authorization) }); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.from('investigacoes_patrimoniais').update({ status: 'falhou', resumo: { erro: msg } }).eq('id', id);
    await evento(id, 'status', 'Falha na coleta: ' + msg);
    return json({ error: msg }, 500);
  }
});

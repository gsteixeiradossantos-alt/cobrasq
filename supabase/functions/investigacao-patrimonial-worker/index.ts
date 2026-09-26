// Worker da coleta patrimonial (v3).
// Fontes públicas: base CNPJ no Supabase, BrasilAPI (cadastro + QSA) e ViaCEP.
// Sistemas judiciais, restritos, CAPTCHA e credenciais de terceiros ficam fora.
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

type Contadores = { pessoas: number; enriquecidas: number; confirmadas: number; pistas: number; fontes: Set<string> };

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

async function processar(inv: any) {
  const { data: raizes, error } = await sb.from('investigacao_entidades').select('*').eq('investigacao_id', inv.id).eq('profundidade', 0).limit(1);
  if (error || !raizes?.[0]) throw error || new Error('Entidade-raiz ausente');
  const raiz = raizes[0];
  let empresas = 0;
  const contadores: Contadores = { pessoas: 0, enriquecidas: 0, confirmadas: 0, pistas: 0, fontes: new Set() };
  const naoConclusivas: string[] = [];
  const teto = Math.max(0, Math.min(Number(inv.entidades_maximas || 80) - 1, 40));
  await evento(inv.id, 'fonte_iniciada', 'Iniciada consulta em fontes públicas.', { fontes: ['receita_rf', 'brasilapi', 'viacep'] });

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
            if (cnpj.length !== 14) continue;
            const id = await entidade(inv.id, 'empresa', r.nome || r.fantasia || cnpj, cnpj, 1, 45, 'pista', {
              situacao: situacaoTexto(r.situacao), fonte: 'receita_rf', criterio: 'endereco_fiscal',
            });
            await vinculo(inv.id, raiz.id, id, 'compartilha_endereco_fiscal', 45,
              'Endereço fiscal compatível; requer confirmação independente antes de qualquer medida.');
            // O CNPJ entra no trecho: sem ele o hash era igual para todas as
            // empresas do endereço e cada upsert roubava a evidência da anterior.
            await evidencia(inv.id, id, 'viacep', 'CEP validado antes do cruzamento', `${rua}, ${numero} · CEP ${cep} · ${maskCnpj(cnpj)}`, 'https://viacep.com.br/');
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
    await enriquecerEmpresa(inv, raiz, raiz.id, cnpj, contadores, naoConclusivas);
  } else {
    naoConclusivas.push('Pessoa sem nome: a base CNPJ só é pesquisada por nome (com CPF para conferir).');
  }

  const componentes = [] as any[];
  if (empresas) componentes.push({ rotulo: 'Empresas vinculadas', pontos: Math.min(empresas * 10, 20), explicacao: `${empresas} vínculo(s) societário(s) retornado(s) por fonte pública.` });
  if (contadores.pessoas) componentes.push({ rotulo: 'Quadro societário identificado', pontos: Math.min(contadores.pessoas * 4, 15), explicacao: `${contadores.pessoas} pessoa(s) listada(s) no CNPJ; são pistas até confirmação.` });
  if (contadores.enriquecidas) componentes.push({ rotulo: 'Cadastro CNPJ enriquecido', pontos: Math.min(contadores.enriquecidas * 5, 10), explicacao: `${contadores.enriquecidas} empresa(s) consultada(s) na BrasilAPI (situação, capital, QSA).` });
  const score = Math.min(100, componentes.reduce((s, x) => s + Number(x.pontos || 0), 0));
  const resumo = {
    entidades_confirmadas: contadores.confirmadas + (raiz.status_verificacao === 'confirmada' ? 1 : 0),
    entidades_pista: contadores.pistas + contadores.pessoas,
    fontes_concluidas: [...contadores.fontes],
    fontes_nao_conclusivas: naoConclusivas,
    recebe_ente_publico: null,
    cobertura_processual: 'Esta execução não consulta processos judiciais. Ausência de processo no relatório não significa ausência de ação.',
  };
  await sb.from('investigacoes_patrimoniais').update({
    status: naoConclusivas.length && !(empresas || contadores.pessoas) ? 'aguardando_acesso' : 'concluida',
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

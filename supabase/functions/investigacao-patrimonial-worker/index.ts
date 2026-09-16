// Worker da primeira coleta patrimonial. Só consulta fontes públicas: base CNPJ
// carregada no próprio Supabase e BrasilAPI por CNPJ. Sistemas judiciais,
// restritos, CAPTCHA e credenciais de terceiros ficam intencionalmente fora.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
const INVOKE_SECRET = Deno.env.get('INVESTIGACAO_WORKER_INVOKE_SECRET') ?? '';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type':'application/json' } });
const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const key = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
async function safeEqual(a: string, b: string) { const enc=new TextEncoder(); const [x,y]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(a)),crypto.subtle.digest('SHA-256',enc.encode(b))]); const aa=new Uint8Array(x),bb=new Uint8Array(y); let d=aa.length^bb.length; for(let i=0;i<Math.max(aa.length,bb.length);i++) d|=(aa[i]??0)^(bb[i]??0); return d===0; }
async function hash(v: string) { const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
async function evento(id: string, tipo: string, mensagem: string, dados = {}) { await sb.from('investigacao_eventos').insert({investigacao_id:id,tipo,mensagem,dados}); }
async function evidencia(inv: string, entidade: string, fonte: string, titulo: string, trecho: string, url = '') { const h=await hash([fonte,titulo,trecho,url].join('|')); await sb.from('investigacao_evidencias').upsert({investigacao_id:inv,entidade_id:entidade,fonte_codigo:fonte,titulo,trecho,url:url||null,confianca:fonte==='receita_rf'?85:75,hash_conteudo:h},{onConflict:'investigacao_id,fonte_codigo,hash_conteudo'}); }
async function entidade(inv: string, tipo: string, nome: string, documento: string, profundidade: number, confianca: number, status: string, dados = {}) {
  const chave=dig(documento) || key(nome);
  const {data,error}=await sb.from('investigacao_entidades').upsert({investigacao_id:inv,tipo,nome:nome||null,documento:dig(documento)||null,chave_normalizada:chave,profundidade,confianca,status_verificacao:status,dados},{onConflict:'investigacao_id,tipo,chave_normalizada'}).select('id').single();
  if(error) throw error; return data.id as string;
}
async function vinculo(inv: string, origem: string, destino: string, tipo: string, confianca: number, justificativa: string) { await sb.from('investigacao_vinculos').upsert({investigacao_id:inv,origem_entidade_id:origem,destino_entidade_id:destino,tipo,confianca,justificativa},{onConflict:'investigacao_id,origem_entidade_id,destino_entidade_id,tipo'}); }

async function processar(inv: any) {
  await sb.from('investigacoes_patrimoniais').update({status:'em_andamento',iniciado_em:new Date().toISOString()}).eq('id',inv.id);
  const {data:raizes,error}=await sb.from('investigacao_entidades').select('*').eq('investigacao_id',inv.id).eq('profundidade',0).limit(1);
  if(error || !raizes?.[0]) throw error || new Error('Entidade-raiz ausente');
  const raiz=raizes[0]; let empresas=0, pessoas=0, naoConclusivas:string[]=[];
  await evento(inv.id,'fonte_iniciada','Iniciada consulta em fontes públicas.',{fontes:['receita_rf','brasilapi']});
  if(raiz.tipo==='pessoa' && raiz.nome){
    const {data:rows,error:rpcError}=await sb.rpc('buscar_empresas_por_socio',{p_nome:raiz.nome,p_cpf:dig(raiz.documento)||null});
    if(rpcError) naoConclusivas.push('Receita/base CNPJ indisponível: '+rpcError.message);
    for(const r of (rows||[]).slice(0,Math.max(0,Math.min(Number(inv.entidades_maximas||80)-1,100)))){
      const cnpj=dig(r.cnpj); if(cnpj.length!==14) continue;
      const id=await entidade(inv.id,'empresa',r.nome||r.fantasia||cnpj,cnpj,1,r.confere===true?90:65,r.confere===false?'pista':'confirmada',{situacao:r.situacao||null,papel:r.papel||null,fonte:'receita_rf'});
      await vinculo(inv.id,raiz.id,id,'socio_de',r.confere===true?90:65,r.confere===true?'CPF confirmado pelos seis dígitos públicos do QSA.':'Vínculo por nome; requer confirmação antes de uso.');
      await evidencia(inv.id,id,'receita_rf','Empresa vinculada na base CNPJ',`${r.nome||r.fantasia||cnpj} · CNPJ ${cnpj} · ${r.papel||'vínculo societário'}`); empresas++;
    }
    // CEP de município inteiro (ViaCEP sem logradouro) NÃO é pista de endereço.
    // Só cruza a base CNPJ quando ViaCEP devolve rua e há número informado.
    const end=(raiz.dados||{}).endereco||{}; const cep=dig(end.cep), numero=String(end.numero||'').trim();
    if(cep.length===8 && numero){
      try {
        const vr=await fetch(`https://viacep.com.br/ws/${cep}/json/`,{signal:AbortSignal.timeout(10000)});
        const v:any=await vr.json(); const rua=String(v?.logradouro||'').trim();
        if(!rua || v?.erro) {
          naoConclusivas.push(`ViaCEP: CEP ${cep} sem logradouro específico; cruzamento de endereço não executado.`);
        } else {
          const {data:porEndereco,error:ee}=await sb.rpc('buscar_empresas_por_endereco',{p_cep:cep,p_numero:numero,p_logradouro:rua});
          if(ee) naoConclusivas.push('Receita/endereço indisponível: '+ee.message);
          for(const r of (porEndereco||[]).slice(0,20)){
            const cnpj=dig(r.cnpj); if(cnpj.length!==14) continue;
            const id=await entidade(inv.id,'empresa',r.nome||r.fantasia||cnpj,cnpj,1,45,'pista',{situacao:r.situacao||null,fonte:'receita_rf',criterio:'endereco_fiscal'});
            await vinculo(inv.id,raiz.id,id,'compartilha_endereco_fiscal',45,'Endereço fiscal compatível; requer confirmação independente antes de qualquer medida.');
            await evidencia(inv.id,id,'viacep','CEP validado antes do cruzamento',`${rua}, ${numero} · CEP ${cep}`,'https://viacep.com.br/');
          }
        }
      } catch(e) { naoConclusivas.push('ViaCEP não conclusivo: '+(e instanceof Error?e.message:String(e))); }
    }
  } else if(raiz.tipo==='empresa' && dig(raiz.documento).length===14) {
    const cnpj=dig(raiz.documento); const url=`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`;
    try {
      const res=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
      if(!res.ok) throw new Error(`BrasilAPI HTTP ${res.status}`);
      const j:any=await res.json();
      await evidencia(inv.id,raiz.id,'brasilapi','Cadastro CNPJ consultado',`${j.razao_social||raiz.nome||cnpj} · situação ${j.descricao_situacao_cadastral||'não informada'}`,url);
      for(const q of (Array.isArray(j.qsa)?j.qsa:[]).slice(0,Math.max(0,Math.min(Number(inv.entidades_maximas||80)-1,100)))){
        const nome=String(q.nome_socio||'').trim(); if(!nome) continue;
        const id=await entidade(inv.id,'pessoa',nome,q.cnpj_cpf_do_socio||'',1,60,'pista',{qualificacao:q.qualificacao_socio||null,fonte:'brasilapi'});
        await vinculo(inv.id,raiz.id,id,'tem_socio',60,'Quadro societário público; documento pode estar mascarado.');
        await evidencia(inv.id,id,'brasilapi','Sócio no quadro societário',`${nome}${q.qualificacao_socio?' · '+q.qualificacao_socio:''}`,url); pessoas++;
      }
    } catch(e) { naoConclusivas.push('BrasilAPI não conclusiva: '+(e instanceof Error?e.message:String(e))); }
  }
  const componentes=[] as any[];
  if(empresas) componentes.push({rotulo:'Empresas vinculadas',pontos:Math.min(empresas*10,20),explicacao:`${empresas} vínculo(s) societário(s) retornado(s) por fonte pública.`});
  if(pessoas) componentes.push({rotulo:'Quadro societário identificado',pontos:Math.min(pessoas*4,15),explicacao:`${pessoas} pessoa(s) listada(s) no CNPJ; são pistas até confirmação.`});
  const score=Math.min(100,componentes.reduce((s,x)=>s+Number(x.pontos||0),0));
  const resumo={entidades_confirmadas:empresas+(raiz.status_verificacao==='confirmada'?1:0),entidades_pista:pessoas,fontes_concluidas:['receita_rf','brasilapi'],fontes_nao_conclusivas:naoConclusivas,recebe_ente_publico:null,cobertura_processual:'Esta execução inicial não consulta processos. O radar processual público deve registrar tribunais/UF efetivamente cobertos.'};
  await sb.from('investigacoes_patrimoniais').update({status:naoConclusivas.length&&!(empresas||pessoas)?'aguardando_acesso':'concluida',concluido_em:new Date().toISOString(),score_prioridade:score,score_componentes:componentes,resumo}).eq('id',inv.id);
  await evento(inv.id,naoConclusivas.length?'fonte_nao_conclusiva':'fonte_concluida',naoConclusivas.length?naoConclusivas.join(' | '):'Fontes públicas concluídas.',resumo);
  return {id:inv.id,empresas,pessoas,naoConclusivas};
}

Deno.serve(async req => {
  if(req.method==='OPTIONS') return new Response('ok');
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  const token=(req.headers.get('authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!INVOKE_SECRET || !token || !(await safeEqual(token,INVOKE_SECRET))) return json({error:'unauthorized'},401);
  const body=await req.json().catch(()=>({})); const limit=Math.max(1,Math.min(Number(body.limit)||5,10));
  const {data:pendentes,error}=await sb.from('investigacoes_patrimoniais').select('*').eq('status','pendente').order('created_at').limit(limit);
  if(error) return json({error:error.message},500);
  const resultados=[]; for(const inv of pendentes||[]) { try{resultados.push(await processar(inv));}catch(e){const msg=e instanceof Error?e.message:String(e); await sb.from('investigacoes_patrimoniais').update({status:'falhou',resumo:{erro:msg}}).eq('id',inv.id); await evento(inv.id,'status','Falha na coleta: '+msg); resultados.push({id:inv.id,erro:msg});} }
  return json({ok:true,processadas:resultados.length,resultados});
});

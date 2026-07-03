// assets/js/nf.js — Emitir NF v2 · Fila do Asaas (handoff docs/design_handoff_nf_v2).
// Todo pagamento RECEBIDO no Asaas cai em nf_fila_analise como 'pendente' (via
// asaas-webhook) e aparece no card do topo da tela Emitir NF. O usuário decide,
// item a item ou em lote: Emitir NF ou Dispensar. NADA é emitido sozinho.
// Carregado pelo index.html (<script src="/assets/js/nf.js" defer>); usa os
// helpers globais da tela (getSupabase, authHeaders, escHtml, showToast,
// nfaFmtBRL, nfaMaskDoc, nfaDigits). Funções expostas em window (script clássico).

// ── estado ───────────────────────────────────────────────────────────────────
let _nffFila = [];            // linhas pendentes de nf_fila_analise
let _nffSel = new Set();      // ids selecionados p/ lote
let _nffCarregada = false;    // já buscou ao menos uma vez (badge)
let _nffEnriquecendo = false; // trava do enriquecimento lazy via Asaas

// ── tokens do protótipo (com fallback nos tokens da marca) ───────────────────
const NFF_C = {
  card: 'var(--surface,#FFFDF7)',
  ink: 'var(--text-1,#0A1530)',
  gold: 'var(--gold,#C9A961)',
  goldDark: 'var(--gold-dark,#9C7F40)',
  verde: 'var(--success,#5E7C58)',
  vermelho: 'var(--danger,#A65A4A)',
  mono: 'var(--mono,"JetBrains Mono",monospace)',
};

// ── init (chamado por renderNfAvulsa) ────────────────────────────────────────
function nffInit(){
  _nffSel = new Set();
  nffDraw();
  nffCarregar();
}

function nffPendentes(){ return _nffCarregada ? _nffFila.length : 0; }

// ── carga + enriquecimento lazy ──────────────────────────────────────────────
async function nffCarregar(){
  const supa = (typeof getSupabase==='function') ? getSupabase() : null;
  if(!supa) return;
  try{
    const { data, error } = await supa.from('nf_fila_analise')
      .select('*').eq('status','pendente').order('recebido_em',{ascending:false}).limit(200);
    if(error) throw error;
    _nffFila = data||[];
    _nffCarregada = true;
  }catch(e){
    const box=document.getElementById('nff-fila');
    if(box) box.innerHTML = `<div style="font-size:12.5px;color:${NFF_C.vermelho};">Fila de recebimentos indisponível: ${escHtml(traduzirErro(e.message||String(e)))}</div>`;
    return;
  }
  nffDraw();
  if(typeof nfaUpdateNavBadge==='function') nfaUpdateNavBadge();
  // Enriquecimento lazy SÓ com a tela aberta (consulta o customer no Asaas).
  const pg=document.getElementById('page-nf-avulsa');
  if(pg && pg.classList.contains('active')) nffEnriquecer();
}

// Badge no menu já no load do app (sem precisar abrir a tela): espera a sessão.
(function nffBoot(){
  let tent=0;
  const t=setInterval(()=>{
    tent++;
    const supa=(typeof getSupabase==='function')?getSupabase():null;
    if(supa){ clearInterval(t); nffCarregar(); }
    else if(tent>20) clearInterval(t);
  }, 1500);
})();

// Preenche, no primeiro render, o que o webhook não sabia: nome/cpf (recebimento
// sem devedor casado) e endereco_ok (city + postalCode presentes no Asaas).
async function nffEnriquecer(){
  if(_nffEnriquecendo) return;
  const alvos = _nffFila.filter(q => q.customer_id && (q.endereco_ok==null || !q.nome));
  if(!alvos.length) return;
  _nffEnriquecendo = true;
  const supa = getSupabase();
  try{
    const hdr = { 'Content-Type':'application/json', ...(await authHeaders()) };
    for(const q of alvos){
      try{
        const r = await fetch(`/api/asaas?path=customers/${encodeURIComponent(q.customer_id)}`, { headers: hdr });
        const c = await r.json().catch(()=>({}));
        if(!r.ok || !c || !c.id) continue;
        const upd = {
          nome: q.nome || c.name || null,
          cpf_cnpj: q.cpf_cnpj || c.cpfCnpj || null,
          endereco_ok: !!(c.city && c.postalCode)
        };
        Object.assign(q, upd);
        if(supa) await supa.from('nf_fila_analise').update(upd).eq('id', q.id);
      }catch(_){/* best-effort por item */}
    }
  } finally {
    _nffEnriquecendo = false;
    nffDraw();
  }
}

// ── render do card da fila ───────────────────────────────────────────────────
function nffQuando(ts){
  if(!ts) return '—';
  const d=new Date(ts), hoje=new Date(), ontem=new Date(); ontem.setDate(hoje.getDate()-1);
  const hm=d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  if(d.toDateString()===hoje.toDateString()) return 'hoje, '+hm;
  if(d.toDateString()===ontem.toDateString()) return 'ontem, '+hm;
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})+', '+hm;
}

function _nffBtn(label, onclick, kind, title){
  const base='font-size:11.5px;border-radius:8px;padding:6px 11px;cursor:pointer;white-space:nowrap;';
  const st = kind==='primary' ? `background:${NFF_C.ink};color:#EFEAD9;border:0.5px solid ${NFF_C.ink};font-weight:700;`
    : kind==='gold' ? `background:rgba(201,169,97,0.12);color:${NFF_C.goldDark};border:0.5px solid ${NFF_C.gold};font-weight:600;`
    : `background:transparent;color:${NFF_C.ink};border:0.5px solid rgba(10,21,48,0.16);font-weight:600;`;
  return `<button onclick="${onclick}" ${title?`title="${escHtml(title)}"`:''} style="${base}${st}">${label}</button>`;
}

function nffDraw(){
  const box=document.getElementById('nff-fila'); if(!box) return;
  const grid='display:grid;grid-template-columns:30px minmax(230px,1.5fr) 100px 62px 88px 236px;gap:10px;align-items:center;padding:12px 20px;';
  const soma=_nffFila.reduce((s,q)=>s+(Number(q.valor)||0),0);
  _nffFila.forEach(q=>{ if(!_nffFila.some(x=>x.id===q.id)) _nffSel.delete(q.id); });
  const selItems=_nffFila.filter(q=>_nffSel.has(q.id));
  const selOk=selItems.filter(q=>q.endereco_ok===true);

  const headerDir = selItems.length
    ? `<span style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.6);">${selItems.length} selecionado(s)</span>
       ${_nffBtn('Dispensar', 'nffDispensarSel()', 'ghost', 'Não emitir NF destes recebimentos')}
       ${_nffBtn('✓ Emitir NF ('+selOk.length+')', 'nffEmitirSel()', 'primary', 'Emitir NF dos selecionados com endereço ok')}`
    : `<span style="font-size:11.5px;color:rgba(10,21,48,0.5);">marque os recebimentos para emitir em lote</span>`;

  const linha=(q)=>{
    const on=_nffSel.has(q.id);
    const endTxt = q.endereco_ok===true ? `<span style="color:${NFF_C.verde};">endereço ok</span>`
      : q.endereco_ok===false ? `<span style="color:${NFF_C.vermelho};font-weight:600;">sem endereço no Asaas</span>`
      : `<span style="color:rgba(10,21,48,0.45);">verificando endereço…</span>`;
    const acoes = q.endereco_ok===true
      ? `${_nffBtn('Emitir NF', `nffEmitir(['${q.id}'])`, 'primary')} ${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`
      : q.endereco_ok===false
      ? `${_nffBtn('Asaas ↗', `nffAbrirAsaas('${q.id}')`, 'gold', 'Abrir o cadastro no Asaas para completar o endereço')} ${_nffBtn('🔎', `nffRevalidar('${q.id}')`, 'ghost', 'Reconsultar o endereço no Asaas')} ${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`
      : `${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`;
    const doc = q.cpf_cnpj ? nfaMaskDoc(nfaDigits(q.cpf_cnpj)) : 'sem CPF';
    return `<div style="${grid}border-top:0.5px solid rgba(10,21,48,0.07);">
      <div onclick="nffToggle('${q.id}')" role="checkbox" aria-checked="${on}" style="width:16px;height:16px;border-radius:4px;cursor:pointer;border:1.5px solid ${on?NFF_C.gold:'rgba(10,21,48,0.3)'};background:${on?NFF_C.gold:'transparent'};display:flex;align-items:center;justify-content:center;">
        ${on?`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0A1530" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`:''}
      </div>
      <div style="min-width:0;">
        <div style="font-size:13px;font-weight:600;color:${NFF_C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(q.nome||'(sem nome — verificando no Asaas)')}</div>
        <div style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${escHtml(doc)} · ${endTxt}</div>
      </div>
      <div style="font-family:${NFF_C.mono};font-size:12.5px;font-weight:600;text-align:right;color:${NFF_C.ink};">${nfaFmtBRL(q.valor)}</div>
      <div style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;text-transform:uppercase;text-align:center;background:rgba(10,21,48,0.06);border-radius:100px;padding:3px 0;color:${NFF_C.ink};">${escHtml(q.origem||'—')}</div>
      <div style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${escHtml(nffQuando(q.recebido_em))}</div>
      <div style="display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;">${acoes}</div>
    </div>`;
  };

  box.innerHTML=`<div style="background:${NFF_C.card};border:0.5px solid rgba(201,169,97,0.55);border-radius:16px;overflow:hidden;">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 20px;background:rgba(201,169,97,0.08);border-bottom:0.5px solid rgba(201,169,97,0.35);">
      <span style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${NFF_C.goldDark};">Recebidos no Asaas · aguardando sua análise</span>
      ${_nffFila.length?`<span style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${nfaFmtBRL(soma)} recebidos</span>`:''}
      <span style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${_nffFila.length?headerDir:''}</span>
    </div>
    ${_nffFila.length
      ? _nffFila.map(linha).join('')
      : `<div style="padding:26px 20px;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:16px;color:rgba(10,21,48,0.5);">Nenhum recebimento aguardando análise. Quando alguém pagar no Asaas, aparece aqui.</div>`}
  </div>`;
}

function nffToggle(id){ if(_nffSel.has(id)) _nffSel.delete(id); else _nffSel.add(id); nffDraw(); }

// ── dispensar (registra a decisão; some da fila) ─────────────────────────────
async function nffDispensarSel(){ const ids=[..._nffSel]; _nffSel.clear(); await nffDispensar(ids); }
async function nffDispensar(ids){
  ids=(ids||[]).filter(Boolean); if(!ids.length) return;
  const supa=getSupabase(); if(!supa){ showToast('Faça login para decidir a fila.','warning'); return; }
  let uid=null; try{ const { data }=await supa.auth.getUser(); uid=data&&data.user&&data.user.id||null; }catch(_){}
  const nomes=ids.map(id=>{ const q=_nffFila.find(x=>x.id===id); return q&&q.nome||''; }).filter(Boolean);
  try{
    const { error }=await supa.from('nf_fila_analise')
      .update({ status:'dispensada', decidido_em:new Date().toISOString(), decidido_por:uid })
      .in('id', ids).eq('status','pendente');
    if(error) throw error;
  }catch(e){ showToast('Falha ao dispensar: '+traduzirErro(e.message||String(e)),'danger'); return; }
  _nffFila=_nffFila.filter(q=>!ids.includes(q.id));
  ids.forEach(id=>_nffSel.delete(id));
  showToast(ids.length===1
    ? `Recebimento${nomes[0]?' de '+nomes[0]:''} dispensado — não vira NF.`
    : `${ids.length} recebimento(s) dispensado(s) — não viram NF.`,'success');
  nffDraw();
  if(typeof nfaUpdateNavBadge==='function') nfaUpdateNavBadge();
}

// ── endereço: abrir no Asaas + revalidar ─────────────────────────────────────
function nffAbrirAsaas(id){
  const q=_nffFila.find(x=>x.id===id);
  const url = (q&&q.customer_id)
    ? 'https://www.asaas.com/customerAccount/show/'+encodeURIComponent(q.customer_id)
    : 'https://www.asaas.com/customerAccount';
  window.open(url,'_blank','noopener');
}
async function nffRevalidar(id){
  const q=_nffFila.find(x=>x.id===id); if(!q||!q.customer_id){ showToast('Sem customer do Asaas nesta linha.','warning'); return; }
  try{
    const hdr={ 'Content-Type':'application/json', ...(await authHeaders()) };
    const r=await fetch(`/api/asaas?path=customers/${encodeURIComponent(q.customer_id)}`,{headers:hdr});
    const c=await r.json().catch(()=>({}));
    if(!r.ok||!c||!c.id) throw new Error(c?.errors?.[0]?.description||c?.error||('HTTP '+r.status));
    const upd={ nome:q.nome||c.name||null, cpf_cnpj:q.cpf_cnpj||c.cpfCnpj||null, endereco_ok:!!(c.city&&c.postalCode) };
    Object.assign(q,upd);
    const supa=getSupabase(); if(supa) await supa.from('nf_fila_analise').update(upd).eq('id',q.id);
    showToast(upd.endereco_ok?'Endereço encontrado no Asaas — pronto para emitir. ✓':'Ainda sem cidade+CEP no Asaas — complete o cadastro e revalide.', upd.endereco_ok?'success':'warning');
  }catch(e){ showToast('Falha ao revalidar: '+traduzirErro(e.message||String(e)),'danger'); }
  nffDraw();
}

// ── emitir (nesta etapa: carrega no lote existente; a emissão direta com modal
// de confirmação da fila chega no PR seguinte do handoff) ─────────────────────
function nffEmitirSel(){ nffEmitir([..._nffSel]); }
function nffEmitir(ids){
  const items=(ids||[]).map(id=>_nffFila.find(x=>x.id===id)).filter(q=>q&&q.endereco_ok===true);
  if(!items.length){ showToast('Nenhum item com endereço ok para emitir.','warning'); return; }
  let add=0;
  items.forEach(q=>{
    const doc=nfaDigits(q.cpf_cnpj||'');
    const ja=_nfaRows.some(x=>nfaDigits(x.cpf)===doc && nfaParseValor(x.valorRaw)===Number(q.valor) && x.status!=='emitida');
    if(ja) return;
    _nfaRows.push({ nome:q.nome||'', cpf:doc?nfaMaskDoc(doc):'', valorRaw:nfaFmtBRL(q.valor), descricao:'Honorários de cobrança',
      asaasCustomerId:q.customer_id||'', status:'pendente', nf_url:'', erro:'', ref:'', asaas:null, _nffFilaId:q.id });
    add++;
  });
  nfaDrawTabela();
  const t=document.getElementById('nfa-tabela'); if(t) t.scrollIntoView({behavior:'smooth',block:'center'});
  showToast(add?`${add} recebimento(s) carregado(s) no lote — confirme a emissão abaixo.`:'Já estão no lote de emissão.','success');
}

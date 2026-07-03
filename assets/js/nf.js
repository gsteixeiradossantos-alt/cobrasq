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
  if(typeof nffRenderRail==='function') nffRenderRail();
}

function nffToggle(id){ if(_nffSel.has(id)) _nffSel.delete(id); else _nffSel.add(id); nffDraw(); }

// ── rail direito (296px): resumo do mês · precisa de você · modelo ativo ─────
function nffRenderRail(){
  const box=document.getElementById('nff-rail'); if(!box) return;
  const hist=(typeof _nfaHist!=='undefined'&&_nfaHist)||[];
  const agora=new Date();
  const noMes=r=>{ const d=r.criada_em?new Date(r.criada_em):null; return d && d.getMonth()===agora.getMonth() && d.getFullYear()===agora.getFullYear(); };
  const mes=hist.filter(r=>noMes(r)&&nfaEffStatus(r)!=='arquivada');
  const nEmit=mes.filter(r=>nfaEffStatus(r)==='emitida').length;
  const nProc=mes.filter(r=>nfaEffStatus(r)==='processando').length;
  const nErro=mes.filter(r=>nfaEffStatus(r)==='erro').length;
  const valEmit=mes.filter(r=>nfaEffStatus(r)==='emitida').reduce((s,r)=>s+(Number(r.valor)||0),0);
  const issRet=mes.filter(r=>nfaEffStatus(r)==='emitida').reduce((s,r)=>s+(Number(r.valor)||0)*nfaRowAliq(r)/100,0);
  const nSemEnd=_nffFila.filter(q=>q.endereco_ok===false).length;
  const fila=_nffFila.length;
  const tot=Math.max(nEmit+nProc+nErro,1);
  const mesLabel=agora.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}).toUpperCase();
  const lbl=`font-family:${NFF_C.mono};font-size:9px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;`;
  const cardSt=(borda)=>`background:${NFF_C.card};border:0.5px solid ${borda||'rgba(10,21,48,0.12)'};border-radius:14px;padding:15px 17px;margin-bottom:14px;`;
  const lin=(a,b,cor)=>`<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-top:7px;"><span style="color:rgba(10,21,48,0.6);">${a}</span><b style="font-family:${NFF_C.mono};${cor?`color:${cor};`:''}">${b}</b></div>`;

  const precisa=[];
  if(fila) precisa.push(`<div><b>${fila} recebimento(s)</b> aguardando decisão de emissão.</div>`);
  if(nSemEnd) precisa.push(`<div><b>${nSemEnd} tomador(es)</b> sem endereço no Asaas — não dá para emitir até corrigir.</div>`);
  if(nErro) precisa.push(`<div><b>${nErro} nota(s) com erro</b> na prefeitura.</div>`);
  const m=nfaModeloAtivo();

  box.innerHTML=`
    <div style="${cardSt()}">
      <div style="${lbl}color:${NFF_C.goldDark};margin-bottom:4px;">${escHtml(mesLabel)} · RESUMO</div>
      ${lin('Aguardando análise', fila)}
      ${lin('Notas no mês', mes.length)}
      ${lin('Valor emitido', nfaFmtBRL(valEmit))}
      ${lin(`ISS retido`, '− '+nfaFmtBRL(issRet), NFF_C.vermelho)}
      <div style="display:flex;gap:3px;margin-top:13px;height:6px;border-radius:100px;overflow:hidden;">
        <span style="flex:${nEmit/tot};background:${NFF_C.verde};"></span>
        <span style="flex:${nProc/tot};background:#56618A;"></span>
        <span style="flex:${nErro/tot};background:${NFF_C.vermelho};"></span>
      </div>
      <div style="display:flex;gap:9px;margin-top:7px;font-size:10.5px;color:rgba(10,21,48,0.55);flex-wrap:wrap;">
        <span><span style="color:${NFF_C.verde};">●</span> ${nEmit} emitidas</span>
        <span><span style="color:#56618A;">●</span> ${nProc} proc.</span>
        <span><span style="color:${NFF_C.vermelho};">●</span> ${nErro} erro</span>
      </div>
    </div>
    ${precisa.length?`<div style="${cardSt('rgba(166,90,74,0.35)')}">
      <div style="${lbl}color:${NFF_C.vermelho};margin-bottom:9px;">PRECISA DE VOCÊ</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12.5px;line-height:1.5;color:${NFF_C.ink};">${precisa.join('')}</div>
    </div>`:''}
    <div style="${cardSt()}">
      <div style="display:flex;align-items:center;margin-bottom:8px;">
        <span style="${lbl}color:${NFF_C.goldDark};">MODELO ATIVO</span>
        <button onclick="nfaIrConfigFiscal()" style="margin-left:auto;background:none;border:0;cursor:pointer;font-size:11px;font-weight:600;color:${NFF_C.goldDark};">⚙ Config</button>
      </div>
      <div style="font-size:13px;font-weight:600;color:${NFF_C.ink};">${escHtml(m.municipio||'Defina o município')}</div>
      <div style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);margin-top:2px;">serviço ${escHtml(m.codigo||m.asaasId||'—')} · ISS ${escHtml(String(nfaAliquota()))}%${m.nome?' · '+escHtml(m.nome):''}</div>
    </div>
    <div style="padding:0 4px;font-size:11px;color:rgba(10,21,48,0.5);line-height:1.55;">Conciliação de ISS por competência, modelos por município e notificação ao tomador moram em <b>Config</b>.</div>`;
}

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

// ── emitir a partir da fila (modal de confirmação IRREVERSÍVEL) ──────────────
let _nffEmitindo = false;
function nffEmitirSel(){ nffEmitir([..._nffSel]); }
function nffEmitir(ids){
  if(_nffEmitindo){ showToast('Aguarde — já há uma emissão em andamento.','warning'); return; }
  if(!_nfaMunReady()){
    showToast('Informe o serviço municipal (código) no modelo ativo antes de emitir.','warning');
    if(typeof nfaIrConfigFiscal==='function') nfaIrConfigFiscal();
    return;
  }
  const sel=(ids||[]).map(id=>_nffFila.find(x=>x.id===id)).filter(Boolean);
  const itens=sel.filter(q=>q.endereco_ok===true);
  const deixados=sel.filter(q=>q.endereco_ok!==true);
  if(!itens.length){ showToast('Nenhum item com endereço ok para emitir.','warning'); return; }
  const m=nfaModeloAtivo(), aliq=nfaAliquota();
  const total=itens.reduce((s,q)=>s+(Number(q.valor)||0),0);
  const linhas=itens.map(q=>`<div style="display:flex;justify-content:space-between;font-size:13px;">
      <span>${escHtml(q.nome||'(sem nome)')}</span>
      <span style="font-family:${NFF_C.mono};font-weight:500;">${nfaFmtBRL(q.valor)}</span>
    </div>`).join('');
  const aviso=deixados.length?`<div style="margin-top:4px;padding:11px 13px;border-radius:10px;background:rgba(201,169,97,0.14);border:0.5px solid rgba(201,169,97,0.45);font-size:11.5px;color:#7a5b10;line-height:1.55;">
      <b>Fica de fora:</b> ${escHtml(deixados.map(q=>(q.nome||'sem nome')+' (sem endereço)').join(' · '))}
    </div>`:'';
  _nffIdsModal=itens.map(q=>q.id);
  _nfaModal(`
    <div style="padding:22px 24px 18px;border-bottom:0.5px solid rgba(10,21,48,0.12);">
      <div style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${NFF_C.goldDark};">Confirmar emissão · irreversível</div>
      <h3 style="margin:6px 0 2px;font-size:22px;font-weight:600;color:${NFF_C.ink};">Emitir ${itens.length} nota(s)?</h3>
      <div style="font-size:13px;color:rgba(10,21,48,0.6);">${escHtml(m.municipio||'—')} · código ${escHtml(m.codigo||m.asaasId||'—')} · ISS ${escHtml(String(aliq))}%</div>
    </div>
    <div style="padding:18px 24px;display:flex;flex-direction:column;gap:10px;">
      ${linhas}
      <div style="border-top:0.5px solid rgba(10,21,48,0.14);padding-top:10px;display:flex;justify-content:space-between;font-size:13px;">
        <span style="color:rgba(10,21,48,0.6);">Total dos serviços</span><b style="font-family:${NFF_C.mono};">${nfaFmtBRL(total)}</b>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;">
        <span style="color:rgba(10,21,48,0.6);">ISS estimado retido</span><b style="font-family:${NFF_C.mono};color:${NFF_C.vermelho};">− ${nfaFmtBRL(total*aliq/100)}</b>
      </div>
      <div style="font-size:11px;color:rgba(10,21,48,0.5);">ISS é estimativa pela alíquota do modelo; o valor oficial é o que a prefeitura apura.</div>
      ${aviso}
    </div>
    <div style="padding:16px 24px;display:flex;gap:10px;justify-content:flex-end;border-top:0.5px solid rgba(10,21,48,0.12);">
      <button class="btn btn-ghost btn-sm" onclick="_nfaCloseModal()">Voltar</button>
      <button class="btn btn-primary btn-sm" onclick="_nffEmitirConfirmado()">✓ Emitir ${itens.length} nota(s)</button>
    </div>`);
}

let _nffIdsModal=[];
async function _nffEmitirConfirmado(){
  _nfaCloseModal();
  const itens=_nffIdsModal.map(id=>_nffFila.find(x=>x.id===id)).filter(q=>q&&q.endereco_ok===true);
  _nffIdsModal=[];
  if(!itens.length) return;
  _nffEmitindo=true;
  const supa=getSupabase();
  let uid=null; try{ const { data }=await supa.auth.getUser(); uid=data&&data.user&&data.user.id||null; }catch(_){}
  const m=nfaModeloAtivo(), aliq=nfaAliquota(), comp=nfaCompetencia();
  let ok=0, fail=0, done=0;
  try{
    // SEQUENCIAL de propósito (não paralelo): emissão real na prefeitura.
    for(const q of itens){
      done++;
      showToast(`Emitindo ${done} de ${itens.length}…`,'info');
      let ref; try{ ref=crypto.randomUUID(); }catch(_){ ref='nff-'+q.id; }
      try{
        const resp=await fetch('/api/emitir-nf-avulso',{
          method:'POST',
          headers:{ 'Content-Type':'application/json', ...(await authHeaders()) },
          body: JSON.stringify({ nome:q.nome||'', doc:nfaDigits(q.cpf_cnpj||''), valor:Number(q.valor)||0,
            descricao:'Honorários de cobrança', ref, asaas_customer_id:q.customer_id||null,
            competencia:comp, aliquota:aliq, modelo_nome:m.nome||'', municipio:m.municipio||'',
            ..._nfaMunParams() }),
        });
        const j=await resp.json().catch(()=>({}));
        if(!resp.ok || !j.ok){ throw new Error(traduzirErro(j.erro||j.error||j.message||('HTTP '+resp.status))); }
        // Decisão registrada: acha a linha criada em nf_avulsa (por ref; fallback
        // pelo id da invoice, p/ dedup 'já emitida') e vincula na fila.
        let nfId=null;
        try{
          let qr=await supa.from('nf_avulsa').select('id').eq('metadata->>ref', ref).order('criada_em',{ascending:false}).limit(1);
          if(qr.data&&qr.data[0]) nfId=qr.data[0].id;
          else if(j.nf_id){ qr=await supa.from('nf_avulsa').select('id').eq('nf_asaas_id', j.nf_id).order('criada_em',{ascending:false}).limit(1); if(qr.data&&qr.data[0]) nfId=qr.data[0].id; }
        }catch(_){}
        await supa.from('nf_fila_analise')
          .update({ status:'emitida', decidido_em:new Date().toISOString(), decidido_por:uid, nf_avulsa_id:nfId })
          .eq('id', q.id);
        _nffFila=_nffFila.filter(x=>x.id!==q.id);
        _nffSel.delete(q.id);
        ok++;
      }catch(e){
        fail++;
        showToast(`Falha em ${q.nome||'item'}: ${traduzirErro(e.message||String(e))} — segue pendente na fila.`,'danger');
      }
      nffDraw();
    }
  } finally { _nffEmitindo=false; }
  showToast(`${ok} nota(s) enviada(s) para emissão${fail?`, ${fail} falha(s) (seguem na fila)`:''} — acompanhe no histórico abaixo.`, fail?'warning':'success');
  if(typeof nfaUpdateNavBadge==='function') nfaUpdateNavBadge();
  if(typeof nfaCarregarHistorico==='function') await nfaCarregarHistorico(); // nota entra como 'processando'/'emitida'
}

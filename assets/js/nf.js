// assets/js/nf.js — Emitir NF v2 · Fila de recebimentos (handoff docs/design_handoff_nf_v2).
// Todo pagamento RECEBIDO no Asaas cai em nf_fila_analise como 'pendente' (via
// asaas-webhook) e aparece no card do topo da tela Emitir NF. O usuário decide,
// item a item ou em lote: manda para o ESNFS ou Dispensa. NADA é emitido sozinho.
//
// Desde 13/09/2026 a emissão é no ESNFS (prefeitura de Dois Vizinhos), pela extensão
// extensao/esnfs/ — a rota pelo Asaas (nffEmitir → api/_emitir-nf-avulso.js) nunca
// emitiu uma nota em produção e saiu da tela (o código fica, sem botão). A ponte é
// por área de transferência (assets/js/esnfs-ponte.js):
//   "Copiar lote p/ ESNFS"  → texto `Nome | CPF | base | fila:<id>` para a extensão;
//   "Importar resultado"    → cola o relatório da extensão; cada nota emitida vira
//                             linha em nf_avulsa (origem 'esnfs', nº da prefeitura),
//                             a fila fica 'emitida' e a fin_operacao ganha nf_status.
// A BASE de cada linha vem do painel (esnfsBaseFiscal): honorário quando há capital
// do credor na fin_operacao casada, valor cheio quando não há.
// Carregado pelo index.html (<script src="/assets/js/nf.js" defer>); usa os
// helpers globais da tela (getSupabase, authHeaders, escHtml, showToast,
// nfaFmtBRL, nfaMaskDoc, nfaDigits). Funções expostas em window (script clássico).

// ── estado ───────────────────────────────────────────────────────────────────
let _nffFila = [];            // linhas pendentes de nf_fila_analise
let _nffOps = {};             // fin_operacao casada por asaas_payment_id (base fiscal)
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
    // Operação casada por pagamento: é dela que sai a base fiscal (honorário × cheio).
    _nffOps = {};
    const pids = _nffFila.map(q=>q.asaas_payment_id).filter(Boolean);
    for(let i=0;i<pids.length;i+=100){
      const { data: ops } = await supa.from('fin_operacao')
        .select('id,asaas_payment_id,valor_recebido,valor_capital,valor_honorario,repasse_status,nf_status,devedor_id,parcela,total_parcelas')
        .in('asaas_payment_id', pids.slice(i,i+100));
      (ops||[]).forEach(o=>{ _nffOps[o.asaas_payment_id]=o; });
    }
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

// Prontidão para emitir (handoff v3 §9): a fila não é uma lista de recebimentos,
// é uma lista de "dá para emitir agora?". Três estados, que somam o total:
//   pronto        CPF/CNPJ e base fiscal definida (esnfsBaseFiscal)
//   revisar       tem documento, mas o rateio capital/honorário está em revisão
//                 (ou a base deu zero) — sem base não há valor para a nota
//   sem_id        nem documento tem — o tomador não está identificado
// O endereço do Asaas deixou de barrar: no ESNFS o cadastro do tomador é o da
// prefeitura, e a extensão completa o que faltar.
function nffBase(q){ return esnfsBaseFiscal(q, q && _nffOps[q.asaas_payment_id]); }
function nffProntidao(q){
  if(!q || !q.cpf_cnpj || !nfaDigits(q.cpf_cnpj)) return 'sem_id';
  return nffBase(q).pronto ? 'pronto' : 'revisar';
}
function nffPronto(q){ return nffProntidao(q)==='pronto'; }

function nffDraw(){
  const box=document.getElementById('nff-fila'); if(!box) return;
  const grid='display:grid;grid-template-columns:30px minmax(230px,1.5fr) 100px 62px 88px 236px;gap:10px;align-items:center;padding:12px 20px;';
  const soma=_nffFila.reduce((s,q)=>s+(Number(q.valor)||0),0);
  _nffFila.forEach(q=>{ if(!_nffFila.some(x=>x.id===q.id)) _nffSel.delete(q.id); });
  // Item que deixou de estar pronto não pode continuar selecionado — senão o
  // contador do botão de lote e a seleção visível discordam.
  [..._nffSel].forEach(id=>{ const q=_nffFila.find(x=>x.id===id); if(!q || !nffPronto(q)) _nffSel.delete(id); });
  const selItems=_nffFila.filter(q=>_nffSel.has(q.id));
  const selOk=selItems.filter(nffPronto);
  const nPronto=_nffFila.filter(q=>nffProntidao(q)==='pronto').length;
  const nRevisar=_nffFila.filter(q=>nffProntidao(q)==='revisar').length;
  const nSemId=_nffFila.filter(q=>nffProntidao(q)==='sem_id').length;
  const somaBase=_nffFila.filter(nffPronto).reduce((s,q)=>s+nffBase(q).base,0);
  const kpi=(role,val,sub,bg,fg,bd)=>`<div style="background:${bg};border:1px solid ${bd};border-radius:9px;padding:14px 16px;">
      <div style="font-family:${NFF_C.mono};font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:${fg};opacity:.75;">${role}</div>
      <div style="font-family:'Fraunces',Georgia,serif;font-size:26px;font-weight:400;color:${fg};margin-top:6px;line-height:1;">${val}</div>
      <div style="font-size:11.5px;color:${fg};opacity:.7;margin-top:6px;">${sub}</div>
    </div>`;
  const kpis=`<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">
      ${kpi('A emitir', _nffFila.length, nfaFmtBRL(soma)+' recebidos', NFF_C.ink, '#FFFFFF', NFF_C.ink)}
      ${kpi('Prontos para o ESNFS', nPronto, 'base das notas: '+nfaFmtBRL(somaBase), '#FFFFFF', '#4C6647', '#CFE0CB')}
      ${kpi('Base em revisão', nRevisar, 'rateio capital/honorário pendente', '#FFFFFF', '#7A6428', '#DFC992')}
      ${kpi('Sem identificação', nSemId, 'sem CPF/CNPJ do tomador', '#FFFFFF', '#7D3F33', '#E7CFC7')}
    </div>`;

  const headerDir = (selItems.length
    ? `<span style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.6);">${selItems.length} selecionado(s)</span>
       ${_nffBtn('Dispensar', 'nffDispensarSel()', 'ghost', 'Não emitir NF destes recebimentos')}
       ${_nffBtn('⎘ Copiar lote p/ ESNFS ('+selOk.length+')', 'nffCopiarLoteSel()', 'primary', 'Copia Nome | CPF | base | ref para colar na extensão do ESNFS')}`
    : `${_nffBtn('Marcar prontos', 'nffSelecionarProntos()', 'ghost', 'Seleciona todos os que têm base fiscal definida')}`)
    + ` ${_nffBtn('⤓ Importar resultado do ESNFS', 'nffImportarResultado()', 'gold', 'Cole o relatório da extensão para marcar as notas emitidas')}`;

  const linha=(q)=>{
    const on=_nffSel.has(q.id);
    const pronto=nffPronto(q);
    const st=nffProntidao(q);
    const b=nffBase(q);
    const op=_nffOps[q.asaas_payment_id];
    const parc = op && op.parcela ? ` · parcela ${op.parcela}${op.total_parcelas?'/'+op.total_parcelas:''}` : '';
    const endTxt = st==='pronto'
      ? (b.tipo==='honorario'
          ? `<span style="color:${NFF_C.verde};">nota sobre o honorário: <b>${nfaFmtBRL(b.base)}</b></span> <span style="color:rgba(10,21,48,0.45);">(capital ${nfaFmtBRL(op.valor_capital)} é do credor${parc})</span>`
          : `<span style="color:${NFF_C.verde};">nota sobre o valor cheio</span>${parc?`<span style="color:rgba(10,21,48,0.45);">${parc}</span>`:''}`)
      : st==='revisar' ? `<span style="color:#7A6428;font-weight:600;">${escHtml(b.motivo)}</span> <span style="color:rgba(10,21,48,0.45);">— resolva na Fila do Financeiro</span>`
      : `<span style="color:${NFF_C.vermelho};font-weight:600;">tomador sem CPF/CNPJ</span>`;
    const acoes = st==='pronto'
      ? `${_nffBtn('⎘ ESNFS', `nffCopiarLote(['${q.id}'])`, 'primary', 'Copiar só esta linha para a extensão do ESNFS')} ${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`
      : st==='sem_id'
      ? `${_nffBtn('Asaas ↗', `nffAbrirAsaas('${q.id}')`, 'gold', 'Abrir o cadastro no Asaas para completar o CPF')} ${_nffBtn('🔎', `nffRevalidar('${q.id}')`, 'ghost', 'Reconsultar o cadastro no Asaas')} ${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`
      : `${_nffBtn('Dispensar', `nffDispensar(['${q.id}'])`, 'ghost')}`;
    const doc = q.cpf_cnpj ? nfaMaskDoc(nfaDigits(q.cpf_cnpj)) : 'sem CPF';
    return `<div style="${grid}border-top:0.5px solid rgba(10,21,48,0.07);">
      <div ${pronto?`onclick="nffToggle('${q.id}')"`:''} role="checkbox" aria-checked="${on}" aria-disabled="${!pronto}" title="${pronto?'':'Só entra no lote depois de completar o cadastro do tomador'}" style="width:16px;height:16px;border-radius:4px;cursor:${pronto?'pointer':'not-allowed'};border:1.5px solid ${on?NFF_C.gold:(pronto?'rgba(10,21,48,0.3)':'rgba(10,21,48,0.12)')};background:${on?NFF_C.gold:(pronto?'transparent':'#F5F2EA')};display:flex;align-items:center;justify-content:center;">
        ${on?`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#0A1530" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`:''}
      </div>
      <div style="min-width:0;">
        <div style="font-size:13px;font-weight:600;color:${NFF_C.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(q.nome||'(sem nome — verificando no Asaas)')}</div>
        <div style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${escHtml(doc)} · ${endTxt}</div>
      </div>
      <div style="font-family:${NFF_C.mono};font-size:12.5px;font-weight:600;text-align:right;color:${NFF_C.ink};" title="${st==='pronto'&&b.tipo==='honorario'?'recebido '+escHtml(nfaFmtBRL(q.valor))+' · nota sobre '+escHtml(nfaFmtBRL(b.base)):'recebido'}">${st==='pronto'&&b.tipo==='honorario'?`<span style="color:rgba(10,21,48,0.4);font-weight:400;text-decoration:line-through;">${nfaFmtBRL(q.valor)}</span><br>${nfaFmtBRL(b.base)}`:nfaFmtBRL(q.valor)}</div>
      <div style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;text-transform:uppercase;text-align:center;background:rgba(10,21,48,0.06);border-radius:100px;padding:3px 0;color:${NFF_C.ink};">${escHtml(q.origem||'—')}</div>
      <div style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${escHtml(nffQuando(q.recebido_em))}</div>
      <div style="display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;">${acoes}</div>
    </div>`;
  };

  box.innerHTML=`${_nffFila.length?kpis:''}<div style="background:${NFF_C.card};border:0.5px solid rgba(201,169,97,0.55);border-radius:16px;overflow:hidden;">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:13px 20px;background:rgba(201,169,97,0.08);border-bottom:0.5px solid rgba(201,169,97,0.35);">
      <span style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${NFF_C.goldDark};">Recebidos no Asaas · a emitir no ESNFS</span>
      ${_nffFila.length?`<span style="font-family:${NFF_C.mono};font-size:11px;color:rgba(10,21,48,0.55);">${nfaFmtBRL(soma)} recebidos</span>`:''}
      <span style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">${_nffFila.length?headerDir:''}</span>
    </div>
    ${_nffFila.length
      ? _nffFila.map(linha).join('')
      : `<div style="padding:26px 20px;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:16px;color:rgba(10,21,48,0.5);">Nenhum recebimento aguardando nota. Quando alguém pagar no Asaas, aparece aqui.</div>`}
  </div>`;
  if(typeof nffRenderRail==='function') nffRenderRail();
}

function nffToggle(id){
  const q=_nffFila.find(x=>x.id===id);
  if(!q || !nffPronto(q)) return; // não pronto não entra no lote
  if(_nffSel.has(id)) _nffSel.delete(id); else _nffSel.add(id);
  nffDraw();
}

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
  const nRev=_nffFila.filter(q=>nffProntidao(q)==='revisar').length;
  const nSemId=_nffFila.filter(q=>nffProntidao(q)==='sem_id').length;
  const fila=_nffFila.length;
  const tot=Math.max(nEmit+nProc+nErro,1);
  const mesLabel=agora.toLocaleDateString('pt-BR',{month:'long',year:'numeric'}).toUpperCase();
  const lbl=`font-family:${NFF_C.mono};font-size:9px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;`;
  const cardSt=(borda)=>`background:${NFF_C.card};border:0.5px solid ${borda||'rgba(10,21,48,0.12)'};border-radius:14px;padding:15px 17px;margin-bottom:14px;`;
  const lin=(a,b,cor)=>`<div style="display:flex;justify-content:space-between;font-size:12.5px;margin-top:7px;"><span style="color:rgba(10,21,48,0.6);">${a}</span><b style="font-family:${NFF_C.mono};${cor?`color:${cor};`:''}">${b}</b></div>`;

  const precisa=[];
  if(fila) precisa.push(`<div><b>${fila} recebimento(s)</b> aguardando nota no ESNFS.</div>`);
  if(nRev) precisa.push(`<div><b>${nRev} recebimento(s)</b> com rateio capital/honorário em revisão — sem base para a nota.</div>`);
  if(nSemId) precisa.push(`<div><b>${nSemId} tomador(es)</b> sem CPF/CNPJ — complete no Asaas.</div>`);
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
    <div style="padding:0 4px;font-size:11px;color:rgba(10,21,48,0.5);line-height:1.55;">A emissão é no <b>ESNFS</b> pela extensão do Chrome (<code>extensao/esnfs</code>): copie o lote aqui, rode lá, cole o resultado de volta. O relatório do que foi emitido fica em <b>Financeiro → Faturamento</b>.</div>`;
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

// ══════════════════════════════════════════════════════════════════════════════
// PONTE COM O ESNFS (assets/js/esnfs-ponte.js + extensao/esnfs/)
// ══════════════════════════════════════════════════════════════════════════════
function nffSelecionarProntos(){ _nffFila.filter(nffPronto).forEach(q=>_nffSel.add(q.id)); nffDraw(); }
function nffCopiarLoteSel(){ nffCopiarLote([..._nffSel]); }
// Linha do lote: Nome | CPF | BASE | fila:<id>. O nome vai junto porque o ESNFS pode não
// ter o cadastro; a extensão só o usa nesse caso (ou para completar um abreviado).
async function nffCopiarLote(ids){
  const itens=(ids||[]).map(id=>_nffFila.find(x=>x.id===id)).filter(q=>q&&nffPronto(q))
    .map(q=>({ nome:q.nome||'', doc:nfaDigits(q.cpf_cnpj), valor:nffBase(q).base, ref:'fila:'+q.id }));
  if(!itens.length){ showToast('Nenhum recebimento pronto entre os marcados.','warning'); return; }
  const txt=esnfsMontarLote(itens);
  try{ await navigator.clipboard.writeText(txt); }
  catch(_){ const ta=document.createElement('textarea'); ta.value=txt; ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  const total=itens.reduce((s,i)=>s+i.valor,0);
  showToast(`${itens.length} linha(s) copiada(s) — ${nfaFmtBRL(total)}. Cole no campo CPF da extensão do ESNFS.`,'success');
}

// Importa o relatório da extensão. Preview antes de gravar: nada é marcado sem OK.
function nffImportarResultado(){
  const hoje=new Date(); const iso=hoje.getFullYear()+'-'+String(hoje.getMonth()+1).padStart(2,'0')+'-'+String(hoje.getDate()).padStart(2,'0');
  _nfaModal(`
    <div style="padding:22px 24px 14px;border-bottom:0.5px solid rgba(10,21,48,0.12);">
      <div style="font-family:${NFF_C.mono};font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${NFF_C.goldDark};">Importar resultado do ESNFS</div>
      <h3 style="margin:6px 0 2px;font-size:20px;font-weight:600;color:${NFF_C.ink};">Cole o relatório da extensão</h3>
      <div style="font-size:12.5px;color:rgba(10,21,48,0.6);">Ao terminar o lote a extensão copia o relatório sozinha. Cole aqui inteiro — o painel lê o bloco <code>COBRASQ-RESULTADO</code> (ou a tabela, se for um relatório antigo).</div>
    </div>
    <div style="padding:16px 24px;display:flex;flex-direction:column;gap:10px;">
      <textarea id="nff-imp-txt" rows="9" style="width:100%;box-sizing:border-box;font-family:${NFF_C.mono};font-size:11.5px;padding:10px;border:1px solid var(--border);border-radius:8px;resize:vertical;" placeholder="# Emissão de NFS-e — …"></textarea>
      <label style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:rgba(10,21,48,0.7);">Data de emissão das notas <input id="nff-imp-data" type="date" value="${iso}" style="font-family:${NFF_C.mono};font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;"></label>
      <div id="nff-imp-prev"></div>
    </div>
    <div style="padding:14px 24px;display:flex;gap:10px;justify-content:flex-end;border-top:0.5px solid rgba(10,21,48,0.12);">
      <button class="btn btn-ghost btn-sm" onclick="_nfaCloseModal()">Voltar</button>
      <button class="btn btn-ghost btn-sm" onclick="nffImportarPreview()">Conferir ↓</button>
      <button class="btn btn-primary btn-sm" id="nff-imp-ok" disabled onclick="nffImportarConfirmar()">✓ Marcar como emitidas</button>
    </div>`, { wide:true });
  const ta=document.getElementById('nff-imp-txt'); if(ta) ta.focus();
}
let _nffImpCasado=[];
function nffImportarPreview(){
  const txt=(document.getElementById('nff-imp-txt')||{}).value||'';
  const box=document.getElementById('nff-imp-prev'); const ok=document.getElementById('nff-imp-ok');
  const r=esnfsParseResultado(txt);
  if(!r.itens.length){ box.innerHTML=`<div style="font-size:12.5px;color:${NFF_C.vermelho};">Não encontrei nenhuma nota no texto colado.</div>`; ok.disabled=true; _nffImpCasado=[]; return; }
  // Pendentes: a fila (fila:<id>) e as linhas manuais da tela (manual:<ref>), se houver.
  const pend=_nffFila.map(q=>({ ref:'fila:'+q.id, doc:nfaDigits(q.cpf_cnpj), valor:nffBase(q).base, nome:q.nome||'', fila:q }));
  const manuais=(typeof nfaLinhasManuaisPendentes==='function')?nfaLinhasManuaisPendentes():[];
  _nffImpCasado=esnfsCasarResultado(r.itens, pend.concat(manuais));
  const emit=_nffImpCasado.filter(c=>c.resultado.status==='ok'&&c.pendente);
  const semPar=_nffImpCasado.filter(c=>c.resultado.status==='ok'&&!c.pendente);
  const falhas=_nffImpCasado.filter(c=>c.resultado.status!=='ok');
  const tr=(c,cor,txt)=>`<div style="display:grid;grid-template-columns:1fr 110px 90px 1fr;gap:10px;font-size:12px;padding:6px 0;border-top:0.5px solid rgba(10,21,48,0.07);">
      <span>${escHtml(c.resultado.nome||(c.pendente&&c.pendente.nome)||'—')}<br><span style="font-family:${NFF_C.mono};color:rgba(10,21,48,0.5);">${escHtml(nfaMaskDoc(c.resultado.doc))}</span></span>
      <span style="font-family:${NFF_C.mono};text-align:right;">${nfaFmtBRL(c.resultado.valor)}</span>
      <span style="font-family:${NFF_C.mono};">${escHtml(c.resultado.nota||'—')}</span>
      <span style="color:${cor};">${txt}</span></div>`;
  box.innerHTML=`
    <div style="font-size:12px;color:rgba(10,21,48,0.6);">Lido pelo ${r.fonte==='bloco'?'bloco COBRASQ-RESULTADO':'texto da tabela (relatório sem bloco — casado por CPF + valor)'}: ${r.itens.length} nota(s).</div>
    ${emit.map(c=>tr(c,NFF_C.verde,'✓ emitida → '+(c.como==='ref'?'linha da fila':'casada por CPF + valor'))).join('')}
    ${semPar.map(c=>tr(c,'#7A6428',c.como==='ambiguo'?'emitida, mas há mais de uma linha igual na fila — decida à mão':'emitida, sem linha correspondente na fila — será registrada só no histórico')).join('')}
    ${falhas.map(c=>tr(c,NFF_C.vermelho,'falhou no ESNFS: '+escHtml(c.resultado.obs||'sem motivo')+' — continua pendente')).join('')}`;
  ok.disabled=!(emit.length||semPar.filter(c=>c.como==='sem_par').length);
  ok.textContent=`✓ Marcar ${emit.length+semPar.filter(c=>c.como==='sem_par').length} como emitida(s)`;
}
async function nffImportarConfirmar(){
  const supa=getSupabase(); if(!supa){ showToast('Faça login para importar.','warning'); return; }
  const data=(document.getElementById('nff-imp-data')||{}).value||new Date().toISOString().slice(0,10);
  const alvo=_nffImpCasado.filter(c=>c.resultado.status==='ok'&&(c.pendente||c.como==='sem_par'));
  _nfaCloseModal();
  if(!alvo.length) return;
  let uid=null; try{ const { data:u }=await supa.auth.getUser(); uid=u&&u.user&&u.user.id||null; }catch(_){}
  let ok=0, fail=0;
  for(const c of alvo){
    const r=c.resultado, p=c.pendente, q=p&&p.fila, op=q&&_nffOps[q.asaas_payment_id];
    try{
      const meta={ origem:'esnfs', nf_number:r.nota||null, emitida_em:data, ref:p?p.ref:('esnfs:'+r.doc+':'+r.valor+':'+data),
        fila_id:q?q.id:null, operacao_id:op?op.id:null, asaas_payment_id:q?q.asaas_payment_id:null,
        nf_base_tipo:q?nffBase(q).tipo:null, competencia:data.slice(5,7)+'/'+data.slice(0,4), obs:r.obs||null };
      const { data:nf, error }=await supa.from('nf_avulsa').insert({
        nome:r.nome||(p&&p.nome)||null, doc:nfaMaskDoc(r.doc), doc_digits:r.doc, valor:r.valor,
        descricao:'Honorários de cobrança', nf_status:'emitida', metadata:meta, criada_por:uid,
        asaas_customer_id:q&&q.customer_id||null }).select('id').single();
      if(error) throw error;
      if(q){
        await supa.from('nf_fila_analise').update({ status:'emitida', decidido_em:new Date().toISOString(), decidido_por:uid, nf_avulsa_id:nf.id }).eq('id',q.id).eq('status','pendente');
        _nffFila=_nffFila.filter(x=>x.id!==q.id); _nffSel.delete(q.id);
      }
      if(op){
        await supa.from('fin_operacao').update({ nf_status:'emitida', metadata:Object.assign({}, op.metadata||{}, { nf_origem:'esnfs', nf_number:r.nota||null, nf_base:r.valor, nf_base_tipo:nffBase(q).tipo, nf_avulsa_id:nf.id, nf_emitida_em:data }), atualizada_em:new Date().toISOString() }).eq('id',op.id);
      }
      if(p&&/^manual:/.test(p.ref)&&typeof nfaMarcarManualEmitida==='function') nfaMarcarManualEmitida(p.ref, r.nota, nf.id);
      ok++;
    }catch(e){ fail++; showToast(`Falha ao registrar ${r.nome||r.doc}: ${traduzirErro(e.message||String(e))}`,'danger'); }
  }
  showToast(`${ok} nota(s) registrada(s) como emitida(s) no ESNFS${fail?`, ${fail} falha(s)`:''}.`, fail?'warning':'success');
  nffDraw();
  if(typeof nfaUpdateNavBadge==='function') nfaUpdateNavBadge();
  if(typeof nfaCarregarHistorico==='function') await nfaCarregarHistorico();
}

// ── LEGADO — emitir pelo Asaas (sem botão na tela desde 13/09/2026) ──────────
// Nunca emitiu uma nota em produção (nf_avulsa: 0 'emitida' até 13/09). Fica aqui
// para não perder o caminho caso a integração fiscal do Asaas volte a ser usada.
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

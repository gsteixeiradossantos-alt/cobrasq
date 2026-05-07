// =======================================================================
// DIRECTION B — More internal screens (Processos, Modal Devedor, Financeiro,
// Relatórios, WhatsApp). Reuses ShellB / bT / IB / IconB from direction-b.jsx.
// =======================================================================

// ---------- PROCESSOS ----------
function DirBProcessos() {
  const procs = [
    { num:'0021345-67.2026.8.26.0100', vara:'2ª Vara Cível — SP', devedor:'Construtora Vértice LTDA', valor:'R$ 187.940,50', fase:'Citação',     prox:'12/05', status:'Em andamento' },
    { num:'0098712-44.2025.8.26.0224', vara:'4ª Vara Cível — Guarulhos', devedor:'Camila Ferreira Lima', valor:'R$ 5.120,40',  fase:'Audiência',   prox:'08/05', status:'Audiência marcada' },
    { num:'0007781-19.2025.8.26.0001', vara:'1ª Vara Cível — SP', devedor:'Indústrias Cerro S.A.',    valor:'R$ 412.300,00', fase:'Sentença',    prox:'—',     status:'Aguardando sentença' },
    { num:'0044220-08.2026.8.26.0100', vara:'7ª Vara Cível — SP', devedor:'Bruno Kaminski',           valor:'R$ 8.940,00',   fase:'Distribuição',prox:'21/05', status:'Em andamento' },
    { num:'0011982-33.2024.8.26.0100', vara:'3ª Vara Cível — SP', devedor:'Alvaro Mendes Restaurante',valor:'R$ 3.420,80',   fase:'Recurso',     prox:'18/05', status:'Recurso pendente' },
  ];
  const fases = ['Distribuição', 'Citação', 'Contestação', 'Audiência', 'Sentença', 'Recurso', 'Execução'];
  return (
    <ShellB
      breadcrumb={['Cobranças', 'Processos']}
      activeNav="cobr"
      topActions={
        <>
          <button style={{ padding:'7px 11px', background: bT.surface, color: bT.text2, border:`1px solid ${bT.border2}`, borderRadius:6, fontSize:12.5, fontWeight:500, display:'flex', alignItems:'center', gap:7, cursor:'pointer' }}><IconB d={IB.download} size={13}/> Exportar</button>
          <button style={{ padding:'7px 12px', background: bT.navy, color:'#fff', border:'none', borderRadius:6, fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}><IconB d={IB.plus} size={13}/> Novo processo</button>
        </>
      }
    >
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing:'-.02em' }}>Processos judiciais</div>
          <div style={{ fontSize: 12.5, color: bT.text2, marginTop: 2 }}>78 ativos · <strong style={{ fontFamily: bMono, color: bT.text }}>R$ 1.847.320</strong> em disputa</div>
        </div>
      </div>

      {/* Phase summary */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap: 8, marginBottom: 16 }}>
        {fases.map((f, i) => {
          const counts = [12, 18, 9, 14, 11, 8, 6];
          const active = i === 3;
          return (
            <div key={f} style={{ background: active ? '#EAF0FB' : bT.surface, border:`1px solid ${active ? '#C8D6F0' : bT.border}`, borderRadius:6, padding:'10px 12px', cursor:'pointer' }}>
              <div style={{ fontSize: 11, color: bT.text2, fontWeight: 500, marginBottom: 4 }}>{f}</div>
              <div style={{ fontFamily: bMono, fontSize: 18, fontWeight: 600, color: active ? bT.navy : bT.text }}>{counts[i]}</div>
            </div>
          );
        })}
      </div>

      {/* Filter row */}
      <div style={{ display:'flex', gap: 8, marginBottom: 12, alignItems:'center' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:6, color: bT.text3, fontSize:12.5, flex:1, maxWidth: 320 }}>
          <IconB d={IB.search} size={13}/> Buscar nº processo, vara, devedor…
        </div>
        {['Todas as fases', 'Todas as varas', 'Todos os responsáveis'].map(t => (
          <button key={t} style={{ padding:'7px 11px', background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:6, fontSize:12, color: bT.text2, fontWeight:500, cursor:'pointer' }}>{t} ▾</button>
        ))}
        <div style={{ flex:1 }}></div>
        <span style={{ fontSize:11.5, color: bT.text2 }}>Próx. audiência: <strong style={{ color: bT.amber, fontFamily: bMono }}>08/05 · 14:30</strong></span>
      </div>

      {/* Process cards (more visual than table) */}
      <div style={{ display:'grid', gap: 10 }}>
        {procs.map((p, i) => (
          <div key={i} style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8, padding:'14px 18px', display:'grid', gridTemplateColumns:'auto 1fr auto auto auto', gap: 18, alignItems:'center' }}>
            {/* Process number */}
            <div style={{ borderRight:`1px solid ${bT.border}`, paddingRight: 18 }}>
              <div style={{ fontSize: 10.5, color: bT.text3, fontWeight: 500, letterSpacing:'.04em', textTransform:'uppercase', marginBottom: 3 }}>Nº processo</div>
              <div style={{ fontFamily: bMono, fontSize: 12.5, fontWeight: 600, color: bT.text, letterSpacing:'-.01em' }}>{p.num}</div>
              <div style={{ fontSize: 11.5, color: bT.text2, marginTop: 3 }}>{p.vara}</div>
            </div>
            {/* Devedor */}
            <div>
              <div style={{ fontSize: 10.5, color: bT.text3, fontWeight: 500, letterSpacing:'.04em', textTransform:'uppercase', marginBottom: 3 }}>Devedor</div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: bT.text }}>{p.devedor}</div>
              {/* Phase progress */}
              <div style={{ display:'flex', gap: 3, marginTop: 8, alignItems:'center' }}>
                {fases.map((f, fi) => {
                  const passed = fases.indexOf(p.fase) >= fi;
                  const current = p.fase === f;
                  return (
                    <React.Fragment key={f}>
                      <div title={f} style={{
                        height: current ? 6 : 4, width: current ? 28 : 16,
                        borderRadius: 2,
                        background: passed ? bT.navy : bT.border,
                      }}></div>
                    </React.Fragment>
                  );
                })}
                <span style={{ fontSize: 11, color: bT.text2, marginLeft: 8 }}>Fase atual: <strong style={{ color: bT.navy }}>{p.fase}</strong></span>
              </div>
            </div>
            {/* Valor */}
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize: 10.5, color: bT.text3, fontWeight: 500, letterSpacing:'.04em', textTransform:'uppercase', marginBottom: 3 }}>Valor</div>
              <div style={{ fontFamily: bMono, fontSize: 14, fontWeight: 600, color: bT.text }}>{p.valor}</div>
            </div>
            {/* Próximo */}
            <div style={{ textAlign:'right', minWidth: 80 }}>
              <div style={{ fontSize: 10.5, color: bT.text3, fontWeight: 500, letterSpacing:'.04em', textTransform:'uppercase', marginBottom: 3 }}>Próximo ato</div>
              <div style={{ fontFamily: bMono, fontSize: 13, fontWeight: 600, color: p.prox==='08/05' ? bT.amber : bT.text }}>{p.prox}</div>
            </div>
            <button style={{ width:30, height:30, border:`1px solid ${bT.border}`, background: bT.surface, borderRadius:6, color: bT.text2, cursor:'pointer' }}>›</button>
          </div>
        ))}
      </div>
    </ShellB>
  );
}

// ---------- MODAL DEVEDOR ----------
function DirBModalDevedor() {
  const tabs = ['Resumo', 'Histórico', 'Acordos', 'Documentos', 'Comunicação', 'Auditoria'];
  return (
    <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(11,15,25,0.5)', fontFamily: bUI }}>
      {/* Backdrop with blurred dashboard hint */}
      <div style={{ position:'absolute', inset:0, background: bT.bg, opacity:.4, pointerEvents:'none' }}></div>
      <div style={{ position:'relative', width: 1200, height: 800, background: bT.surface, borderRadius: 12, boxShadow:'0 32px 80px rgba(0,32,96,0.18)', display:'flex', flexDirection:'column', overflow:'hidden', border:`1px solid ${bT.border}` }}>
        {/* Header */}
        <div style={{ padding:'20px 28px 0', borderBottom:`1px solid ${bT.border}` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom: 18 }}>
            <div style={{ display:'flex', gap: 16, alignItems:'flex-start' }}>
              <div style={{ width:56, height:56, borderRadius:10, background:'#EAF0FB', color: bT.navy, display:'grid', placeItems:'center', fontWeight:700, fontSize:18, fontFamily: bUI }}>RA</div>
              <div>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: 4 }}>
                  <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing:'-.02em' }}>Rafael Almeida Souza</h2>
                  <span style={{ fontSize:11, fontFamily: bMono, color: bT.text3, padding:'2px 6px', background: bT.surface2, borderRadius:4 }}>id #2840</span>
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6, background:'#E8F7F0', color: bT.green, padding:'2px 8px', borderRadius: 4, fontSize: 11.5, fontWeight: 600 }}><span style={{ width:5, height:5, borderRadius:'50%', background: bT.green }}></span>Em acordo</span>
                </div>
                <div style={{ display:'flex', gap: 18, fontSize: 12.5, color: bT.text2 }}>
                  <span><span style={{ color: bT.text3 }}>CPF</span> <strong style={{ fontFamily: bMono, color: bT.text }}>124.580.927-43</strong></span>
                  <span><span style={{ color: bT.text3 }}>Tel</span> <strong style={{ fontFamily: bMono, color: bT.text }}>(11) 98472-3091</strong></span>
                  <span><span style={{ color: bT.text3 }}>Cliente desde</span> <strong style={{ color: bT.text }}>jan/2023</strong></span>
                  <span><span style={{ color: bT.text3 }}>Resp.</span> <strong style={{ color: bT.text }}>Mariana S.</strong></span>
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap: 8 }}>
              <button style={{ padding:'7px 11px', background: bT.surface, color: bT.text2, border:`1px solid ${bT.border2}`, borderRadius:6, fontSize:12.5, fontWeight:500, cursor:'pointer' }}>Editar</button>
              <button style={{ padding:'7px 12px', background: bT.green, color:'#fff', border:'none', borderRadius:6, fontSize:12.5, fontWeight:600, cursor:'pointer' }}>Registrar pagamento</button>
              <button style={{ width:32, height:32, border:`1px solid ${bT.border2}`, background: bT.surface, borderRadius:6, color: bT.text2, cursor:'pointer' }}>×</button>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display:'flex', gap: 4 }}>
            {tabs.map((t, i) => (
              <button key={t} style={{
                padding:'10px 14px', background:'none', border:'none',
                fontSize: 13, fontWeight: i===0?600:500,
                color: i===0 ? bT.navy : bT.text2,
                borderBottom: i===0 ? `2px solid ${bT.navy}` : '2px solid transparent',
                marginBottom:-1, cursor:'pointer'
              }}>
                {t} {i===1 && <span style={{ fontSize:10, padding:'1px 5px', background: bT.surface2, color: bT.text2, borderRadius:3, marginLeft:4 }}>24</span>}
                {i===2 && <span style={{ fontSize:10, padding:'1px 5px', background: bT.surface2, color: bT.text2, borderRadius:3, marginLeft:4 }}>2</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 320px', gap: 0, overflow:'hidden' }}>
          {/* Left: resumo + timeline */}
          <div style={{ overflow:'auto', padding: 24 }}>
            {/* Stats row */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap: 10, marginBottom: 24 }}>
              {[
                { l:'Dívida total', v:'R$ 24.380,00', sub:'3 títulos' },
                { l:'Pago até hoje', v:'R$ 8.450,00', sub:'2 parcelas' },
                { l:'Saldo restante', v:'R$ 15.930,00', sub:'8 parcelas', highlight:true },
                { l:'Próximo venc.', v:'12/05', sub:'em 8 dias', amber:true },
              ].map((s, i) => (
                <div key={i} style={{ background: s.highlight ? '#EAF0FB' : bT.surface2, border:`1px solid ${s.highlight ? '#C8D6F0' : bT.border}`, borderRadius:8, padding:'12px 14px' }}>
                  <div style={{ fontSize: 11.5, color: bT.text2, fontWeight: 500, marginBottom: 6 }}>{s.l}</div>
                  <div style={{ fontFamily: bMono, fontSize: 17, fontWeight: 600, color: s.amber ? bT.amber : bT.text, letterSpacing:'-.01em' }}>{s.v}</div>
                  <div style={{ fontSize: 11, color: bT.text3, marginTop: 2 }}>{s.sub}</div>
                </div>
              ))}
            </div>

            {/* Active acordo */}
            <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8, marginBottom: 22 }}>
              <div style={{ padding:'12px 16px', borderBottom:`1px solid ${bT.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>Acordo #A-0184 · Parcelado em 10x</div>
                  <div style={{ fontSize: 11.5, color: bT.text2, marginTop: 1 }}>Firmado em 12/03/2026 · Mariana S.</div>
                </div>
                <a style={{ fontSize: 12, color: bT.navy, fontWeight: 600, cursor:'pointer' }}>Ver acordo →</a>
              </div>
              <div style={{ display:'flex', padding: 12, gap: 4 }}>
                {Array.from({length: 10}, (_, i) => {
                  const paid = i < 2;
                  const next = i === 2;
                  return (
                    <div key={i} style={{
                      flex:1, padding:'8px 4px', textAlign:'center', borderRadius:5,
                      background: paid ? '#E8F7F0' : next ? '#FEF3C7' : bT.surface2,
                      border: `1px solid ${paid ? '#B7E0CB' : next ? '#FCD34D' : bT.border}`
                    }}>
                      <div style={{ fontSize: 9.5, color: paid ? bT.green : next ? bT.amber : bT.text3, fontWeight: 700, letterSpacing:'.06em', marginBottom: 2 }}>{paid?'PAGO':next?'PRÓX.':String(i+1)+'ª'}</div>
                      <div style={{ fontFamily: bMono, fontSize: 11, fontWeight: 600, color: paid ? bT.green : next ? bT.amber : bT.text2 }}>R$ 2.438</div>
                      <div style={{ fontFamily: bMono, fontSize: 9.5, color: bT.text3, marginTop: 2 }}>{['12/03','12/04','12/05','12/06','12/07','12/08','12/09','12/10','12/11','12/12'][i]}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Timeline */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Timeline recente</div>
                <a style={{ fontSize: 12, color: bT.navy, fontWeight: 600 }}>Ver todos os 24 →</a>
              </div>
              <div style={{ position:'relative', paddingLeft: 22 }}>
                <div style={{ position:'absolute', left: 8, top: 8, bottom: 8, width: 1, background: bT.border }}></div>
                {[
                  { dot: bT.green, type:'PAGAMENTO', text:'Parcela 2/10 paga via PIX', who:'Mariana S.', when:'04/04 · 09:42', val:'R$ 2.438,00' },
                  { dot: bT.blue, type:'COMUNICAÇÃO', text:'Confirmação de acordo enviada por WhatsApp', who:'Sistema', when:'12/03 · 14:18' },
                  { dot: bT.navy, type:'ACORDO', text:'Acordo #A-0184 firmado em 10 parcelas de R$ 2.438', who:'Mariana S.', when:'12/03 · 11:30', val:'R$ 24.380,00' },
                  { dot: bT.amber, type:'CONTATO', text:'Ligação atendida — devedor solicitou parcelamento', who:'Mariana S.', when:'10/03 · 16:42' },
                  { dot: bT.text3, type:'NOTIFICAÇÃO', text:'Carta de cobrança enviada (Sedex)', who:'Sistema', when:'05/03 · 10:00' },
                ].map((t, i) => (
                  <div key={i} style={{ position:'relative', paddingBottom: 16 }}>
                    <div style={{ position:'absolute', left: -18, top: 5, width: 10, height: 10, borderRadius:'50%', background: t.dot, border:`2px solid ${bT.surface}`, boxShadow:`0 0 0 1px ${bT.border}` }}></div>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap: 12 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize: 9.5, fontWeight:700, letterSpacing:'.08em', color: t.dot, marginBottom: 3 }}>{t.type}</div>
                        <div style={{ fontSize: 13, color: bT.text, fontWeight: 500 }}>{t.text}</div>
                        <div style={{ fontSize: 11.5, color: bT.text3, marginTop: 2 }}>{t.who} · <span style={{ fontFamily: bMono }}>{t.when}</span></div>
                      </div>
                      {t.val && <span style={{ fontFamily: bMono, fontSize: 12.5, fontWeight: 600, color: bT.text }}>{t.val}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: side panel */}
          <div style={{ borderLeft:`1px solid ${bT.border}`, background: bT.surface2, padding: 20, overflow:'auto' }}>
            {/* Quick actions */}
            <div style={{ fontSize: 11, color: bT.text3, fontWeight: 600, letterSpacing:'.10em', textTransform:'uppercase', marginBottom: 10 }}>Ações rápidas</div>
            <div style={{ display:'grid', gap: 6, marginBottom: 22 }}>
              {[
                { l:'Enviar WhatsApp', icon:IB.wa },
                { l:'Gerar boleto', icon:IB.fin },
                { l:'Registrar contato', icon:IB.clientes },
                { l:'Gerar minuta', icon:IB.docs },
                { l:'Adicionar histórico', icon:IB.cobr },
              ].map(a => (
                <button key={a.l} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 11px', background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:6, fontSize: 12.5, color: bT.text, fontWeight: 500, textAlign:'left', cursor:'pointer' }}>
                  <IconB d={a.icon} size={14}/> {a.l}
                </button>
              ))}
            </div>

            {/* Credor */}
            <div style={{ fontSize: 11, color: bT.text3, fontWeight: 600, letterSpacing:'.10em', textTransform:'uppercase', marginBottom: 10 }}>Credor</div>
            <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 6, padding: 12, marginBottom: 22 }}>
              <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                <div style={{ width:32, height:32, borderRadius:6, background: bT.navy, color: bT.gold, display:'grid', placeItems:'center', fontSize: 11, fontWeight: 800 }}>BA</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Banco Atlas</div>
                  <div style={{ fontSize: 11, color: bT.text3 }}>Cedente · 184 contratos</div>
                </div>
              </div>
            </div>

            {/* Tags */}
            <div style={{ fontSize: 11, color: bT.text3, fontWeight: 600, letterSpacing:'.10em', textTransform:'uppercase', marginBottom: 10 }}>Etiquetas</div>
            <div style={{ display:'flex', gap: 6, flexWrap:'wrap', marginBottom: 22 }}>
              {['Boa-fé','Prioritário','PJ','SP capital'].map(t => (
                <span key={t} style={{ padding:'3px 9px', background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 99, fontSize: 11.5, color: bT.text2, fontWeight: 500 }}>{t}</span>
              ))}
              <button style={{ padding:'3px 9px', background:'transparent', border:`1px dashed ${bT.border2}`, borderRadius: 99, fontSize: 11.5, color: bT.text3, fontWeight: 500, cursor:'pointer' }}>+ Add</button>
            </div>

            {/* Score */}
            <div style={{ fontSize: 11, color: bT.text3, fontWeight: 600, letterSpacing:'.10em', textTransform:'uppercase', marginBottom: 10 }}>Score interno</div>
            <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 6, padding: 14 }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom: 8 }}>
                <span style={{ fontFamily: bMono, fontSize: 28, fontWeight: 600, color: bT.green }}>78</span>
                <span style={{ fontSize: 11, color: bT.text3 }}>/ 100</span>
              </div>
              <div style={{ height: 6, background: bT.border, borderRadius: 3, marginBottom: 8 }}>
                <div style={{ width: '78%', height:'100%', background: `linear-gradient(90deg, ${bT.amber}, ${bT.green})`, borderRadius:3 }}></div>
              </div>
              <div style={{ fontSize: 11, color: bT.text2 }}>Bom pagador. Aderiu ao primeiro acordo proposto.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- FINANCEIRO ----------
function DirBFinanceiro() {
  const lancs = [
    { d:'04/05', desc:'Recebimento — Acordo #A-0184 · Rafael A.', cat:'Recebimento', val:'+R$ 2.438,00', conta:'Itaú PJ', positive:true },
    { d:'04/05', desc:'Pagamento — Conta de luz (CPFL)',         cat:'Operacional', val:'-R$ 487,32',   conta:'Itaú PJ' },
    { d:'03/05', desc:'Recebimento — PIX · Marcelo Tavares',     cat:'Recebimento', val:'+R$ 12.760,00',conta:'Bradesco',  positive:true },
    { d:'03/05', desc:'Folha de pagamento (Maio)',                cat:'RH',          val:'-R$ 28.450,00',conta:'Itaú PJ' },
    { d:'02/05', desc:'Honorários advocatícios — Dr. Pereira',    cat:'Honorários',  val:'-R$ 4.200,00', conta:'Bradesco' },
    { d:'02/05', desc:'Recebimento — Boleto · Eduarda Pinheiro',  cat:'Recebimento', val:'+R$ 1.840,00', conta:'Itaú PJ', positive:true },
    { d:'01/05', desc:'Reembolso — Custas processuais',           cat:'Reembolso',   val:'+R$ 612,40',   conta:'Bradesco', positive:true },
  ];
  return (
    <ShellB
      breadcrumb={['Financeiro', 'Lançamentos']}
      activeNav="fin"
      topActions={
        <>
          <button style={{ padding:'7px 11px', background: bT.surface, color: bT.text2, border:`1px solid ${bT.border2}`, borderRadius:6, fontSize:12.5, fontWeight:500, display:'flex', alignItems:'center', gap:7, cursor:'pointer' }}>Maio 2026 ▾</button>
          <button style={{ padding:'7px 12px', background: bT.navy, color:'#fff', border:'none', borderRadius:6, fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}><IconB d={IB.plus} size={13}/> Novo lançamento</button>
        </>
      }
    >
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing:'-.02em' }}>Financeiro</div>
          <div style={{ fontSize: 12.5, color: bT.text2, marginTop: 2 }}>Maio 2026 · 14 lançamentos</div>
        </div>
      </div>

      {/* Account cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap: 12, marginBottom: 18 }}>
        {[
          { bank:'Itaú PJ',   acc:'1234 / 56789-0',  val:'R$ 142.380,42', delta:'+R$ 12.480 hoje', color:'#E0731D' },
          { bank:'Bradesco',  acc:'4321 / 09876-1',  val:'R$ 84.120,00',  delta:'−R$ 4.200 hoje',  color:'#CC092F' },
          { bank:'Caixa Tab.',acc:'1840 / 00012-3',  val:'R$ 18.460,80',  delta:'sem movimentação',color:'#0070AF', muted:true },
        ].map((c, i) => (
          <div key={i} style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:8, padding:'16px 18px', display:'flex', alignItems:'center', gap: 14 }}>
            <div style={{ width:40, height:40, borderRadius:8, background: c.color, color:'#fff', display:'grid', placeItems:'center', fontWeight:700, fontSize:13 }}>{c.bank.slice(0,2).toUpperCase()}</div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{c.bank}</div>
              <div style={{ fontSize: 11, color: bT.text3, fontFamily: bMono }}>{c.acc}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontFamily: bMono, fontSize: 16, fontWeight: 600 }}>{c.val}</div>
              <div style={{ fontSize: 11, color: c.muted ? bT.text3 : bT.text2, marginTop:2 }}>{c.delta}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Summary row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap: 12, marginBottom: 18 }}>
        {[
          { l:'Entradas (mai)',   v:'+R$ 612.480',  c: bT.green },
          { l:'Saídas (mai)',     v:'−R$ 187.420',  c: bT.red },
          { l:'Saldo do mês',     v:'R$ 425.060',   c: bT.text },
          { l:'A receber (30d)',  v:'R$ 247.180',   c: bT.amber },
        ].map((s, i) => (
          <div key={i} style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:8, padding:'12px 14px' }}>
            <div style={{ fontSize: 11.5, color: bT.text2, fontWeight: 500, marginBottom: 4 }}>{s.l}</div>
            <div style={{ fontFamily: bMono, fontSize: 18, fontWeight: 600, color: s.c, letterSpacing:'-.01em' }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Lancamentos table */}
      <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'14px 18px', borderBottom:`1px solid ${bT.border}` }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Lançamentos recentes</div>
          <div style={{ display:'flex', gap: 6 }}>
            {['Tudo','Entradas','Saídas','Honorários','Operacional'].map((t,i) => (
              <button key={t} style={{ padding:'4px 10px', background: i===0?bT.surface2:'transparent', border:'none', borderRadius:4, fontSize:11.5, fontWeight: i===0?600:500, color: i===0?bT.text:bT.text2, cursor:'pointer' }}>{t}</button>
            ))}
          </div>
        </div>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12.5 }}>
          <tbody>
            {lancs.map((l, i) => (
              <tr key={i} style={{ borderTop: i>0 ? `1px solid ${bT.border}` : 'none' }}>
                <td style={{ padding:'10px 18px', fontFamily: bMono, fontSize:11.5, color: bT.text3, width: 60 }}>{l.d}</td>
                <td style={{ padding:'10px 14px' }}>
                  <div style={{ fontWeight:500, color: bT.text }}>{l.desc}</div>
                </td>
                <td style={{ padding:'10px 14px', width:140 }}>
                  <span style={{ fontSize: 11, padding:'2px 8px', background: bT.surface2, color: bT.text2, borderRadius: 4, fontWeight:500 }}>{l.cat}</span>
                </td>
                <td style={{ padding:'10px 14px', color: bT.text2, fontSize:11.5, width: 100 }}>{l.conta}</td>
                <td style={{ padding:'10px 18px', textAlign:'right', fontFamily: bMono, fontWeight: 600, color: l.positive ? bT.green : bT.text, width: 140 }}>{l.val}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ShellB>
  );
}

// ---------- RELATÓRIOS ----------
function DirBRelatorios() {
  return (
    <ShellB
      breadcrumb={['Relatórios', 'Performance']}
      activeNav="relat"
      topActions={
        <>
          <button style={{ padding:'7px 11px', background: bT.surface, color: bT.text2, border:`1px solid ${bT.border2}`, borderRadius:6, fontSize:12.5, fontWeight:500, display:'flex', alignItems:'center', gap:7, cursor:'pointer' }}>Últimos 6 meses ▾</button>
          <button style={{ padding:'7px 12px', background: bT.navy, color:'#fff', border:'none', borderRadius:6, fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}><IconB d={IB.download} size={13}/> Exportar PDF</button>
        </>
      }
    >
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, letterSpacing:'-.02em' }}>Performance da equipe</div>
          <div style={{ fontSize: 12.5, color: bT.text2, marginTop: 2 }}>Indicadores de cobrança · Nov/2025 → Mai/2026</div>
        </div>
        <div style={{ display:'flex', gap: 6 }}>
          {['Performance', 'Por credor', 'Por responsável', 'Aging'].map((t,i) => (
            <button key={t} style={{ padding:'6px 12px', background: i===0?bT.navy:bT.surface, color: i===0?'#fff':bT.text2, border:`1px solid ${i===0?bT.navy:bT.border}`, borderRadius:6, fontSize:12, fontWeight:500, cursor:'pointer' }}>{t}</button>
          ))}
        </div>
      </div>

      {/* Big chart card */}
      <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:8, padding: 22, marginBottom: 14 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Taxa de recuperação</div>
            <div style={{ fontSize: 12, color: bT.text2, marginTop: 1 }}>% do valor da carteira recuperado por mês</div>
          </div>
          <div style={{ display:'flex', gap: 12, alignItems:'center', fontSize: 11.5, color: bT.text2 }}>
            <span style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:14, height:2, background: bT.navy }}></span> Taxa atual</span>
            <span style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:14, height:2, background: bT.text3, borderTop:`1px dashed ${bT.text3}` }}></span> Meta (8%)</span>
            <span style={{ display:'flex', alignItems:'center', gap:6 }}><span style={{ width:14, height:2, background: bT.gold }}></span> Mercado</span>
          </div>
        </div>
        {/* Line chart */}
        <svg width="100%" height={240} viewBox="0 0 800 240" preserveAspectRatio="none" style={{ display:'block' }}>
          {/* grid */}
          {[0,1,2,3,4].map(i => <line key={i} x1="40" x2="800" y1={20+i*48} y2={20+i*48} stroke={bT.border} strokeWidth="1"/>)}
          {[0,1,2,3,4].map(i => <text key={'l'+i} x="0" y={24+i*48} fontSize="10" fill={bT.text3} fontFamily="JetBrains Mono">{12-i*3}%</text>)}
          {/* meta */}
          <line x1="40" x2="800" y1="84" y2="84" stroke={bT.text3} strokeWidth="1.2" strokeDasharray="4 4"/>
          {/* Mercado area */}
          <path d="M40,140 L150,138 L260,142 L370,135 L480,138 L590,134 L700,130 L800,128 L800,212 L40,212 Z" fill={bT.gold} opacity=".15"/>
          <path d="M40,140 L150,138 L260,142 L370,135 L480,138 L590,134 L700,130 L800,128" fill="none" stroke={bT.gold} strokeWidth="1.6"/>
          {/* Atual */}
          <path d="M40,116 L150,108 L260,98 L370,82 L480,72 L590,58 L700,44 L800,38 L800,212 L40,212 Z" fill={bT.navy} opacity=".10"/>
          <path d="M40,116 L150,108 L260,98 L370,82 L480,72 L590,58 L700,44 L800,38" fill="none" stroke={bT.navy} strokeWidth="2"/>
          {[40,150,260,370,480,590,700,800].map((x,i) => (
            <circle key={i} cx={x} cy={[116,108,98,82,72,58,44,38][i]} r="3.5" fill={bT.navy}/>
          ))}
          {/* x labels */}
          {['NOV','DEZ','JAN','FEV','MAR','ABR','MAI','—'].map((m,i) => (
            <text key={m+i} x={[40,150,260,370,480,590,700,800][i]} y="232" fontSize="10" fill={bT.text3} fontFamily="JetBrains Mono" textAnchor="middle">{m}</text>
          ))}
        </svg>
      </div>

      {/* Lower split */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 14 }}>
        {/* By responsible */}
        <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8, padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Recuperação por responsável</div>
          {[
            { who:'Mariana S.',  recup:'R$ 218.420', taxa: 84, deals: 42 },
            { who:'André L.',    recup:'R$ 184.190', taxa: 71, deals: 38 },
            { who:'Juliana P.',  recup:'R$ 142.870', taxa: 68, deals: 31 },
            { who:'Carlos M.',   recup:'R$ 67.000',  taxa: 41, deals: 12 },
          ].map((r, i) => (
            <div key={i} style={{ display:'grid', gridTemplateColumns:'auto 1fr auto auto', gap: 14, alignItems:'center', padding:'10px 0', borderTop: i>0 ? `1px solid ${bT.border}` : 'none' }}>
              <div style={{ width:30, height:30, borderRadius:'50%', background: bT.navy, color:'#fff', display:'grid', placeItems:'center', fontSize:11, fontWeight:700 }}>{r.who.split(' ').map(s=>s[0]).join('')}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.who}</div>
                <div style={{ height: 5, background: bT.border, borderRadius: 3, marginTop: 5, width: 200 }}>
                  <div style={{ width: r.taxa+'%', height:'100%', background: r.taxa > 70 ? bT.green : r.taxa > 50 ? bT.amber : bT.red, borderRadius:3 }}></div>
                </div>
              </div>
              <div style={{ textAlign:'right', minWidth:80 }}>
                <div style={{ fontFamily: bMono, fontSize: 12.5, fontWeight:600 }}>{r.recup}</div>
                <div style={{ fontSize: 11, color: bT.text3 }}>{r.deals} acordos</div>
              </div>
              <div style={{ fontFamily: bMono, fontSize: 13, fontWeight:600, color: r.taxa>70?bT.green:r.taxa>50?bT.amber:bT.red, minWidth: 36, textAlign:'right' }}>{r.taxa}%</div>
            </div>
          ))}
        </div>

        {/* Aging */}
        <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8, padding: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>Aging da carteira</div>
          {[
            { range:'0–30 dias',   val:'R$ 1.240.000', pct: 14, color: bT.green },
            { range:'31–60 dias',  val:'R$ 2.180.000', pct: 25, color: bT.blue },
            { range:'61–90 dias',  val:'R$ 1.860.000', pct: 22, color: bT.amber },
            { range:'91–180 dias', val:'R$ 1.640.000', pct: 19, color: '#D97706' },
            { range:'181–360 dias',val:'R$ 1.020.000', pct: 12, color: bT.red },
            { range:'> 360 dias',  val:'R$ 480.000',   pct:  8, color: '#7C2D12' },
          ].map((a,i) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: bT.text2 }}>{a.range}</span>
                <span><span style={{ fontFamily: bMono, fontWeight: 600 }}>{a.val}</span> <span style={{ color: bT.text3, fontFamily: bMono }}>· {a.pct}%</span></span>
              </div>
              <div style={{ height: 6, background: bT.border, borderRadius: 3 }}>
                <div style={{ width: (a.pct*4)+'%', height:'100%', background: a.color, borderRadius:3 }}></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ShellB>
  );
}

// ---------- WHATSAPP ----------
function DirBWhatsApp() {
  const conversas = [
    { name:'Rafael Almeida Souza', last:'Combinado, vou pagar amanhã.', when:'09:42', unread:0,  active:true },
    { name:'Camila Ferreira Lima', last:'Posso parcelar em 6x?',         when:'09:18', unread:2 },
    { name:'Bruno Kaminski',       last:'Pode mandar o boleto?',         when:'08:55', unread:1 },
    { name:'Eduarda Pinheiro',     last:'Ok, recebido. Obrigada.',       when:'ontem', unread:0 },
    { name:'Marcelo Tavares',      last:'Pagamento confirmado via PIX',  when:'ontem', unread:0 },
    { name:'Construtora Vértice',  last:'Vamos analisar a proposta.',    when:'2d',    unread:0 },
    { name:'Alvaro Mendes Rest.',  last:'Bom dia, tudo bem?',            when:'2d',    unread:0 },
    { name:'Indústrias Cerro',     last:'Reunião agendada p/ sex.',      when:'3d',    unread:0 },
  ];
  const msgs = [
    { who:'them', text:'Boa tarde! Recebi a cobrança aqui.', when:'09:21' },
    { who:'me',   text:'Boa tarde, Rafael. Tudo bem? Sou a Mariana, da COBRASQ. Posso te ajudar?', when:'09:22' },
    { who:'them', text:'Vi que tem uma proposta de parcelamento em 10x. Tem como ajustar a 1ª parcela pra dia 15?', when:'09:30' },
    { who:'me',   text:'Sim, sem problema. Vou ajustar aqui no sistema e te envio o acordo atualizado.', when:'09:32' },
    { who:'me',   text:'Pronto! Dá uma olhada no acordo atualizado: parcela 1 em 15/05.', when:'09:35', kind:'doc', docName:'Acordo_A-0184_v2.pdf' },
    { who:'them', text:'Combinado, vou pagar amanhã.', when:'09:42' },
  ];
  return (
    <ShellB
      breadcrumb={['Comunicação', 'WhatsApp']}
      activeNav="wa"
      topActions={
        <>
          <span style={{ display:'flex', alignItems:'center', gap:7, fontSize: 12, color: bT.text2 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background: bT.green }}></span>
            WhatsApp Business · <strong style={{ color: bT.text }}>+55 (11) 4002-8922</strong>
          </span>
          <button style={{ padding:'7px 12px', background: bT.navy, color:'#fff', border:'none', borderRadius:6, fontSize:12.5, fontWeight:600, display:'flex', alignItems:'center', gap:6, cursor:'pointer' }}><IconB d={IB.plus} size={13}/> Nova conversa</button>
        </>
      }
    >
      {/* Three-column layout: list | chat | context */}
      <div style={{ display:'grid', gridTemplateColumns:'280px 1fr 280px', gap: 0, height: 'calc(100vh - 160px)', minHeight: 600, background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 8, overflow:'hidden' }}>
        {/* Conversation list */}
        <div style={{ borderRight:`1px solid ${bT.border}`, display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'12px', borderBottom:`1px solid ${bT.border}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', background: bT.surface2, borderRadius:6, color: bT.text3, fontSize: 12.5 }}>
              <IconB d={IB.search} size={13}/> Buscar conversa…
            </div>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            {conversas.map((c, i) => (
              <div key={i} style={{
                padding:'12px 14px', display:'flex', gap: 10, alignItems:'flex-start',
                background: c.active ? '#EAF0FB' : 'transparent',
                borderLeft: c.active ? `3px solid ${bT.navy}` : '3px solid transparent',
                paddingLeft: c.active ? 11 : 14,
                borderBottom:`1px solid ${bT.border}`, cursor:'pointer'
              }}>
                <div style={{ width:36, height:36, borderRadius:'50%', background: c.active ? bT.navy : bT.surface2, color: c.active?'#fff':bT.text2, display:'grid', placeItems:'center', fontSize:11.5, fontWeight:700 }}>{c.name.split(' ').slice(0,2).map(s=>s[0]).join('')}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: c.unread>0?700:600, color: bT.text }}>{c.name}</span>
                    <span style={{ fontSize: 10.5, color: bT.text3, fontFamily: bMono }}>{c.when}</span>
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: c.unread>0?bT.text:bT.text2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', flex:1 }}>{c.last}</span>
                    {c.unread>0 && <span style={{ background: bT.green, color:'#fff', borderRadius:'50%', minWidth:18, height:18, fontSize:10, fontWeight:700, display:'grid', placeItems:'center', padding:'0 5px' }}>{c.unread}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Chat */}
        <div style={{ display:'flex', flexDirection:'column', background: '#F5F0E8' /* whatsapp paper */ }}>
          {/* chat header */}
          <div style={{ padding:'12px 18px', background: bT.surface, borderBottom:`1px solid ${bT.border}`, display:'flex', alignItems:'center', gap: 12 }}>
            <div style={{ width:36, height:36, borderRadius:'50%', background: bT.navy, color:'#fff', display:'grid', placeItems:'center', fontSize:11.5, fontWeight:700 }}>RA</div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>Rafael Almeida Souza</div>
              <div style={{ fontSize: 11.5, color: bT.text3 }}>+55 11 98472-3091 · online agora</div>
            </div>
            <div style={{ display:'flex', gap: 6 }}>
              <button style={{ width:30, height:30, border:`1px solid ${bT.border}`, background: bT.surface, borderRadius:6, color: bT.text2, cursor:'pointer' }}>📞</button>
              <button style={{ width:30, height:30, border:`1px solid ${bT.border}`, background: bT.surface, borderRadius:6, color: bT.text2, cursor:'pointer' }}><IconB d={IB.more} size={14}/></button>
            </div>
          </div>
          {/* messages */}
          <div style={{ flex:1, overflow:'auto', padding:'18px 24px', display:'flex', flexDirection:'column', gap: 8 }}>
            <div style={{ alignSelf:'center', fontSize: 11, color: bT.text3, padding:'3px 10px', background:'rgba(255,255,255,.6)', borderRadius: 99, fontWeight: 500, fontFamily: bMono }}>Hoje</div>
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.who==='me'?'flex-end':'flex-start', maxWidth: '70%' }}>
                <div style={{
                  background: m.who==='me' ? '#D9F4D6' : '#FFFFFF',
                  padding: m.kind==='doc' ? '10px 12px' : '8px 12px',
                  borderRadius: m.who==='me' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  fontSize: 13, color: bT.text, boxShadow:'0 1px 1px rgba(0,0,0,.05)',
                  lineHeight: 1.45,
                }}>
                  {m.kind==='doc' && (
                    <div style={{ display:'flex', alignItems:'center', gap:10, padding:8, background:'rgba(0,0,0,.04)', borderRadius:6, marginBottom:6 }}>
                      <div style={{ width:32, height:32, borderRadius:6, background: bT.red, color:'#fff', display:'grid', placeItems:'center', fontSize:10, fontWeight:700 }}>PDF</div>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{m.docName}</div>
                        <div style={{ fontSize: 10.5, color: bT.text3, fontFamily: bMono }}>180 KB</div>
                      </div>
                    </div>
                  )}
                  {m.text}
                  <div style={{ fontSize: 9.5, color: bT.text3, textAlign:'right', marginTop: 4, fontFamily: bMono }}>{m.when} {m.who==='me' && '✓✓'}</div>
                </div>
              </div>
            ))}
          </div>
          {/* composer */}
          <div style={{ padding: 12, background: bT.surface, borderTop:`1px solid ${bT.border}` }}>
            {/* templates */}
            <div style={{ display:'flex', gap: 6, marginBottom: 10, flexWrap:'wrap' }}>
              {['Lembrete de pagamento','Confirmação de acordo','Boleto','Solicitar contato'].map(t => (
                <button key={t} style={{ padding:'4px 10px', background: bT.surface2, border:`1px solid ${bT.border}`, borderRadius: 99, fontSize: 11, color: bT.text2, fontWeight: 500, cursor:'pointer' }}>⚡ {t}</button>
              ))}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background: bT.bg, border:`1px solid ${bT.border}`, borderRadius: 22 }}>
              <button style={{ width:24, height:24, border:'none', background:'transparent', color: bT.text3, cursor:'pointer', fontSize:18 }}>📎</button>
              <input placeholder="Mensagem para Rafael…" style={{ flex:1, border:'none', background:'transparent', outline:'none', fontSize: 13, fontFamily: bUI, color: bT.text }}/>
              <button style={{ width:32, height:32, borderRadius:'50%', background: bT.green, color:'#fff', border:'none', display:'grid', placeItems:'center', cursor:'pointer' }}><IconB d={IB.arrow} size={14}/></button>
            </div>
          </div>
        </div>

        {/* Context panel */}
        <div style={{ borderLeft:`1px solid ${bT.border}`, background: bT.surface2, padding: 18, overflow:'auto' }}>
          <div style={{ textAlign:'center', marginBottom: 18 }}>
            <div style={{ width:60, height:60, borderRadius:'50%', background: bT.navy, color:'#fff', display:'grid', placeItems:'center', fontSize:18, fontWeight:700, margin:'0 auto 10px' }}>RA</div>
            <div style={{ fontSize: 14.5, fontWeight: 600 }}>Rafael Almeida Souza</div>
            <div style={{ fontSize: 11.5, color: bT.text3, fontFamily: bMono }}>CPF 124.580.927-43</div>
          </div>

          <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 6, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: bT.text2, fontWeight: 500, marginBottom: 6 }}>Status</div>
            <div style={{ display:'inline-flex', alignItems:'center', gap:6, background:'#E8F7F0', color: bT.green, padding:'2px 8px', borderRadius: 4, fontSize: 11.5, fontWeight: 600 }}><span style={{ width:5, height:5, borderRadius:'50%', background: bT.green }}></span>Em acordo</div>
          </div>

          <div style={{ background: bT.surface, border:`1px solid ${bT.border}`, borderRadius: 6, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: bT.text2, fontWeight: 500, marginBottom: 8 }}>Saldo devedor</div>
            <div style={{ fontFamily: bMono, fontSize: 18, fontWeight: 600 }}>R$ 15.930,00</div>
            <div style={{ fontSize: 11, color: bT.text3, marginTop: 2 }}>Próx. 12/05 · R$ 2.438,00</div>
          </div>

          <div style={{ fontSize: 11, color: bT.text3, fontWeight: 600, letterSpacing:'.10em', textTransform:'uppercase', marginBottom: 8 }}>Ações</div>
          <div style={{ display:'grid', gap: 6 }}>
            {['Ver ficha completa','Enviar boleto','Registrar pagamento','Gerar minuta'].map(a => (
              <button key={a} style={{ padding:'8px 11px', background: bT.surface, border:`1px solid ${bT.border}`, borderRadius:6, fontSize: 12.5, color: bT.text, fontWeight: 500, textAlign:'left', cursor:'pointer' }}>{a}</button>
            ))}
          </div>
        </div>
      </div>
    </ShellB>
  );
}

window.DirBProcessos = DirBProcessos;
window.DirBModalDevedor = DirBModalDevedor;
window.DirBFinanceiro = DirBFinanceiro;
window.DirBRelatorios = DirBRelatorios;
window.DirBWhatsApp = DirBWhatsApp;

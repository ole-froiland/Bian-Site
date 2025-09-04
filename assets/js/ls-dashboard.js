(() => {
  const section = document.getElementById('lightspeed-top');
  if (!section) return;
  const fetchBtn = section.querySelector('[data-ls="fetch"]');
  const outEl = section.querySelector('[data-ls="out"]');
  const cfgBtn = section.querySelector('[data-ls="cfg"]');
  const cfgPanel = section.querySelector('[data-ls="cfgpanel"]');
  const endpointInput = section.querySelector('[data-ls="endpoint"]');
  const operatorInput = section.querySelector('[data-ls="operator"]');
  const saveCfgBtn = section.querySelector('[data-ls="savecfg"]');
  const closeCfgBtn = section.querySelector('[data-ls="closecfg"]');

  const endpointCandidates = [
    '/.netlify/functions/lightspeed',
    '/api/lightspeed',
    '/functions/lightspeed'
  ];

  function normalizeDateString(s){ return /^\d{4}-\d{2}-\d{2}$/.test(String(s||'')) ? s : ''; }

  async function resolveEndpoint() {
    for (const base of endpointCandidates) {
      try {
        const r = await fetch(`${base}?ping=1`, { method: 'GET' });
        if (r.ok) return base;
      } catch (_) {}
    }
    return endpointCandidates[0];
  }

  function setBusy(isBusy, msg){
    fetchBtn.disabled = isBusy;
    if (msg !== undefined) outEl.textContent = msg;
  }

  // Config panel behavior
  function loadCfg(){
    const ep = localStorage.getItem('lightspeed.endpoint') || '';
    const op = localStorage.getItem('lightspeed.operator') || '';
    if(endpointInput) endpointInput.value = ep;
    if(operatorInput) operatorInput.value = op;
  }
  function saveCfg(){
    const ep = (endpointInput?.value || '').trim();
    const op = (operatorInput?.value || '').trim();
    if(ep) localStorage.setItem('lightspeed.endpoint', ep); else localStorage.removeItem('lightspeed.endpoint');
    if(op) localStorage.setItem('lightspeed.operator', op); else localStorage.removeItem('lightspeed.operator');
  }
  cfgBtn?.addEventListener('click', ()=>{ loadCfg(); cfgPanel.hidden = !cfgPanel.hidden; });
  closeCfgBtn?.addEventListener('click', ()=>{ cfgPanel.hidden = true; });
  saveCfgBtn?.addEventListener('click', ()=>{ saveCfg(); cfgPanel.hidden = true; });

  async function loadTop(){
    let { start, end } = (window.ttDateRange || {});
    const from = normalizeDateString(start);
    const to   = normalizeDateString(end);
    if(!from || !to){
      outEl.textContent = 'Velg Start og Slutt dato med månedvelgeren over.';
      return;
    }
    setBusy(true, 'Henter topp-produkter …');
    try{
      const base = await resolveEndpoint();
      const u = new URL(base, window.location.origin);
      u.searchParams.set('from', from);
      u.searchParams.set('to', to);
      u.searchParams.set('limit', '3');
      u.searchParams.set('metric', 'revenue');
      const epOverride = localStorage.getItem('lightspeed.endpoint');
      const opOverride = localStorage.getItem('lightspeed.operator');
      if(epOverride) u.searchParams.set('endpoint', epOverride);
      if(opOverride) u.searchParams.set('operator', opOverride);

      const res = await fetch(u, { headers:{ 'accept':'application/json' } });
      const text = await res.text();
      let data = {};
      try{ data = JSON.parse(text); } catch {}
      if(!res.ok){
        console.error('Lightspeed API error', res.status, data || text);
        const msg = data?.message || data?.error || text || 'Ukjent feil';
        const extra = data?.triedEndpoints ? `\nPrøvde endepunkter: ${data.triedEndpoints.join(', ')}` : '';
        outEl.textContent = `Feil (HTTP ${res.status}) — ${msg}${extra}`;
        return;
      }
      const top = Array.isArray(data.top) ? data.top : [];
      if(!top.length){
        outEl.textContent = 'Ingen salg funnet for valgt periode.';
        return;
      }
      const formatMoney = new Intl.NumberFormat('nb-NO', { style:'currency', currency:'NOK', maximumFractionDigits:0 });
      const rows = top.map((t,i)=>{
        const rank = String(i+1).padStart(2,'0');
        const name = String(t.name || 'Ukjent');
        const qty = Number(t.qty||0);
        const rev = Number(t.revenue||0);
        return `<div style="display:grid;grid-template-columns:32px 1fr auto auto;gap:10px;padding:6px 0;border-bottom:1px dashed rgba(0,0,0,.08)">
          <strong>#${rank}</strong>
          <span>${name}</span>
          <span style="opacity:.8">x ${qty}</span>
          <span style="font-weight:700">${formatMoney.format(rev)}</span>
        </div>`;
      }).join('');
      outEl.innerHTML = rows;
    }catch(e){
      console.error(e);
      outEl.textContent = 'Kunne ikke hente data (nettverksfeil). Sjekk Console.';
    }finally{
      setBusy(false);
    }
  }

  fetchBtn.addEventListener('click', loadTop);
})();

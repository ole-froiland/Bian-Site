(() => {
  const section = document.getElementById('tripletex-sales');
  const startEl = document.getElementById('start-date');
  const endEl   = document.getElementById('end-date');
  const fetchBtn = section.querySelector('[data-tt="fetch"]');
  const csvBtn   = section.querySelector('[data-tt="csv"]');
  const outEl    = section.querySelector('[data-tt="out"]') || section.querySelector('p[data-tt="out"]');
  const table    = section.querySelector('table');
  const tbody    = table ? table.querySelector('tbody') : null;
  const ACCOUNT_ID_3003 = 289896744;

  if (!startEl || !endEl || !fetchBtn || !csvBtn || !outEl || !tbody) {
    console.warn('Tripletex-dashboard: Mangler forventede DOM-elementer.');
    return;
  }

  // ---------- helpers ----------
  const nbMoney = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function normalizeDateString(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }

  // ---------- state ----------
  let lastData = { from: null, to: null, postings: [] };

  function onDateChange(){
    const ok = !!(startEl.value && endEl.value);
    fetchBtn.disabled = !ok;
    csvBtn.disabled = !ok;
    if(ok) loadData();
  }

  startEl.addEventListener('change', onDateChange);
  endEl.addEventListener('change', onDateChange);

  outEl.textContent = '–';
  fetchBtn.disabled = true;
  csvBtn.disabled = true;

  function setBusy(isBusy, msg) {
    fetchBtn.disabled = isBusy;
    csvBtn.disabled = isBusy || !lastData.postings.length;
    if (msg !== undefined) outEl.textContent = msg;
  }

  // Prøv flere mulige paths, returner første som svarer OK på ping
  const endpointCandidates = [
    '/.netlify/functions/tripletex',
    '/api/tripletex',
    '/functions/tripletex'
  ];

  async function resolveEndpoint() {
    for (const base of endpointCandidates) {
      try {
        const r = await fetch(`${base}?ping=1`, { method: 'GET' });
        if (r.ok) return base;
      } catch (_) {}
    }
    // Ingen ping funka – bare prøv første og la feil boble opp
    return endpointCandidates[0];
  }

  async function loadData(evt){
    const useDemo = !!(evt && evt.altKey);
    let from = normalizeDateString(startEl.value);
    let to   = normalizeDateString(endEl.value);
    if(!from || !to){
      outEl.textContent = 'Velg Start og Slutt dato';
      return;
    }
    if(from > to) [from, to] = [to, from];

    setBusy(true, useDemo ? 'Viser demodata …' : 'Henter …');
    try{
      const base = await resolveEndpoint();
      const url  = new URL(base, window.location.origin);
      if(useDemo) url.searchParams.set('demo','1');
      url.searchParams.set('from', from);
      url.searchParams.set('to',   to);

      const res = await fetch(url, { headers:{ 'accept':'application/json' } });
      const text = await res.text();
      let data = {};
      try{ data = JSON.parse(text); } catch {}

      if(!res.ok){
        console.error('Tripletex API error', res.status, data || text);
        const msg = data?.message || data?.error || text || 'Ukjent feil';
        outEl.textContent = `Feil (HTTP ${res.status}) — ${msg}`;
        lastData = { from:null, to:null, postings:[] };
        return;
      }

      // render
      const raw = Array.isArray(data.postings)? data.postings : [];
      const postings = raw.filter(p => (p.account?.id ?? p.accountId ?? null) === ACCOUNT_ID_3003);
      tbody.innerHTML = '';
      let sum = typeof data.totalBeerSales==='number' ? data.totalBeerSales
                : postings.reduce((a,p)=>a+Math.abs(Number(p.amount||0)),0);
      for(const p of postings){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${p.id ?? ''}</td>
          <td>${p.date ?? ''}</td>
          <td style="text-align:right">${nbMoney.format(Number(p.amount||0))}</td>
        `;
        tbody.appendChild(tr);
      }
      lastData = { from, to, postings };
      const count = typeof data.count==='number' ? data.count : postings.length;
      outEl.textContent = `${count} transaksjoner — Sum: ${nbMoney.format(sum)} NOK${useDemo?' (demo)':''}`;
    } catch (e){
      console.error(e);
      outEl.textContent = 'Kunne ikke hente data (nettverksfeil). Sjekk Console.';
      lastData = { from:null, to:null, postings:[] };
    } finally {
      setBusy(false);
    }
  }

  function toCSV() {
    const rows = [['ID','Dato','Beløp']];
    for (const p of lastData.postings) {
      rows.push([
        String(p.id ?? ''),
        String(p.date ?? ''),
        nbMoney.format(Number(p.amount || 0)).replace(/\u00A0/g, ' ')
      ]);
    }
    const csv = rows.map(r => r.map(s => {
      s = String(s ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');

    const fromTag = (startEl.value || '').replaceAll('-', '');
    const toTag   = (endEl.value   || '').replaceAll('-', '');
    const filename = `tripletex_salg_${fromTag}_${toTag}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  fetchBtn.addEventListener('click', loadData);
  csvBtn.addEventListener('click', toCSV);
})();

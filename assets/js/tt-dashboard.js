(() => {
  const section = document.querySelector('[data-tt-section="tripletex"]') || document;
  const startEl = section.querySelector('#start-date') || section.querySelector('input[name="start"]');
  const endEl   = section.querySelector('#end-date')   || section.querySelector('input[name="end"]');
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
  const toYMD = (y, m, d) =>
    `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  // Godta "DD.MM.YYYY", "YYYY-MM-DD" eller Date-parsbare ting.
  function normalizeDateString(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m1) return toYMD(m1[1], m1[2], m1[3]);
    const m2 = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m2) return toYMD(m2[3], m2[2], m2[1]);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
    return null;
  }

  const fmtDate = (d) => toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
  const nbMoney = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- state ----------
  let lastData = { from: null, to: null, postings: [] };

  // Defaults (visuelt kan feltene være DD.MM)
  const now = new Date();
  const ytdStart = new Date(now.getFullYear(), 0, 1);
  if (!startEl.value) startEl.value = `01.01.${now.getFullYear()}`;
  if (!endEl.value)   endEl.value   = `${String(now.getDate()).padStart(2,'0')}.${String(now.getMonth()+1).padStart(2,'0')}.${now.getFullYear()}`;
  outEl.textContent = '–';
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

  function demoData(from, to) {
    // Generer 8 demoposter med beløp +- for å vise at UI virker.
    const base = new Date(from);
    const items = Array.from({length: 8}).map((_, i) => {
      const d = new Date(base); d.setDate(d.getDate() + i*3);
      const dd = toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
      const amt = Math.round((Math.random()*4000+500) * (Math.random() > 0.2 ? 1 : -1)) / 1;
      return { id: 1000 + i, date: dd, amount: amt, accountId: ACCOUNT_ID_3003 };
    });
    return { postings: items, count: items.length, totalBeerSales: items.reduce((a,b)=>a+Math.abs(b.amount),0) };
  }

  function render(data, from, to, isDemo=false) {
    const raw = Array.isArray(data.postings) ? data.postings : [];
    const postings = raw.filter(p => (p.account?.id ?? p.accountId ?? null) === ACCOUNT_ID_3003);
    tbody.innerHTML = '';
    let sum = typeof data.totalBeerSales === 'number' ? data.totalBeerSales : 0;
    if (!sum) sum = postings.reduce((acc, p) => acc + Math.abs(Number(p.amount || 0)), 0);

    for (const p of postings) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.id ?? ''}</td>
        <td>${p.date ?? ''}</td>
        <td style="text-align:right">${nbMoney.format(Number(p.amount || 0))}</td>
      `;
      tbody.appendChild(tr);
    }
    lastData = { from, to, postings };
    const count = typeof data.count === 'number' ? data.count : postings.length;
    outEl.textContent = `${count} transaksjoner — Sum: ${nbMoney.format(sum)} NOK${isDemo ? ' (demo)' : ''}`;
  }

  async function loadData(evt){
    const useDemo = !!(evt && evt.altKey);
    let from = normalizeDateString(startEl.value) || fmtDate(ytdStart);
    let to   = normalizeDateString(endEl.value)   || fmtDate(now);
    if(from > to) [from,to] = [to,from];

    setBusy(true, useDemo ? 'Viser demodata …' : 'Henter …');
    try{
      const base = '/.netlify/functions/tripletex';
      const url  = useDemo
        ? `${base}?demo=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        : `${base}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

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

    const fromTag = (lastData.from || '').replaceAll('-', '');
    const toTag   = (lastData.to   || '').replaceAll('-', '');
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

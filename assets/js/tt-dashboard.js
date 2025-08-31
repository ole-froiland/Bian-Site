(() => {
  const section = document.getElementById('tripletex-sales');
  const startEl = document.getElementById('start-date');
  const endEl   = document.getElementById('end-date');
  const fetchBtn = section.querySelector('[data-tt="fetch"]');
  const csvBtn   = section.querySelector('[data-tt="csv"]');
  const outEl    = section.querySelector('[data-tt="out"]') || section.querySelector('p[data-tt="out"]');
  const table    = section.querySelector('table');
  const tbody    = table ? table.querySelector('tbody') : null;
  const startBtn = document.getElementById('monthStartBtn');
  const endBtn   = document.getElementById('monthEndBtn');

  const ACCOUNT_ID_3003 = 289896744;

  if (!startEl || !endEl || !fetchBtn || !csvBtn || !outEl || !tbody) {
    console.warn('Tripletex-dashboard: Mangler forventede DOM-elementer.');
    return;
  }

  // ---------- helpers ----------
  const toYMD = (y, m, d) =>
    `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

  const nbMoney = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------- state ----------
  let lastData = { from: null, to: null, postings: [] };

  const months = ['Jan','Feb','Mar','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Des'];

  function updateRange(){
    const ok = !!(startEl.value && endEl.value);
    fetchBtn.disabled = !ok;
    csvBtn.disabled = !ok;
  }

  function openMonthMenu(btn, input){
    const existing = document.getElementById('month-menu');
    if(existing) existing.remove();
    const menu = document.createElement('div');
    menu.id = 'month-menu';
    menu.style.position = 'absolute';
    menu.style.background = '#fff';
    menu.style.border = '1px solid #c4b5fd';
    menu.style.padding = '4px';
    menu.style.display = 'grid';
    menu.style.gridTemplateColumns = 'repeat(3,1fr)';
    months.forEach((name, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', () => {
        const year = new Date().getFullYear();
        input.value = `${year}-${String(idx+1).padStart(2,'0')}`;
        btn.textContent = `${btn === startBtn ? 'Start: ' : 'Slutt: '}${name}`;
        menu.remove();
        updateRange();
      });
      menu.appendChild(b);
    });
    const rect = btn.getBoundingClientRect();
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top  = `${rect.bottom + window.scrollY}px`;
    menu.style.zIndex = 1000;
    document.body.appendChild(menu);
    const close = (e) => {
      if(!menu.contains(e.target) && e.target !== btn){
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  startBtn.addEventListener('click', () => openMonthMenu(startBtn, startEl));
  endBtn.addEventListener('click', () => openMonthMenu(endBtn, endEl));

  outEl.textContent = '–';
  updateRange();

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

  function computeRange(){
    if(!startEl.value || !endEl.value) return null;
    const [sy, sm] = startEl.value.split('-').map(Number);
    const [ey, em] = endEl.value.split('-').map(Number);
    let fromDate = new Date(sy, sm-1, 1);
    let toDate   = new Date(ey, em, 0);
    if(startEl.value > endEl.value) [fromDate, toDate] = [toDate, fromDate];
    const from = toYMD(fromDate.getFullYear(), fromDate.getMonth()+1, fromDate.getDate());
    const to   = toYMD(toDate.getFullYear(),   toDate.getMonth()+1,   toDate.getDate());
    return { from, to };
  }

  async function loadData(evt){
    const useDemo = !!(evt && evt.altKey);
    const range = computeRange();
    if(!range) return;
    const {from, to} = range;

    setBusy(true, useDemo ? 'Viser demodata …' : 'Henter …');
    try{
      const base = await resolveEndpoint();
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

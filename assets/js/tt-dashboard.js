// assets/js/tt-dashboard.js
(() => {
  const section = document.querySelector('[data-tt-section="tripletex"]') || document;
  const startEl = section.querySelector('#start-date') || section.querySelector('input[name="start"]');
  const endEl   = section.querySelector('#end-date')   || section.querySelector('input[name="end"]');
  const fetchBtn = section.querySelector('[data-tt="fetch"]');
  const csvBtn   = section.querySelector('[data-tt="csv"]');
  const outEl    = section.querySelector('[data-tt="out"]') || section.querySelector('p[data-tt="out"]');
  const table    = section.querySelector('table');
  const tbody    = table ? table.querySelector('tbody') : null;

  if (!startEl || !endEl || !fetchBtn || !csvBtn || !outEl || !tbody) {
    console.warn('Tripletex-dashboard: Mangler forventede DOM-elementer.');
    return;
  }

  const fmtDate = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const nbMoney = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let lastData = { from: null, to: null, postings: [] };

  const now = new Date();
  const ytdStart = new Date(now.getFullYear(), 0, 1);
  if (!startEl.value) startEl.value = fmtDate(ytdStart);
  if (!endEl.value)   endEl.value   = fmtDate(now);
  outEl.textContent = '–';
  csvBtn.disabled = true;

  function setBusy(isBusy, msg) {
    fetchBtn.disabled = isBusy;
    csvBtn.disabled = isBusy || !lastData.postings.length;
    if (msg !== undefined) outEl.textContent = msg;
  }

  async function loadData() {
    let from = startEl.value || fmtDate(ytdStart);
    let to   = endEl.value   || fmtDate(now);
    if (from > to) [from, to] = [to, from];

    setBusy(true, 'Henter …');
    const url = `/.netlify/functions/tripletex?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    try {
      const res = await fetch(url, { headers: { 'accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const postings = Array.isArray(data.postings) ? data.postings : [];
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
      outEl.textContent = `${count} transaksjoner — Sum: ${nbMoney.format(sum)} NOK`;
    } catch (err) {
      console.error('Tripletex fetch error', err);
      outEl.textContent = 'Kunne ikke hente data. Prøv igjen senere.';
      lastData = { from: null, to: null, postings: [] };
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

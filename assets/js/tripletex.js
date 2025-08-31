(function () {
  const root = document.getElementById('tripletex-sales');
  if (!root) return;

  const q = (s) => root.querySelector(s);
  const btnFetch = q('[data-tt=fetch]');
  const btnCsv = q('[data-tt=csv]');
  const out = q('[data-tt=out]');
  const tbody = q('tbody');

  const NOK = (n) =>
    new Intl.NumberFormat('nb-NO', {
      style: 'currency',
      currency: 'NOK',
      maximumFractionDigits: 0,
    }).format(Number(n) || 0);

  // Tar både 'YYYY-MM-DD' og 'DD.MM.YYYY' og returnerer 'YYYY-MM-DD'
  function normalizeDate(v) {
    if (!v) return v;
    // allerede ISO?
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // norsk format?
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v.trim());
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return v;
  }

  function val(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function renderRows(list) {
    tbody.innerHTML = '';
    list.forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${p.id ?? ''}</td>
        <td>${p.date ?? ''}</td>
        <td style="text-align:right">${NOK(p.amount)}</td>`;
      tbody.appendChild(tr);
    });
  }

  function downloadCsv(list, meta) {
    const rows = [['id', 'date', 'amount']].concat(
      list.map((p) => [p.id, p.date, p.amount])
    );
    const csv = rows
      .map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tripletex_3003_${meta.from}_${meta.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function run() {
    try {
      out.textContent = '⏳ Henter…';
      tbody.innerHTML = '';

      // Les og normaliser datoer
      let from = normalizeDate(val('start-date'));
      let to = normalizeDate(val('end-date'));
      const now = new Date();
      if (!from) from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      if (!to) to = now.toISOString().slice(0, 10);

      // Kall riktig endpoint (uten /sales)
      const url = new URL('/.netlify/functions/tripletex', location.origin);
      url.searchParams.set('dateFrom', from);
      url.searchParams.set('dateTo', to);

      const res = await fetch(url, { headers: { 'accept': 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || data?.detail || `HTTP ${res.status}`);
      }

      const postings = Array.isArray(data.postings) ? data.postings : [];
      const total = Number(data.totalBeerSales) || postings.reduce((s, p) => s + Math.abs(Number(p.amount) || 0), 0);

      out.textContent = `Konto 3003 (Salg øl) • ${from}–${to} • Antall: ${postings.length} • Total: ${NOK(total)}`;
      renderRows(postings.slice(0, 300));

      btnCsv.onclick = () => downloadCsv(postings, { from, to });
    } catch (e) {
      out.textContent = `❌ Feil: ${e.message || e}`;
      tbody.innerHTML = '';
    }
  }

  btnFetch?.addEventListener('click', run);
  run(); // auto-fetch ved last
})();

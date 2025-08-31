(function(){
  const root = document.getElementById('tripletex-sales'); if (!root) return;
  const q = sel => root.querySelector(sel);
  const btnFetch = q('[data-tt=fetch]'); const btnCsv = q('[data-tt=csv]');
  const out = q('[data-tt=out]'); const tbody = q('tbody');
  const fmtNOK = n => new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:0}).format(n||0);
  const val = id => (document.getElementById(id)?.value || null);

  async function run(){
    try{
      out.textContent = '⏳ Henter…'; tbody.innerHTML = '';
      const account = 3003;
      const now = new Date();
      const from = val('start-date') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
      const to   = val('end-date')   || now.toISOString().slice(0,10);
      const url = new URL('/.netlify/functions/tripletex/sales', location.origin);
      url.searchParams.set('accountNumber', account); url.searchParams.set('dateFrom', from); url.searchParams.set('dateTo', to);
      const res = await fetch(url); const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || 'Ukjent feil');

      out.textContent = `Konto ${data.accountNumber} (${data.accountName}) • ${data.dateFrom}–${data.dateTo} • Antall: ${data.count} • Total: ${fmtNOK(data.totalNOK)}`;
      (data.postings||[]).slice(0,200).forEach(p=>{
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${p.id}</td><td>${p.date}</td><td style="text-align:right">${fmtNOK(p.amount)}</td>`;
        tbody.appendChild(tr);
      });

      btnCsv.onclick = ()=>{
        const rows = [['id','date','amount']].concat((data.postings||[]).map(p=>[p.id,p.date,p.amount]));
        const csv = rows.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
        const blob = new Blob([csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `tripletex_${data.accountNumber}_${data.dateFrom}_${data.dateTo}.csv`; a.click();
        URL.revokeObjectURL(a.href);
      };
    }catch(e){ out.textContent = `❌ Feil: ${e.message||e}`; }
  }

  btnFetch?.addEventListener('click', run);
  run(); // auto
})();

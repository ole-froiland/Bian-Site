const SALES_NUMBERS = [3000,3001,3002,3003,3004];

function ymToRange(ymStart, ymEnd){
  const dateFrom = ymStart + '-01';
  const [ey, em] = ymEnd.split('-').map(Number);
  const lastDay = new Date(ey, em, 0).getDate();
  const dateTo = ymEnd + '-' + String(lastDay).padStart(2,'0');
  return { dateFrom, dateTo };
}

async function getAccounts(){
  return fetch('/.netlify/functions/tripletex?target=accounts').then(r=>r.json());
}

async function getLedger(dateFrom, dateTo){
  const url = '/.netlify/functions/tripletex?target=ledger&dateFrom='+dateFrom+'&dateTo='+dateTo;
  return fetch(url).then(r=>r.json());
}

function aggregateSales({ postings, accountIndex }){
  const totals = new Map();
  postings.forEach(p=>{
    const accId = p.account?.id;
    let number = p.account?.accountNumber;
    let name = p.account?.name;
    if((number==null || name==null) && accountIndex){
      const info = accountIndex.get(accId);
      if(info){
        if(number==null) number = info.number;
        if(name==null) name = info.name;
      }
    }
    number = Number(number);
    if(!SALES_NUMBERS.includes(number)) return;
    const key = number;
    const item = totals.get(key) || { number, name, total:0 };
    item.total += p.amount;
    totals.set(key, item);
  });
  const rows = Array.from(totals.values()).map(r=>({ number:r.number, name:r.name, total:Math.abs(r.total) }));
  rows.sort((a,b)=>a.number-b.number);
  return rows;
}

function fmtNOK(x){
  return new Intl.NumberFormat('nb-NO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(x)+' kr';
}

function t(key, vars){
  const lang = document.documentElement.lang === 'en' ? 'en' : 'no';
  const dict = {
    no: {
      title: 'Tripletex – Salg',
      fetch: 'Hent',
      csv: 'CSV',
      status:{ ready:'Klar', ok:'\u2705 {accounts} kontoer \u00b7 {postings} posteringer', err:'\u274c Feil: {msg}' },
      th:{ acc:'Konto', name:'Navn', amount:'Bel\u00f8p' }
    },
    en: {
      title: 'Tripletex – Sales',
      fetch: 'Fetch',
      csv: 'CSV',
      status:{ ready:'Ready', ok:'\u2705 {accounts} accounts \u00b7 {postings} postings', err:'\u274c Error: {msg}' },
      th:{ acc:'Account', name:'Name', amount:'Amount' }
    }
  };
  let str = key.split('.').reduce((o,k)=>o[k], dict[lang]);
  if(vars){ for(const k in vars) str = str.replace('{'+k+'}', vars[k]); }
  return str;
}

function applyStaticText(){
  const scope = document.getElementById('tripletex-sales');
  if(!scope) return;
  scope.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n').replace('tripletex.','');
    el.textContent = t(key);
  });
}

async function refresh(){
  const statusEl = document.getElementById('tt-status');
  const table = document.getElementById('tt-table');
  statusEl.textContent = '...';
  table.innerHTML = '';
  try {
    const range = (()=>{
      const mr = window.dashboard?.monthRange;
      if(mr?.start && mr?.end) return ymToRange(mr.start, mr.end);
      const df = document.getElementById('dateFrom');
      const dt = document.getElementById('dateTo');
      if(df?.value && dt?.value) return { dateFrom: df.value, dateTo: dt.value };
      const now = new Date();
      const ym = now.toISOString().slice(0,7);
      return ymToRange(ym, ym);
    })();
    const [{values:accounts}, {values:postings}] = await Promise.all([
      getAccounts(),
      getLedger(range.dateFrom, range.dateTo)
    ]);
    const accountIndex = new Map(accounts.map(a=>[a.id,{number:a.accountNumber,name:a.name}]));
    const rows = aggregateSales({ postings, accountIndex });
    const header = [t('th.acc'), t('th.name'), t('th.amount')];
    header.forEach((h,i)=>{
      const div = document.createElement('div');
      div.textContent = h;
      div.className = i===2 ? 'th td-amt' : 'th';
      table.appendChild(div);
    });
    rows.forEach(r=>{
      const c1 = document.createElement('div'); c1.textContent = r.number; table.appendChild(c1);
      const c2 = document.createElement('div'); c2.textContent = r.name; table.appendChild(c2);
      const c3 = document.createElement('div'); c3.textContent = fmtNOK(r.total); c3.className='td-amt'; table.appendChild(c3);
    });
    statusEl.textContent = t('status.ok',{accounts:rows.length, postings:postings.length});
    let csv = 'Konto;Navn;Bel\u00f8p\n';
    rows.forEach(r=>{ csv += `${r.number};${r.name};${r.total.toFixed(2).replace('.',',')}\n`; });
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    document.getElementById('tt-csv').href = url;
  } catch(err){
    statusEl.textContent = t('status.err',{msg: err.message});
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  applyStaticText();
  document.getElementById('tt-refresh')?.addEventListener('click', refresh);
  const statusEl = document.getElementById('tt-status');
  if(statusEl) statusEl.textContent = t('status.ready');
});

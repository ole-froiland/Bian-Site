(() => {
  const HOST = 'https://no.gastrofix.com';
  const TOKEN = '37746338eb32703a2d7f343348787bdca3d7674e';
  const BU = '41258';

  const topOutEls = Array.from(document.querySelectorAll('[data-sales="top-out"]'));
  const bottomOutEls = Array.from(document.querySelectorAll('[data-sales="bottom-out"]'));
  const startInput = document.querySelector('[data-sales="start"]');
  const endInput = document.querySelector('[data-sales="end"]');

  async function fetchData(start, end){
    const headers = { 'X-Token': TOKEN, 'X-Business-Units': BU };
    const periodsRes = await fetch(`${HOST}/api/transaction/v3.0/business_periods`, { headers });
    const periodsData = await periodsRes.json();
    const periodIds = (periodsData.businessPeriods || [])
      .filter(p => p.businessDay >= start && p.businessDay <= end)
      .map(p => p.periodId);

    let items = [];
    for(const pid of periodIds){
      const res = await fetch(`${HOST}/api/transaction/v3.0/transactions/${pid}`, { headers });
      const data = await res.json();
      (data.transactions || []).forEach(tx => {
        if(Array.isArray(tx.lineItems)) items = items.concat(tx.lineItems);
      });
    }

    const filtered = items.filter(li =>
      !(li.extras && li.extras.voidedLineItemSequenceNumber) &&
      (li.extras && li.extras.itemName) &&
      (li.amounts && li.amounts.quantity > 0)
    );

    const map = new Map();
    for(const li of filtered){
      const name = li.extras.itemName;
      const qty = (li.amounts.quantity || 0) / (li.amounts.units || 1000);
      map.set(name, (map.get(name) || 0) + qty);
    }

    const arr = Array.from(map.entries()).map(([name, qty]) => ({ name, qty }));
    const top = [...arr].sort((a,b)=>b.qty - a.qty).slice(0,3);
    const bottom = [...arr].sort((a,b)=>a.qty - b.qty).slice(0,3);
    return { top, bottom };
  }

  function render(list, el){
    if(!el) return;
    if(!list.length){
      el.innerHTML = '<em>Ingen data</em>';
      return;
    }
    const rows = list.map((p,i) =>
      `<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px dashed rgba(0,0,0,.08)">
        <span>${i+1}. ${p.name}</span>
        <span>x ${p.qty}</span>
      </div>`
    ).join('');
    el.innerHTML = rows;
  }

  function setText(els, text){
    els.forEach(el => el.textContent = text);
  }

  async function load(){
    const start = startInput?.value;
    const end = endInput?.value;
    if(!start || !end){
      setText(topOutEls, 'Velg start- og sluttdato');
      setText(bottomOutEls, 'Velg start- og sluttdato');
      return;
    }
    setText(topOutEls, 'Henter …');
    setText(bottomOutEls, 'Henter …');
    try{
      const { top, bottom } = await fetchData(start, end);
      topOutEls.forEach(el => render(top, el));
      bottomOutEls.forEach(el => render(bottom, el));
    }catch(err){
      console.error(err);
      setText(topOutEls, 'Feil ved henting');
      setText(bottomOutEls, 'Feil ved henting');
    }
  }

  document.querySelectorAll('[data-sales="fetch"]').forEach(btn => {
    btn.addEventListener('click', load);
  });
})();


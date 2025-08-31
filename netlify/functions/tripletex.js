// Netlify Function: Tripletex proxy + debug
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok  = (b) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(b) });
const err = (status, code, message, extra = {}) =>
  ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: code, message, ...extra }) });

// --- FALLBACK KONFIG ---
const FALLBACK = {
  baseUrl: 'https://api-test.tripletex.tech',
  consumer: 'eyJ0b2tlbklkIjo0NDUsInRva2VuIjoidGVzdC0yMmViNmNjMC1lMWMzLTQ4OWItYmMwNi1jM2RlMWJkOGI3NjIifQ==',
  employee: 'eyJ0b2tlbklkIjo2MjgsInRva2VuIjoidGVzdC1iMGM0YzY1Zi1kOTY2LTQ2MGEtYTJlZi00NzI4NjcyMjQ2NmIifQ==',
  account3003Id: 289896744
};

function cfg() {
  const baseUrl  = (process.env.TRIPLETEX_BASE_URL || FALLBACK.baseUrl).replace(/\/+$/,'');
  const consumer = process.env.TRIPLETEX_CONSUMER_TOKEN || FALLBACK.consumer;
  const employee = process.env.TRIPLETEX_EMPLOYEE_TOKEN || FALLBACK.employee;
  const companyId = process.env.TRIPLETEX_COMPANY_ID || null;
  const usedFallback = !process.env.TRIPLETEX_CONSUMER_TOKEN || !process.env.TRIPLETEX_EMPLOYEE_TOKEN;
  return { baseUrl, consumer, employee, companyId, usedFallback };
}

const toYMD = (y,m,d) => `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
function normDate(s){
  if(!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);    if(m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s); if(!Number.isNaN(d.getTime())) return toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
  return null;
}

async function createSession(base, consumer, employee, companyId){
  const basic = Buffer.from(`${consumer}:${employee}`).toString('base64');
  const url = `${base.replace(/\/+$/, '')}/v2/token/session/:create`;
  const r = await fetch(url, {
    method:'POST',
    headers:{
      'Authorization': `Basic ${basic}`,
      'Accept':'application/json',
      'Content-Type':'application/json',
      'consumerToken': consumer,
      'employeeToken': employee,
      ...(companyId ? { 'companyId': String(companyId) } : {})
    },
    body: JSON.stringify({})
  });
  const txt = await r.text();
  if(!r.ok) throw new Error(`SESSION_FAIL:HTTP_${r.status} ${r.statusText} ${txt.slice(0,300)}`);
  let j = {};
  try { j = JSON.parse(txt); } catch {}
  const token = j.value || j.token || j.sessionToken || j?.value?.token;
  if(!token) throw new Error(`SESSION_FAIL:NO_TOKEN ${txt.slice(0,300)}`);
  return token;
}

async function fetchLedger(base, session, from, to){
  const root = base.replace(/\/+$/, '');
  const run = async (paramKey, paramVal) => {
    let page=0, pageSize=1000, out=[];
    while(true){
      const url = `${root}/v2/ledger/posting?fromDate=${from}&toDate=${to}&${paramKey}=${paramVal}&page=${page}&count=${pageSize}`;
      const r = await fetch(url, { headers:{ 'Accept':'application/json','Authorization':`Bearer ${session}` }});
      const txt = await r.text();
      if(r.status===429){ await new Promise(r=>setTimeout(r,800)); continue; }
      if(!r.ok) throw new Error(`LEDGER_FAIL:HTTP_${r.status} ${r.statusText} ${txt.slice(0,300)}`);
      let j={}; try{ j=JSON.parse(txt);}catch{}
      const arr = j.values || j.data || j.postings || [];
      out.push(...arr.map(x=>({
        id: x.id ?? x.voucherId ?? x.number ?? null,
        date: x.date || x.voucherDate || x.transactionDate || null,
        amount: Number(x.amount || x.amountNok || x.value || 0)
      })));
      if(arr.length < pageSize) break;
      const total = j.fullResultSize || j.totalCount || j.total || null;
      if(total && out.length >= total) break;
      page++; await new Promise(r=>setTimeout(r,120));
    }
    return out;
  };

  try{
    const first = await run('accountNumber', 3003);
    if(first.length>0) return first;
    console.warn('accountNumber 3003 gave no results, using accountId fallback');
  }catch(e){
    console.warn('accountNumber lookup failed, using accountId fallback');
  }
  return await run('accountId', FALLBACK.account3003Id);
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=='GET') return err(405,'METHOD_NOT_ALLOWED','Use GET');

    const q = event.queryStringParameters || {};
    const { baseUrl, consumer, employee, companyId, usedFallback } = cfg();
    if(usedFallback) console.warn('Using fallback Tripletex credentials');

    if(q.ping) return ok({ ok:true, service:'tripletex-proxy' });

    if(q.env){
      return ok({
        baseUrl,
        has_TRIPLETEX_CONSUMER_TOKEN: !!process.env.TRIPLETEX_CONSUMER_TOKEN,
        has_TRIPLETEX_EMPLOYEE_TOKEN: !!process.env.TRIPLETEX_EMPLOYEE_TOKEN,
        has_TRIPLETEX_COMPANY_ID: !!process.env.TRIPLETEX_COMPANY_ID,
        usedFallback
      });
    }

    if(q.sessionTest){
      try{
        const token = await createSession(baseUrl, consumer, employee, companyId);
        return ok({ success:true, sessionTokenPreview: token.slice(0,8)+'…' });
      }catch(e){
        return err(502,'SESSION_FAIL', String(e.message||e));
      }
    }

    // demo data
    if(q.demo==='1'){
      const from = normDate(q.from) || toYMD(new Date().getFullYear(),1,1);
      const to   = normDate(q.to)   || toYMD(new Date().getFullYear(),12,31);
      const base = new Date(from);
      const items = Array.from({length:8}).map((_,i)=>{
        const d=new Date(base); d.setDate(d.getDate()+i*3);
        const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0');
        return { id:1000+i,date:`${d.getFullYear()}-${mm}-${dd}`, amount: Math.round((Math.random()*4000+500)*(Math.random()>0.2?1:-1)) };
      });
      const total = items.reduce((a,b)=>a+Math.abs(b.amount),0);
      return ok({ dateFrom:from, dateTo:to, count:items.length, totalBeerSales:total, postings:items });
    }

    // real fetch
    let from = normDate(q.from);
    let to   = normDate(q.to);
    if(!from || !to){
      const now = new Date(); const ytd = new Date(now.getFullYear(),0,1);
      from = toYMD(ytd.getFullYear(), ytd.getMonth()+1, ytd.getDate());
      to   = toYMD(now.getFullYear(), now.getMonth()+1, now.getDate());
    }
    if(from>to) [from,to]=[to,from];

    let session;
    try{
      session = await createSession(baseUrl, consumer, employee, companyId);
    }catch(e){
      return err(502,'SESSION_FAIL', String(e.message||e));
    }

    let postings;
    try{
      postings = await fetchLedger(baseUrl, session, from, to);
    }catch(e){
      return err(502,'LEDGER_FAIL', String(e.message||e));
    }

    const total = postings.reduce((a,p)=>a+Math.abs(Number(p.amount||0)),0);
    return ok({ dateFrom:from, dateTo:to, count:postings.length, totalBeerSales:total, postings });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};


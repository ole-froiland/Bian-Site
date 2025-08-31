// Netlify Function: Tripletex proxy + debug
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok  = (b) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(b) });
const err = (status, code, message, extra = {}) =>
  ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: code, message, ...extra }) });

// --- config/fallback (behold dine tokens hvis du har env vars) ---
const FALLBACK = {
  baseUrl: process.env.TRIPLETEX_BASE_URL || 'https://api-test.tripletex.tech',
  consumer: process.env.TRIPLETEX_CONSUMER_TOKEN || 'eyJ0b2tlbklkIjo0NDUsInRva2VuIjoidGVzdC0yMmViNmNjMC1lMWMzLTQ4OWItYmMwNi1jM2RlMWJkOGI3NjIifQ==',
  employee: process.env.TRIPLETEX_EMPLOYEE_TOKEN || 'eyJ0b2tlbklkIjo2MjgsInRva2VuIjoidGVzdC1iMGM0YzY1Zi1kOTY2LTQ2MGEtYTJlZi00NzI4NjcyMjQ2NmIifQ==',
  companyId: process.env.TRIPLETEX_COMPANY_ID || null,
  account3003Id: 289896744
};

const isTest = FALLBACK.baseUrl.includes('api-test.tripletex.tech');

const toYMD = (y,m,d) => `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
function normDate(s){
  if(!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);    if(m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s); if(!Number.isNaN(d.getTime())) return toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
  return null;
}

// Lager session-token: PUT+query for TEST, POST+JSON for PROD
async function createSession() {
  const base = FALLBACK.baseUrl.replace(/\/+$/,'');
  if (isTest) {
    const params = new URLSearchParams({
      consumerToken: FALLBACK.consumer,
      employeeToken: FALLBACK.employee,
      expirationDate: new Date(Date.now()+86400e3).toISOString()
    });
    const url = `${base}/v2/token/session/:create?${params.toString()}`;
    const r = await fetch(url, { method: 'PUT', headers: { 'Accept':'application/json' }});
    const txt = await r.text();
    if (!r.ok) throw new Error(`SESSION_FAIL:HTTP_${r.status} ${r.statusText} ${txt.slice(0,300)}`);
    const j = JSON.parse(txt);
    const tok = j?.value?.token || j.token || j.value;
    if (!tok) throw new Error(`SESSION_FAIL:NO_TOKEN ${txt.slice(0,300)}`);
    return tok;
  } else {
    const url = `${base}/v2/token/session/:create`;
    const basic = Buffer.from(`${FALLBACK.consumer}:${FALLBACK.employee}`).toString('base64');
    const headers = {
      'Authorization': `Basic ${basic}`,
      'Accept':'application/json',
      'Content-Type':'application/json',
      'consumerToken': FALLBACK.consumer,
      'employeeToken': FALLBACK.employee,
      ...(FALLBACK.companyId ? { 'companyId': String(FALLBACK.companyId) } : {})
    };
    const r = await fetch(url, { method:'POST', headers, body: JSON.stringify({}) });
    const txt = await r.text();
    if (!r.ok) throw new Error(`SESSION_FAIL:HTTP_${r.status} ${r.statusText} ${txt.slice(0,300)}`);
    const j = JSON.parse(txt);
    const tok = j.value || j.token || j.sessionToken || j?.value?.token;
    if (!tok) throw new Error(`SESSION_FAIL:NO_TOKEN ${txt.slice(0,300)}`);
    return tok;
  }
}

// Felles fetch for ledger/posting – velg auth etter miljø
async function fetchLedger(from, to) {
  const base = FALLBACK.baseUrl.replace(/\/+$/,'');
  const token = await createSession();

  const authHeader = isTest
    ? { 'Authorization': `Basic ${Buffer.from('0:'+token).toString('base64')}` }
    : { 'Authorization': `Bearer ${token}` };

  async function get(url) {
    const r = await fetch(url, { headers: { 'Accept':'application/json', ...authHeader } });
    const txt = await r.text();
    if (!r.ok) throw new Error(`LEDGER_FAIL:HTTP_${r.status} ${r.statusText} ${txt.slice(0,300)}`);
    return JSON.parse(txt);
  }

  // prøv accountNumber=3003 først
  const qsBase = `dateFrom=${from}&dateTo=${to}&page=0&count=1000`;
  let j;
  try {
    j = await get(`${base}/v2/ledger/posting?${qsBase}&accountNumber=3003`);
  } catch {
    // fallback: bruk accountId for 3003
    j = await get(`${base}/v2/ledger/posting?${qsBase}&accountId=${FALLBACK.account3003Id}`);
  }

  const arr = j.values || j.data || j.postings || [];
  return arr.map(x => ({
    id: x.id ?? x.voucherId ?? x.number ?? null,
    date: x.date || x.voucherDate || x.transactionDate || null,
    amount: Number(x.amount || x.amountNok || x.value || 0)
  }));
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=='GET') return err(405,'METHOD_NOT_ALLOWED','Use GET');

    const q = event.queryStringParameters || {};
    const usedFallback = !process.env.TRIPLETEX_CONSUMER_TOKEN || !process.env.TRIPLETEX_EMPLOYEE_TOKEN;
    if(usedFallback) console.warn('Using fallback Tripletex credentials');

    if(q.ping) return ok({ ok:true, service:'tripletex-proxy' });

    if(q.env){
      return ok({
        baseUrl: FALLBACK.baseUrl,
        has_TRIPLETEX_CONSUMER_TOKEN: !!process.env.TRIPLETEX_CONSUMER_TOKEN,
        has_TRIPLETEX_EMPLOYEE_TOKEN: !!process.env.TRIPLETEX_EMPLOYEE_TOKEN,
        has_TRIPLETEX_COMPANY_ID: !!process.env.TRIPLETEX_COMPANY_ID,
        usedFallback
      });
    }

    if(q.sessionTest){
      try{
        const token = await createSession();
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

    let postings;
    try{
      postings = await fetchLedger(from, to);
    }catch(e){
      return err(502,'LEDGER_FAIL', String(e.message||e));
    }

    const total = postings.reduce((a,p)=>a+Math.abs(Number(p.amount||0)),0);
    return ok({ dateFrom:from, dateTo:to, count:postings.length, totalBeerSales:total, postings });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};


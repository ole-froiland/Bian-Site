// Netlify Function: Tripletex proxy + debug
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok  = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
const err = (status, code, message, extra = {}) => ({
  statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: code, message, ...extra })
});

const toYMD = (y,m,d) => `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
function normDate(s){
  if(!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);    if(m) return `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(s); if(!Number.isNaN(d.getTime())) return toYMD(d.getFullYear(), d.getMonth()+1, d.getDate());
  return null;
}

function need(name){
  const v = process.env[name]; if(!v) throw new Error(`MISSING_ENV:${name}`);
  return v;
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

async function fetchLedger(base, session, from, to, accountNumber=3003){
  let page=0, pageSize=1000, out=[];
  const root = base.replace(/\/+$/, '');
  while(true){
    const url = `${root}/v2/ledger/posting?fromDate=${from}&toDate=${to}&accountNumber=${accountNumber}&page=${page}&count=${pageSize}`;
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
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=='GET') return err(405,'METHOD_NOT_ALLOWED','Use GET');

    const q = event.queryStringParameters || {};
    const baseUrl  = (process.env.TRIPLETEX_BASE_URL || 'https://tripletex.no').replace(/\/+$/, '');
    const companyId = process.env.TRIPLETEX_COMPANY_ID || null;

    if(q.ping) return ok({ ok:true, service:'tripletex-proxy' });

    if(q.env){
      return ok({
        baseUrl,
        has_TRIPLETEX_CONSUMER_TOKEN: !!process.env.TRIPLETEX_CONSUMER_TOKEN,
        has_TRIPLETEX_EMPLOYEE_TOKEN: !!process.env.TRIPLETEX_EMPLOYEE_TOKEN,
        has_TRIPLETEX_COMPANY_ID: !!process.env.TRIPLETEX_COMPANY_ID
      });
    }

    if(q.sessionTest){
      try{
        const consumer = need('TRIPLETEX_CONSUMER_TOKEN');
        const employee = need('TRIPLETEX_EMPLOYEE_TOKEN');
        const token = await createSession(baseUrl, consumer, employee, companyId);
        return ok({ success:true, sessionTokenPreview: token.slice(0,8)+'…' });
      }catch(e){
        const msg = String(e.message||e);
        if(msg.startsWith('MISSING_ENV:')){
          return err(500,'MISSING_ENV',`Missing environment variable: ${msg.split(':')[1]}`);
        }
        return err(502,'SESSION_FAIL', msg);
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

    let consumer, employee;
    try{
      consumer = need('TRIPLETEX_CONSUMER_TOKEN');
      employee = need('TRIPLETEX_EMPLOYEE_TOKEN');
    }catch(e){
      return err(500,'MISSING_ENV', `Missing environment variable: ${String(e.message).split(':')[1]}`);
    }

    let session;
    try{
      session = await createSession(baseUrl, consumer, employee, companyId);
    }catch(e){
      return err(502,'SESSION_FAIL', String(e.message||e));
    }

    let postings;
    try{
      postings = await fetchLedger(baseUrl, session, from, to, 3003);
    }catch(e){
      return err(502,'LEDGER_FAIL', String(e.message||e));
    }

    const total = postings.reduce((a,p)=>a+Math.abs(Number(p.amount||0)),0);
    return ok({ dateFrom:from, dateTo:to, count:postings.length, totalBeerSales:total, postings });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};


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
  companyId: process.env.TRIPLETEX_COMPANY_ID || null
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

function getISOWeekInfo(dateStr) {
  if (!dateStr) return null;
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) return null;
  const d = new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  const key = `${year}-W${String(week).padStart(2, '0')}`;
  const weekStartUTC = new Date(d);
  weekStartUTC.setUTCDate(d.getUTCDate() - 3);
  const weekEndUTC = new Date(weekStartUTC);
  weekEndUTC.setUTCDate(weekStartUTC.getUTCDate() + 6);
  return {
    year,
    week,
    key,
    start: toYMD(weekStartUTC.getUTCFullYear(), weekStartUTC.getUTCMonth() + 1, weekStartUTC.getUTCDate()),
    end: toYMD(weekEndUTC.getUTCFullYear(), weekEndUTC.getUTCMonth() + 1, weekEndUTC.getUTCDate())
  };
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

async function createLedgerClient() {
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

  const mapPosting = (x) => ({
    id: x.id ?? x.voucherId ?? x.number ?? null,
    date: x.date || x.voucherDate || x.transactionDate || null,
    amount: Number(x.amount || x.amountNok || x.value || 0),
    accountId: x.account?.id ?? x.accountId ?? null,
    accountNumber: x.account?.number ?? x.accountNumber ?? null,
    accountName: x.account?.name ?? x.accountName ?? null
  });

  async function fetchPostings({ from, to, accountId, accountNumber }) {
    const postings = [];
    const pageSize = 1000;
    let page = 0;
    while (page < 100) {
      const params = new URLSearchParams({
        dateFrom: from,
        dateTo: to,
        page: String(page),
        count: String(pageSize)
      });
      if (accountId) params.set('accountId', String(accountId));
      else if (accountNumber) params.set('accountNumber', String(accountNumber));
      const url = `${base}/v2/ledger/posting?${params.toString()}`;
      const j = await get(url);
      const arr = j.values || j.data || j.postings || [];
      postings.push(...arr.map(mapPosting));
      if (arr.length < pageSize) break;
      page += 1;
    }
    return postings;
  }

  return {
    fetchPostings,
  };
}

const DEFAULT_BEER_ACCOUNT_ID = '289896744';

function parseAccountsParams(rawValues) {
  if (!rawValues || !rawValues.length) return [];
  const items = [];
  rawValues.forEach((raw) => {
    if (!raw) return;
    String(raw).split(',').forEach((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return;
      const [keyPart, valuePart] = trimmed.split(':');
      const keyLabel = keyPart || trimmed;
      const [key, label] = keyLabel.split('|');
      if (!valuePart) return;
      const value = valuePart.trim();
      if (!value) return;
      const descriptor = {};
      if (value.startsWith('id-')) descriptor.accountId = value.slice(3);
      else if (/^[0-9]{6,}$/.test(value)) descriptor.accountId = value;
      else descriptor.accountNumber = value;
      items.push({ key: key.trim(), label: (label || key).trim(), ...descriptor });
    });
  });
  return items;
}

function aggregatePostings(postings, accountConfigs, { group } = {}) {
  const results = new Map();
  const matchers = accountConfigs.map((cfg) => ({
    ...cfg,
    accountId: cfg.accountId ? String(cfg.accountId) : null,
    accountNumber: cfg.accountNumber ? String(cfg.accountNumber) : null
  }));

  const normalizedGroup = ['month', 'week', 'day'].includes(group) ? group : null;

  postings.forEach((posting) => {
    const accountId = posting.accountId ? String(posting.accountId) : null;
    const accountNumber = posting.accountNumber ? String(posting.accountNumber) : null;
    const matched = matchers.filter((cfg) => {
      if (cfg.accountId && cfg.accountId === accountId) return true;
      if (cfg.accountNumber && cfg.accountNumber === accountNumber) return true;
      return false;
    });
    if (!matched.length) return;
    matched.forEach((cfg) => {
      if (!results.has(cfg.key)) {
        results.set(cfg.key, {
          key: cfg.key,
          label: cfg.label || cfg.key,
          accountId: accountId,
          accountNumber: accountNumber,
          total: 0,
          totalAbsolute: 0,
          months: {}
        });
      }
      const entry = results.get(cfg.key);
      const signed = Number(posting.amount || 0);
      const abs = Math.abs(signed);
      entry.total += signed;
      entry.totalAbsolute += abs;
      if (normalizedGroup) {
        if (!entry.periods) entry.periods = Object.create(null);
        let bucketKey = 'ukjent';
        let meta = null;
        if (normalizedGroup === 'month') {
          bucketKey = (posting.date || '').slice(0, 7) || 'ukjent';
          if (bucketKey !== 'ukjent') {
            const [yearPart, monthPart] = bucketKey.split('-');
            const yearInt = Number(yearPart);
            const monthInt = Number(monthPart);
            if (!Number.isNaN(yearInt) && !Number.isNaN(monthInt)) {
              const endDate = new Date(Date.UTC(yearInt, monthInt, 0));
              meta = {
                year: yearInt,
                month: monthInt,
                key: bucketKey,
                start: toYMD(yearInt, monthInt, 1),
                end: toYMD(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate())
              };
            }
          }
        } else if (normalizedGroup === 'day') {
          bucketKey = (posting.date || '').slice(0, 10) || 'ukjent';
          if (bucketKey !== 'ukjent') {
            meta = { date: bucketKey, key: bucketKey };
          }
        } else if (normalizedGroup === 'week') {
          const info = getISOWeekInfo(posting.date);
          bucketKey = info?.key || 'ukjent';
          meta = info;
        }
        if (!entry.periods[bucketKey]) {
          entry.periods[bucketKey] = {
            total: 0,
            totalAbsolute: 0,
            firstDate: posting.date || null,
            lastDate: posting.date || null,
            meta
          };
        } else {
          const existing = entry.periods[bucketKey];
          if (posting.date) {
            if (!existing.firstDate || posting.date < existing.firstDate) existing.firstDate = posting.date;
            if (!existing.lastDate || posting.date > existing.lastDate) existing.lastDate = posting.date;
          }
        }
        entry.periods[bucketKey].total += signed;
        entry.periods[bucketKey].totalAbsolute += abs;
        if (normalizedGroup === 'month') {
          entry.months[bucketKey] = {
            total: entry.periods[bucketKey].total,
            totalAbsolute: entry.periods[bucketKey].totalAbsolute
          };
        }
      }
    });
  });

  return Array.from(results.values());
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=='GET') return err(405,'METHOD_NOT_ALLOWED','Use GET');

    const q = event.queryStringParameters || {};
    const multiQ = event.multiValueQueryStringParameters || {};
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

    const accountParamsRaw = [];
    if (multiQ.accounts && Array.isArray(multiQ.accounts)) accountParamsRaw.push(...multiQ.accounts);
    if (q.accounts) accountParamsRaw.push(q.accounts);
    const accountConfigs = parseAccountsParams(accountParamsRaw);
    const groupMode = String(q.group || '').toLowerCase();
    const allowedGroups = new Set(['month', 'week', 'day']);
    const wantsAggregation = accountConfigs.length > 0 || allowedGroups.has(groupMode);

    // demo data
    if(q.demo==='1'){
      const from = normDate(q.from) || toYMD(new Date().getFullYear(),1,1);
      const to   = normDate(q.to)   || toYMD(new Date().getFullYear(),12,31);
      const base = new Date(from);
      const items = Array.from({length:8}).map((_,i)=>{
        const d=new Date(base); d.setDate(d.getDate()+i*3);
        const mm=String(d.getMonth()+1).padStart(2,'0'); const dd=String(d.getDate()).padStart(2,'0');
        return {
          id:1000+i,
          date:`${d.getFullYear()}-${mm}-${dd}`,
          amount: Math.round((Math.random()*4000+500)*(Math.random()>0.2?1:-1)),
          accountId: Number(DEFAULT_BEER_ACCOUNT_ID)
        };
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

    if (!wantsAggregation) {
      let postings;
      try{
        const client = await createLedgerClient();
        postings = await client.fetchPostings({ from, to, accountId: DEFAULT_BEER_ACCOUNT_ID });
      }catch(e){
        return err(502,'LEDGER_FAIL', String(e.message||e));
      }

      const total = postings.reduce((a,p)=>a+Math.abs(Number(p.amount||0)),0);
      return ok({ dateFrom:from, dateTo:to, count:postings.length, totalBeerSales:total, postings });
    }

    const client = await createLedgerClient();
    let postings;
    try{
      postings = await client.fetchPostings({ from, to });
    }catch(e){
      return err(502,'LEDGER_FAIL', String(e.message||e));
    }

    const effectiveAccounts = accountConfigs.length
      ? accountConfigs
      : [{ key: 'beerRevenue', label: 'Øl salg', accountId: DEFAULT_BEER_ACCOUNT_ID }];

    const aggregates = aggregatePostings(
      postings,
      effectiveAccounts,
      { group: allowedGroups.has(groupMode) ? groupMode : undefined }
    );

    const totalBeer = aggregates.find((item) => item.accountId === DEFAULT_BEER_ACCOUNT_ID || item.accountNumber === '3003');
    const defaultPostings = aggregates.length === 1
      ? postings.filter((p) => {
          const matchCfg = effectiveAccounts[0];
          if (matchCfg.accountId && String(p.accountId) === String(matchCfg.accountId)) return true;
          if (matchCfg.accountNumber && String(p.accountNumber) === String(matchCfg.accountNumber)) return true;
          return false;
        })
      : [];

    return ok({
      dateFrom: from,
      dateTo: to,
      count: postings.length,
      totalBeerSales: totalBeer ? totalBeer.totalAbsolute : 0,
      accounts: aggregates,
      group: allowedGroups.has(groupMode) ? groupMode : null,
      postings: defaultPostings,
    });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};

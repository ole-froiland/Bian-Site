// Netlify Function: Lightspeed (Gastrofix) proxy + top products
// Env vars (configure in Netlify):
// - LIGHTSPEED_GASTROFIX_BASE_URL (default: https://no.gastrofix.com/api/)
// - LIGHTSPEED_X_TOKEN (required)
// - LIGHTSPEED_BUSINESS_ID (required)
// - LIGHTSPEED_OPERATOR (optional; for some endpoints)

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ok  = (b) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(b) });
const err = (status, code, message, extra = {}) =>
  ({ statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: code, message, ...extra }) });

const CFG = {
  baseUrl: (process.env.LIGHTSPEED_GASTROFIX_BASE_URL || 'https://no.gastrofix.com/api/').replace(/\/+$/,'') + '/',
  xToken: process.env.LIGHTSPEED_X_TOKEN || '',
  businessId: process.env.LIGHTSPEED_BUSINESS_ID || '',
  operator: process.env.LIGHTSPEED_OPERATOR || ''
};

const DEFAULT_RECEIPTS_ENDPOINT = 'reports/v3.0/receipts';
const RECEIPTS_ENDPOINT_CANDIDATES = [
  'reports/v3.0/receipts',
  'accounting/v3.0/receipts',
  'reporting/v3.0/receipts',
  'reports/v2/receipts',
  'reports/receipts'
];

function normDate(s){
  if(!s) return null;
  s = String(s).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if(!Number.isNaN(d.getTime())){
    const y=d.getFullYear(), M=String(d.getMonth()+1).padStart(2,'0'), D=String(d.getDate()).padStart(2,'0');
    return `${y}-${M}-${D}`;
  }
  return null;
}

function authHeaders(){
  const h = { 'Accept':'application/json' };
  if(CFG.xToken) h['X-Token'] = CFG.xToken;
  if(CFG.businessId) h['X-Business-Id'] = CFG.businessId;
  if(CFG.operator) h['X-Operator-Id'] = CFG.operator;
  return h;
}

async function fetchJson(url, headers){
  const r = await fetch(url, { headers });
  const txt = await r.text();
  let j = null; try{ j = JSON.parse(txt); } catch { /* keep raw */ }
  if(!r.ok) throw Object.assign(new Error(`HTTP_${r.status} ${r.statusText}`), { status:r.status, body:j||txt });
  return j;
}

function headerVariants(baseHeaders, tokenOverride){
  const token = tokenOverride || CFG.xToken;
  const variants = [];
  // X-Token
  variants.push({ ...baseHeaders, ...(token ? { 'X-Token': token } : {}) });
  // Authorization: Bearer
  variants.push({ ...baseHeaders, ...(token ? { 'Authorization': `Bearer ${token}` } : {}) });
  // X-Api-Key (some deployments)
  variants.push({ ...baseHeaders, ...(token ? { 'X-Api-Key': token } : {}) });
  return variants;
}

// Try two common param shapes for receipts endpoints
function buildReceiptsUrl(endpoint, from, to, page=0, size=200){
  const base = new URL(endpoint, CFG.baseUrl);
  // First attempt: start/end
  base.searchParams.set('start', from);
  base.searchParams.set('end', to);
  base.searchParams.set('page', String(page));
  base.searchParams.set('size', String(size));
  return base.toString();
}

function buildReceiptsUrlAlt(endpoint, from, to, page=0, size=200){
  const base = new URL(endpoint, CFG.baseUrl);
  // Alternate attempt: from/to
  base.searchParams.set('from', from);
  base.searchParams.set('to', to);
  base.searchParams.set('page', String(page));
  base.searchParams.set('size', String(size));
  return base.toString();
}

// Some APIs prefer limit/offset
function buildReceiptsUrlLimitOffset(endpoint, from, to, offset=0, limit=200){
  const base = new URL(endpoint, CFG.baseUrl);
  base.searchParams.set('from', from);
  base.searchParams.set('to', to);
  base.searchParams.set('offset', String(offset));
  base.searchParams.set('limit', String(limit));
  return base.toString();
}

async function fetchReceiptsRange({ from, to, endpoint }){
  const provided = (endpoint || DEFAULT_RECEIPTS_ENDPOINT).replace(/^\/+|\/+$/g,'');
  const candidates = [provided, ...RECEIPTS_ENDPOINT_CANDIDATES.filter(e => e !== provided)];
  const baseHeaders = authHeaders();
  let lastErr = null;

  for (const ep of candidates) {
    const items = [];
    let page = 0;
    const size = 200;
    let success = true;
    for (let i = 0; i < 20; i++) {
      let data = null;
      let ok = false;
      // Try each header variant across param styles
      for (const hdr of headerVariants(baseHeaders)) {
        try { data = await fetchJson(buildReceiptsUrl(ep, from, to, page, size), hdr); ok = true; break; } catch (e1) { lastErr = e1; }
        try { data = await fetchJson(buildReceiptsUrlAlt(ep, from, to, page, size), hdr); ok = true; break; } catch (e2) { lastErr = e2; }
        try { data = await fetchJson(buildReceiptsUrlLimitOffset(ep, from, to, page*size, size), hdr); ok = true; break; } catch (e3) { lastErr = e3; }
      }
      if (!ok) { success = false; break; }

      const arr = Array.isArray(data?.data) ? data.data
                : Array.isArray(data?.values) ? data.values
                : Array.isArray(data?.receipts) ? data.receipts
                : Array.isArray(data?.items) ? data.items
                : Array.isArray(data) ? data
                : [];
      items.push(...arr);

      const total = (data?.totalElements ?? data?.total ?? null);
      const hasMore = arr.length === size || (typeof total === 'number' && (page+1)*size < total);
      if(!hasMore) break;
      page++;
    }

    if (success && items.length >= 0) {
      return items;
    }
  }

  throw lastErr || new Error('Failed to fetch receipts from all known endpoints');
}

// Extract line items from a Lightspeed Restaurant/Gastrofix receipt object
function extractLines(receipt){
  const lines = receipt?.items || receipt?.positions || receipt?.lines || [];
  if(Array.isArray(lines)) return lines;
  // Some APIs wrap in { items: { data: [...] } }
  if (lines && Array.isArray(lines.data)) return lines.data;
  return [];
}

function pickLineName(line){
  return line?.productName || line?.name || line?.title || line?.articleName || 'Ukjent';
}

function pickLineId(line){
  return line?.productId || line?.articleId || line?.id || null;
}

function pickQty(line){
  const n = Number(line?.quantity ?? line?.qty ?? 1);
  return Number.isFinite(n) ? n : 1;
}

function pickRevenue(line){
  const n = Number(line?.amount ?? line?.grossAmount ?? line?.totalPrice ?? line?.priceTotal ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function aggregateTopProducts(receipts, metric='revenue'){
  const map = new Map();
  for(const r of receipts){
    const lines = extractLines(r);
    for(const ln of lines){
      const id = pickLineId(ln);
      const name = pickLineName(ln);
      const key = `${id ?? name}`;
      const prev = map.get(key) || { id, name, qty:0, revenue:0 };
      prev.qty += pickQty(ln);
      prev.revenue += pickRevenue(ln);
      map.set(key, prev);
    }
  }
  const arr = Array.from(map.values());
  const sorter = metric==='qty' ? (a,b)=> b.qty - a.qty : (a,b)=> b.revenue - a.revenue;
  arr.sort(sorter);
  return arr;
}

exports.handler = async (event) => {
  try{
    if(event.httpMethod !== 'GET') return err(405,'METHOD_NOT_ALLOWED','Use GET');
    const q = event.queryStringParameters || {};

    if(q.ping) return ok({ ok:true, service:'lightspeed-proxy' });
    if(q.env) return ok({
      baseUrl: CFG.baseUrl,
      has_LIGHTSPEED_X_TOKEN: !!process.env.LIGHTSPEED_X_TOKEN,
      has_LIGHTSPEED_BUSINESS_ID: !!process.env.LIGHTSPEED_BUSINESS_ID,
      has_LIGHTSPEED_OPERATOR: !!process.env.LIGHTSPEED_OPERATOR
    });

    const endpoint = (q.endpoint || '').trim() || DEFAULT_RECEIPTS_ENDPOINT;
    const metric = (q.metric === 'qty') ? 'qty' : 'revenue';
    // Allow operator override via query for troubleshooting
    if (q.operator) CFG.operator = String(q.operator);

    // Dates
    let from = normDate(q.from || q.start);
    let to   = normDate(q.to || q.end);
    if(!from || !to){
      const now = new Date();
      const y = now.getFullYear();
      from = `${y}-01-01`;
      const M=String(now.getMonth()+1).padStart(2,'0'); const D=String(now.getDate()).padStart(2,'0');
      to = `${y}-${M}-${D}`;
    }
    if(from>to) [from,to]=[to,from];

    // Special: demo data
    if(q.demo==='1'){
      const demoReceipts = Array.from({length:5}).map((_,i)=>({
        id:1000+i,
        items:[
          { productId: 1, productName:'Pils 0.5', quantity: Math.round(Math.random()*20+5), amount: Math.round(Math.random()*4000+500) },
          { productId: 2, productName:'IPA 0.5',  quantity: Math.round(Math.random()*12+3), amount: Math.round(Math.random()*3000+300) },
          { productId: 3, productName:'Cider',    quantity: Math.round(Math.random()*10+1), amount: Math.round(Math.random()*2000+200) },
        ]
      }));
      const top = aggregateTopProducts(demoReceipts, metric);
      const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
      return ok({ from, to, endpoint, count: demoReceipts.length, top: top.slice(0,limit) });
    }

    if(!CFG.xToken || !CFG.businessId){
      return err(400,'CONFIG_MISSING','Missing Lightspeed env vars (X_TOKEN or BUSINESS_ID)');
    }

    // Fetch receipts and aggregate
    let receipts;
    try{
      receipts = await fetchReceiptsRange({ from, to, endpoint });
    }catch(e){
      const status = e?.status || 502;
      return err(status, 'RECEIPTS_FAIL', String(e.message||e), {
        details: e?.body,
        triedEndpoints: [endpoint || DEFAULT_RECEIPTS_ENDPOINT, ...RECEIPTS_ENDPOINT_CANDIDATES]
      });
    }

    const top = aggregateTopProducts(receipts, metric);
    const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
    return ok({ from, to, endpoint, count: receipts.length, top: top.slice(0,limit) });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};

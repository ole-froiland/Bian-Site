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
  xToken: process.env.LIGHTSPEED_X_TOKEN || '3c8d63ffebb147adb2e0dc6e8b1bd90c306b17d3',
  businessId: process.env.LIGHTSPEED_BUSINESS_ID || '41258',
  businessUnits: process.env.LIGHTSPEED_BUSINESS_UNITS || process.env.LIGHTSPEED_BUSINESS_ID || '41258',
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

const TRANSACTION_ENDPOINT = 'transaction/v3.0/transactions/';

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
  if(CFG.businessUnits) h['X-Business-Units'] = CFG.businessUnits;
  if(CFG.operator){
    h['X-Operator'] = CFG.operator;
    h['X-Operator-Id'] = CFG.operator;
  }
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

function summarizeReceiptsByDay(receipts){
  const map = new Map();
  for(const receipt of receipts){
    const dateObj = pickReceiptDate(receipt);
    if(!dateObj) continue;
    const key = formatDateKey(dateObj);
    const revenue = receiptRevenue(receipt);
    const guests = receiptGuestCount(receipt);
    const bucket = map.get(key) || { date: key, revenue: 0, guests: 0, receipts: 0 };
    bucket.revenue += revenue;
    bucket.guests += guests;
    bucket.receipts += 1;
    map.set(key, bucket);
  }
  return Array.from(map.values()).sort((a,b)=> b.date.localeCompare(a.date));
}

function receiptRevenue(receipt){
  const lines = extractLines(receipt);
  let total = 0;
  for(const line of lines){
    const val = pickRevenue(line);
    if(Number.isFinite(val)) total += val;
  }
  return total;
}

function receiptGuestCount(receipt){
  const candidates = [
    receipt?.guestCount,
    receipt?.guests,
    receipt?.guest_number,
    receipt?.covers,
    receipt?.customerCount,
    receipt?.customers,
    receipt?.persons,
    receipt?.head?.guestCount,
    receipt?.head?.covers
  ];
  for(const candidate of candidates){
    const num = Number(candidate);
    if(Number.isFinite(num) && num > 0) return num;
  }
  return 0;
}

function pickReceiptDate(receipt){
  if(!receipt || typeof receipt !== 'object') return null;
  const candidatePaths = [
    'businessDay',
    'businessDate',
    'businessDateTime',
    'businessDayDate',
    'receiptBusinessDate',
    'receiptBusinessDay',
    'head.businessDay',
    'head.businessDate',
    'head.receiptBusinessDate',
    'document.businessDate',
    'date',
    'createdAt',
    'created',
    'timestamp',
    'timeStamp',
    'issuedAt'
  ];
  for(const path of candidatePaths){
    const value = extractPathValue(receipt, path);
    const parsed = normalizeDateValue(value);
    if(parsed) return parsed;
  }
  return null;
}

function extractPathValue(obj, path){
  if(!obj) return undefined;
  const parts = path.split('.');
  let current = obj;
  for(const part of parts){
    if(current == null) return undefined;
    current = current[part];
  }
  return current;
}

function normalizeDateValue(value){
  if(!value) return null;
  if(value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if(typeof value === 'string'){
    const trimmed = value.trim();
    if(!trimmed) return null;
    if(/^\d{8}$/.test(trimmed)){ // e.g. 20240512
      const year = trimmed.slice(0,4);
      const month = trimmed.slice(4,6);
      const day = trimmed.slice(6,8);
      const iso = `${year}-${month}-${day}`;
      const parsed = new Date(`${iso}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(trimmed);
    if(!Number.isNaN(parsed.getTime())) return parsed;
    if(/^\d{4}-\d{2}-\d{2}$/.test(trimmed)){
      const parsedMidnight = new Date(`${trimmed}T00:00:00`);
      return Number.isNaN(parsedMidnight.getTime()) ? null : parsedMidnight;
    }
  }
  if(typeof value === 'number'){
    if(!Number.isFinite(value)) return null;
    if(value > 1e12) return new Date(value);
    if(value > 1e9) return new Date(value * 1000);
  }
  if(typeof value === 'object'){
    if('date' in value) return normalizeDateValue(value.date);
    if('businessDate' in value) return normalizeDateValue(value.businessDate);
    if('value' in value) return normalizeDateValue(value.value);
    if('iso' in value) return normalizeDateValue(value.iso);
  }
  return null;
}

function formatDateKey(date){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

async function fetchPeriodTransactions(periodId){
  const path = `${TRANSACTION_ENDPOINT.replace(/\/+$/, '')}/${String(periodId).replace(/^\/+/, '')}`;
  const url = new URL(path, CFG.baseUrl).toString();
  const baseHeaders = authHeaders();
  let lastErr = null;
  for (const hdr of headerVariants(baseHeaders)) {
    try {
      return await fetchJson(url, hdr);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to fetch period transactions');
}

function summarizePeriodSalesFromData(data={}){
  const transactions = Array.isArray(data?.transactions) ? data.transactions : [];

  const voidedUuids = new Set();
  for (const txn of transactions) {
    const head = txn?.head || {};
    const voidedUuid = head?.voidedTrUuid;
    if (voidedUuid) voidedUuids.add(voidedUuid);
  }

  let totalRevenue = 0;
  const items = Object.create(null);

  for (const txn of transactions) {
    const head = txn?.head || {};
    const uuid = head?.uuid;
    if (!uuid || head?.trainingFlag) continue;
    if (voidedUuids.has(uuid)) continue;
    if (head?.typeCode !== '00') continue;

    const netTotal = transactionNetTotal(txn);
    if (netTotal <= 0) continue;

    const lineRecords = extractTransactionItems(txn);
    if (!lineRecords.length) continue;

    const baseTotal = lineRecords.reduce((sum, record) => sum + record.revenue, 0);
    const scale = baseTotal > 0 ? netTotal / baseTotal : 0;

    for (const record of lineRecords) {
      const scaledRevenue = scale ? record.revenue * scale : 0;
      if (scaledRevenue <= 0) continue;
      const skuKey = String(record.sku);
      if (!items[skuKey]) {
        items[skuKey] = { sku: record.sku, name: record.name, revenue: 0, quantity: 0 };
      }
      const bucket = items[skuKey];
      bucket.revenue += scaledRevenue;
      bucket.quantity += record.quantity;
      if (!bucket.name && record.name) bucket.name = record.name;
    }

    totalRevenue += netTotal;
  }

  return { totalRevenue, items };
}

function transactionNetTotal(transaction={}){
  const lineItems = Array.isArray(transaction?.lineItems) ? transaction.lineItems : [];
  let total = 0;
  for (const line of lineItems) {
    if (line?.typeCode !== '07') continue;
    const netValue = line?.amounts?.taxSalesNetAmount;
    if (netValue == null) continue;
    const numeric = Number(netValue);
    if (!Number.isFinite(numeric)) continue;
    total += numeric / 1000.0;
  }
  return total;
}

function extractTransactionItems(transaction={}){
  const lineItems = Array.isArray(transaction?.lineItems) ? transaction.lineItems : [];
  const voidedSequences = collectVoidedSequences(lineItems);

  const baseLines = new Map();
  const taxPercentMap = new Map();

  lineItems.forEach((line, index) => {
    if (line?.typeCode !== '00') return;
    let seq = line?.sequenceNumber;
    if (seq == null) seq = index + 1;
    const seqInt = parseInt(seq, 10);
    if (!Number.isFinite(seqInt)) return;
    if (voidedSequences.has(seqInt)) return;
    const flags = line?.flags || {};
    if (flags?.isVoidFlag) return;

    const related = line?.related || {};
    const sku = related?.itemSku;
    const skuInt = parseInt(sku, 10);
    if (!Number.isFinite(skuInt)) return;

    const amounts = line?.amounts || {};
    let qtyVal = amounts?.quantity;
    if (!(typeof qtyVal === 'number')) qtyVal = amounts?.units;
    const quantity = qtyFromThousandths(qtyVal);
    const extras = line?.extras || {};
    const name = extras?.itemName || extras?.itemShortName || `SKU ${skuInt}`;

    baseLines.set(seqInt, {
      sku: skuInt,
      name,
      quantity,
      net: netRevenueFromAmounts(amounts),
    });
    taxPercentMap.set(seqInt, amounts?.taxPercent);
  });

  for (const line of lineItems) {
    if (line?.typeCode !== '11') continue;
    const extras = line?.extras || {};
    const target = extras?.associatedLineItemSequenceNumber;
    if (target == null) continue;
    const targetSeq = parseInt(target, 10);
    if (!Number.isFinite(targetSeq)) continue;
    const baseInfo = baseLines.get(targetSeq);
    if (!baseInfo) continue;
    const amounts = line?.amounts || {};
    const newAmount = amounts?.newAmount;
    if (newAmount == null) continue;
    const taxPercent = taxPercentMap.get(targetSeq);
    if (taxPercent == null) continue;
    baseInfo.net = netFromGross(newAmount, taxPercent);
  }

  const records = [];
  for (const [, baseInfo] of baseLines.entries()) {
    const netRevenue = Number(baseInfo?.net ?? 0);
    if (!Number.isFinite(netRevenue) || netRevenue <= 0) continue;
    const quantity = Number(baseInfo?.quantity ?? 0);
    records.push({
      sku: Number(baseInfo?.sku),
      name: String(baseInfo?.name || ''),
      revenue: netRevenue,
      quantity,
    });
  }
  return records;
}

function collectVoidedSequences(lineItems){
  const voided = new Set();
  for (const line of lineItems) {
    const extras = line?.extras || {};
    const targetSeq = extras?.voidedLineItemSequenceNumber;
    if (targetSeq != null) {
      const seqInt = parseInt(targetSeq, 10);
      if (Number.isFinite(seqInt)) voided.add(seqInt);
    }
    const flags = line?.flags || {};
    if (flags?.isVoidFlag) {
      const seq = line?.sequenceNumber;
      const seqInt = parseInt(seq, 10);
      if (Number.isFinite(seqInt)) voided.add(seqInt);
    }
  }
  return voided;
}

function netRevenueFromAmounts(amounts){
  if (!amounts || typeof amounts !== 'object') return 0;
  let value = amounts?.actualNetAmount;
  if (value == null) {
    const candidate = amounts?.regularNetAmount;
    if (candidate == null) {
      return netFromGross(amounts?.regularAmount, amounts?.taxPercent);
    }
    value = candidate;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return netFromGross(amounts?.regularAmount, amounts?.taxPercent);
  }
  return numeric / 1000.0;
}

function netFromGross(value, taxPercent){
  if (value == null) return 0;
  const gross = Number(value);
  if (!Number.isFinite(gross)) return 0;
  const grossValue = gross / 1000.0;
  let taxRate = 0;
  if (taxPercent != null) {
    const taxNumeric = Number(taxPercent);
    taxRate = Number.isFinite(taxNumeric) ? taxNumeric / 100000.0 : 0;
  }
  return grossValue / (1 + taxRate);
}

function qtyFromThousandths(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num / 1000.0;
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
    const singleDate = normDate(q.date || q.day || null);
    if (singleDate) {
      from = singleDate;
      to = singleDate;
    }
    if(!from || !to){
      const now = new Date();
      const y = now.getFullYear();
      from = `${y}-01-01`;
      const M=String(now.getMonth()+1).padStart(2,'0'); const D=String(now.getDate()).padStart(2,'0');
      to = `${y}-${M}-${D}`;
    }
    if(from>to) [from,to]=[to,from];

    // Period-level transaction summary
    const periodId = q.periodId || q.period || null;
    if (periodId) {
      if(!CFG.xToken || !CFG.businessId){
        return err(400,'CONFIG_MISSING','Missing Lightspeed env vars (X_TOKEN or BUSINESS_ID)');
      }
      let periodData;
      try {
        periodData = await fetchPeriodTransactions(periodId);
      } catch (e) {
        const status = e?.status || 502;
        return err(status, 'PERIOD_FETCH_FAIL', String(e.message || e), { details: e?.body, periodId: String(periodId) });
      }
      const summary = summarizePeriodSalesFromData(periodData || {});
      const itemsArray = Object.values(summary.items || {}).map(entry => ({
        sku: entry.sku,
        name: entry.name,
        revenue: Number(entry.revenue || 0),
        quantity: Number(entry.quantity || 0),
      }));
      itemsArray.sort((a,b)=> b.revenue - a.revenue);
      const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
      return ok({
        mode: 'period',
        periodId: String(periodId),
        totalRevenue: Number(summary.totalRevenue || 0),
        itemCount: itemsArray.length,
        items: itemsArray,
        top: itemsArray.slice(0, limit)
      });
    }

    // Special: demo data
    if(q.demo==='1'){
      const toDate = normDate(to) || normDate(new Date());
      const baseDay = toDate ? new Date(`${toDate}T00:00:00`) : new Date();
      const demoReceipts = Array.from({length:7}).map((_,i)=>{
        const day = new Date(baseDay);
        day.setDate(day.getDate()-i);
        const iso = formatDateKey(day);
        return {
          id:1000+i,
          businessDay: iso,
          guestCount: Math.round(Math.random()*60+200),
          items:[
            { productId: 1, productName:'Pils 0.5', quantity: Math.round(Math.random()*20+5), amount: Math.round(Math.random()*4000+500) },
            { productId: 2, productName:'IPA 0.5',  quantity: Math.round(Math.random()*12+3), amount: Math.round(Math.random()*3000+300) },
            { productId: 3, productName:'Cider',    quantity: Math.round(Math.random()*10+1), amount: Math.round(Math.random()*2000+200) },
          ]
        };
      });
      const top = aggregateTopProducts(demoReceipts, metric);
      const daily = summarizeReceiptsByDay(demoReceipts);
      const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
      return ok({ from, to, endpoint, count: demoReceipts.length, top: top.slice(0,limit), daily });
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
    const includeDaily = singleDate || q.group === 'daily' || q.daily === '1';
    const daily = includeDaily ? summarizeReceiptsByDay(receipts) : undefined;
    let dayTotal = null;
    if (singleDate) {
      const match = (daily || []).find((d) => d.date === singleDate);
      dayTotal = match || { date: singleDate, revenue: 0, guests: 0, receipts: 0 };
    }
    return ok({ from, to, endpoint, count: receipts.length, top: top.slice(0,limit), daily, dayTotal });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};

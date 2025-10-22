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


const BUSINESS_PERIODS_ENDPOINT = 'transaction/v3.0/business_periods';

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
function buildApiUrl(path){
  return new URL(path.replace(/^\/+/, ''), CFG.baseUrl);
}

async function fetchTransactionsRange({ from, to, maxPeriods = 60, concurrency = 6 }){
  const baseHeaders = authHeaders();
  const headerOptions = headerVariants(baseHeaders);
  const periodsUrl = buildApiUrl(BUSINESS_PERIODS_ENDPOINT);
  if (from) periodsUrl.searchParams.set('start', from);
  if (to) periodsUrl.searchParams.set('end', to);

  let periodsData = null;
  let lastErr = null;
  for (const hdr of headerOptions) {
    try {
      periodsData = await fetchJson(periodsUrl.toString(), hdr);
      break;
    } catch (error) {
      lastErr = error;
    }
  }
  if (!periodsData) {
    throw lastErr || new Error('Failed to fetch business periods');
  }

  const periods = Array.isArray(periodsData?.businessPeriods) ? periodsData.businessPeriods : [];
  const filteredPeriods = periods
    .filter((period) => {
      const day = period?.businessDay;
      if (!day) return false;
      return (!from || day >= from) && (!to || day <= to);
    })
    .sort((a, b) => a.businessDay?.localeCompare(b.businessDay));

  const limitedPeriods = filteredPeriods.slice(-maxPeriods);
  const transactions = [];

  for (let index = 0; index < limitedPeriods.length; index += concurrency) {
    const chunk = limitedPeriods.slice(index, index + concurrency);
    const chunkResults = await Promise.all(chunk.map(async (period) => {
      const periodId = period?.periodId;
      if (!periodId) return null;
      const txUrl = buildApiUrl(`transaction/v3.0/transactions/${periodId}`);
      let txData = null;
      for (const hdr of headerOptions) {
        try {
          txData = await fetchJson(txUrl.toString(), hdr);
          break;
        } catch (error) {
          lastErr = error;
        }
      }
      if (txData && Array.isArray(txData.transactions)) {
        txData.transactions.forEach((tx) => {
          if (!tx.head) tx.head = {};
          if (!tx.head.businessDay && period.businessDay) tx.head.businessDay = period.businessDay;
        });
        return txData.transactions;
      }
      return [];
    }));
    chunkResults.forEach((list) => {
      if (Array.isArray(list)) transactions.push(...list);
    });
  }

  if (!transactions.length && lastErr) {
    throw lastErr;
  }

  return transactions;
}

// Extract line items from a Lightspeed Restaurant/Gastrofix receipt object
function extractLines(receipt){
  const lines = receipt?.lineItems || receipt?.items || receipt?.positions || receipt?.lines || [];
  if(Array.isArray(lines)) return lines;
  // Some APIs wrap in { items: { data: [...] } }
  if (lines && Array.isArray(lines.data)) return lines.data;
  return [];
}

function pickLineName(line){
  return line?.extras?.itemName || line?.productName || line?.name || line?.title || line?.articleName || 'Ukjent';
}

function pickLineId(line){
  return line?.related?.itemSku || line?.productId || line?.articleId || line?.id || null;
}

function pickQty(line){
  const qty = Number(line?.amounts?.quantity ?? line?.quantity ?? line?.qty ?? 0);
  const units = Number(line?.amounts?.units ?? 1000);
  if (Number.isFinite(qty) && Number.isFinite(units) && units !== 0) {
    return qty / units;
  }
  const n = Number(line?.quantity ?? line?.qty ?? 1);
  return Number.isFinite(n) ? n : 1;
}

function pickRevenue(line){
  const n = Number(
    line?.amounts?.actualNetAmount ??
    line?.amounts?.regularNetAmount ??
    line?.amount ??
    line?.grossAmount ??
    line?.totalPrice ??
    line?.priceTotal ??
    0
  );
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

function buildDateFromDayAndTime(dayStr, timeValue){
  const base = normDate(dayStr) || null;
  if (!base) return null;
  if (timeValue == null) return null;
  let timeStr = String(timeValue).trim();
  if (!timeStr) return null;
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(timeStr)) {
    if (timeStr.length === 5) timeStr = `${timeStr}:00`;
  } else if (/^\d{4}$/.test(timeStr)) {
    timeStr = `${timeStr.slice(0,2)}:${timeStr.slice(2,4)}:00`;
  } else if (/^\d{6}$/.test(timeStr)) {
    timeStr = `${timeStr.slice(0,2)}:${timeStr.slice(2,4)}:${timeStr.slice(4,6)}`;
  } else {
    return null;
  }
  const dateTime = new Date(`${base}T${timeStr}`);
  return Number.isNaN(dateTime.getTime()) ? null : dateTime;
}

function pickTransactionDateTime(transaction){
  if (!transaction || typeof transaction !== 'object') return null;
  const head = transaction?.head || {};
  const candidates = [
    head?.receiptDateTime,
    head?.closeDateTime,
    head?.businessDateTime,
    head?.paymentDateTime,
    head?.cashPointCloseDateTime,
    head?.periodEndTime,
    head?.periodStartTime,
    head?.created,
    head?.updated,
    transaction?.createdAt,
    transaction?.updatedAt,
    transaction?.timestamp,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeDateValue(candidate);
    if (parsed) return parsed;
  }
  if (head?.businessDay) {
    const timeCandidates = [
      head?.businessTime,
      head?.closeTime,
      head?.startTime,
      head?.endTime,
      head?.periodStart,
      head?.periodEnd,
    ];
    for (const timeCandidate of timeCandidates) {
      const merged = buildDateFromDayAndTime(head.businessDay, timeCandidate);
      if (merged) return merged;
    }
    const fallback = normalizeDateValue(head.businessDay);
    if (fallback) return fallback;
  }
  const fromReceipt = pickReceiptDate(transaction);
  return fromReceipt || null;
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
  const dailyTotals = new Map();

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

    const dateObj = pickReceiptDate(txn);
    const dayKey = dateObj ? formatDateKey(dateObj) : (head?.businessDay || null);
    if (dayKey) {
      const bucket = dailyTotals.get(dayKey) || { date: dayKey, revenue: 0, guests: 0, receipts: 0 };
      bucket.revenue += netTotal;
      const guests = Number(
        head?.guestCount ??
        head?.covers ??
        head?.customerCount ??
        head?.customers ??
        0
      );
      if (Number.isFinite(guests) && guests > 0) bucket.guests += guests;
      bucket.receipts += 1;
      dailyTotals.set(dayKey, bucket);
    }

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

  return {
    totalRevenue,
    items,
    daily: Array.from(dailyTotals.values()).sort((a,b)=> b.date.localeCompare(a.date))
  };
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

function extractLineCost(amounts = {}, extras = {}){
  const amountCandidates = [
    amounts?.actualCostAmount,
    amounts?.costAmount,
    amounts?.regularCostAmount,
    amounts?.purchaseNetAmount,
    amounts?.grossPurchaseAmount,
  ];
  for (const candidate of amountCandidates) {
    const num = Number(candidate);
    if (Number.isFinite(num) && num !== 0) {
      return num / 1000.0;
    }
  }
  const extraCandidates = [
    extras?.itemCost,
    extras?.recipeCost,
    extras?.ingredientCost,
    extras?.cost,
    extras?.primeCost,
    extras?.portionCost,
  ];
  for (const candidate of extraCandidates) {
    if (candidate == null) continue;
    const num = Number(candidate);
    if (!Number.isFinite(num)) continue;
    if (Math.abs(num) > 1000) return num / 1000.0;
    return num;
  }
  return 0;
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
      cost: extractLineCost(amounts, extras),
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
    const costValue = Number(baseInfo?.cost ?? 0);
    records.push({
      sku: Number(baseInfo?.sku),
      name: String(baseInfo?.name || ''),
      revenue: netRevenue,
      quantity,
      cost: Number.isFinite(costValue) ? costValue : 0,
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

function addDays(date, days){
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function makeProductKey(record){
  if (record == null || typeof record !== 'object') return 'unknown';
  if (record.sku != null && Number.isFinite(Number(record.sku))) {
    return `sku:${Number(record.sku)}`;
  }
  const name = String(record.name || '').trim().toLowerCase();
  return name ? `name:${name}` : 'unknown';
}

function percentChange(current, previous){
  const curr = Number(current);
  const prev = Number(previous);
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) {
    if (curr === 0) return 0;
    return null;
  }
  return (curr - prev) / Math.abs(prev);
}

function formatHourSlot(hour){
  if (!Number.isFinite(hour)) return 'kl. ?.00';
  const start = Math.max(0, Math.min(23, Math.trunc(hour)));
  const end = (start + 1) % 24;
  const pad = (n) => String(n).padStart(2, '0');
  return `kl. ${pad(start)}–${pad(end)}`;
}

function buildAiInsightContext(transactions, targetDateKey, { compareOffset = 7 } = {}){
  const targetDateObj = new Date(`${targetDateKey}T00:00:00`);
  if (Number.isNaN(targetDateObj.getTime())) {
    return {
      targetDateKey,
      targetDateObj: null,
      compareDateKey: null,
      compareDateObj: null,
      dayTotals: new Map(),
      productByDate: new Map(),
      productTotals: new Map(),
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, receipts: 0 })),
    };
  }

  const compareDateObj = addDays(targetDateObj, -compareOffset);
  const compareDateKey = formatDateKey(compareDateObj);

  const dayTotals = new Map();
  const productByDate = new Map();
  const productTotals = new Map();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, revenue: 0, receipts: 0 }));

  const voidedUuids = new Set();
  for (const txn of transactions) {
    const maybeUuid = txn?.head?.voidedTrUuid;
    if (maybeUuid) voidedUuids.add(maybeUuid);
  }

  for (const txn of transactions) {
    const head = txn?.head || {};
    const uuid = head?.uuid;
    if (!uuid || head?.trainingFlag) continue;
    if (voidedUuids.has(uuid)) continue;
    if (head?.typeCode !== '00') continue;

    const netTotal = transactionNetTotal(txn);
    if (netTotal <= 0) continue;

    const lineRecords = extractTransactionItems(txn) || [];
    if (!lineRecords.length) continue;

    const baseTotal = lineRecords.reduce((sum, record) => sum + (Number(record?.revenue) || 0), 0);
    const scale = baseTotal > 0 ? netTotal / baseTotal : 0;

    const dateObj = pickReceiptDate(txn);
    const dayKey = dateObj ? formatDateKey(dateObj) : (head?.businessDay || null);
    if (!dayKey) continue;

    const guests = Number(
      head?.guestCount ??
      head?.covers ??
      head?.customerCount ??
      head?.customers ??
      head?.persons ??
      0
    );
    const dayBucket = dayTotals.get(dayKey) || { date: dayKey, revenue: 0, receipts: 0, guests: 0, transactions: 0 };
    dayBucket.revenue += netTotal;
    dayBucket.receipts += 1;
    dayBucket.transactions += 1;
    if (Number.isFinite(guests) && guests > 0) dayBucket.guests += guests;
    dayTotals.set(dayKey, dayBucket);

    if (dayKey === targetDateKey) {
      const timestamp = pickTransactionDateTime(txn);
      if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) {
        const hour = timestamp.getHours();
        if (hour >= 0 && hour < 24) {
          const bucket = hourly[hour];
          bucket.revenue += netTotal;
          bucket.receipts += 1;
        }
      }
    }

    let productMap = productByDate.get(dayKey);
    if (!productMap) {
      productMap = new Map();
      productByDate.set(dayKey, productMap);
    }

    for (const record of lineRecords) {
      const rawRevenue = Number(record?.revenue || 0);
      if (!Number.isFinite(rawRevenue) || rawRevenue <= 0) continue;
      const scaledRevenue = scale ? rawRevenue * scale : rawRevenue;
      const quantity = Number(record?.quantity || 0);
      const rawCost = Number(record?.cost || 0);
      const scaledCost = rawCost > 0 ? (scale ? rawCost * scale : rawCost) : 0;
      const key = makeProductKey(record);
      const existing = productMap.get(key) || {
        key,
        sku: record?.sku ?? null,
        name: record?.name || 'Ukjent',
        revenue: 0,
        quantity: 0,
        cost: 0,
        margin: 0,
      };
      existing.revenue += scaledRevenue;
      existing.quantity += quantity;
      if (scaledCost > 0) existing.cost += scaledCost;
      existing.margin = existing.revenue - existing.cost;
      productMap.set(key, existing);

      const totalExisting = productTotals.get(key) || {
        key,
        sku: existing.sku,
        name: existing.name,
        revenue: 0,
        quantity: 0,
        cost: 0,
        margin: 0,
        daySet: new Set(),
      };
      totalExisting.revenue += scaledRevenue;
      totalExisting.quantity += quantity;
      if (scaledCost > 0) totalExisting.cost += scaledCost;
      totalExisting.margin = totalExisting.revenue - totalExisting.cost;
      totalExisting.daySet.add(dayKey);
      productTotals.set(key, totalExisting);
    }
  }

  return {
    targetDateKey,
    targetDateObj,
    compareDateKey,
    compareDateObj,
    dayTotals,
    productByDate,
    productTotals,
    hourly,
  };
}

function computeRecurringStandout(context, { limit = 4 } = {}){
  const { targetDateObj, productByDate, productTotals } = context;
  if (!(targetDateObj instanceof Date) || Number.isNaN(targetDateObj.getTime())) return null;
  const weekday = targetDateObj.getDay();
  const entries = Array.from(productByDate.entries())
    .filter(([dateKey]) => {
      const parsed = new Date(`${dateKey}T00:00:00`);
      return !Number.isNaN(parsed.getTime()) && parsed.getDay() === weekday;
    })
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limit);

  if (!entries.length) return null;

  const stats = new Map();
  for (const [, productMap] of entries) {
    productMap.forEach((value, key) => {
      const bucket = stats.get(key) || {
        key,
        name: value?.name || 'Ukjent',
        revenue: 0,
        quantity: 0,
        occurrences: 0,
      };
      bucket.revenue += Number(value?.revenue || 0);
      bucket.quantity += Number(value?.quantity || 0);
      bucket.occurrences += 1;
      stats.set(key, bucket);
    });
  }

  const ranked = Array.from(stats.values())
    .filter((entry) => entry.occurrences > 0 && entry.revenue > 0)
    .map((entry) => {
      const total = productTotals.get(entry.key);
      const dayCount = total?.daySet instanceof Set ? total.daySet.size : 0;
      const otherOccurrences = dayCount > entry.occurrences ? (dayCount - entry.occurrences) : 0;
      const otherRevenue = (total?.revenue ?? 0) - entry.revenue;
      const otherAvg = otherOccurrences > 0 ? otherRevenue / otherOccurrences : null;
      const avgRevenue = entry.revenue / entry.occurrences;
      const lift = otherAvg && otherAvg > 0 ? (avgRevenue - otherAvg) / otherAvg : null;
      return {
        ...entry,
        avgRevenue,
        otherAvg,
        lift,
      };
    })
    .sort((a, b) => {
      if (Number.isFinite(b.lift) && Number.isFinite(a.lift) && b.lift !== a.lift) return b.lift - a.lift;
      if (b.avgRevenue !== a.avgRevenue) return b.avgRevenue - a.avgRevenue;
      return b.revenue - a.revenue;
    });

  return ranked[0] || null;
}

function generateInsightCards(context){
  const {
    targetDateObj,
    compareDateObj,
    targetDateKey,
    compareDateKey,
    dayTotals,
    productByDate,
    productTotals,
    hourly,
  } = context;

  const moneyFmt = new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
  const percentFmt = new Intl.NumberFormat('nb-NO', { style: 'percent', maximumFractionDigits: 0 });
  const weekdayLong = (targetDateObj instanceof Date && !Number.isNaN(targetDateObj.getTime()))
    ? new Intl.DateTimeFormat('nb-NO', { weekday: 'long' }).format(targetDateObj)
    : '';
  const weekdayPrev = (compareDateObj instanceof Date && !Number.isNaN(compareDateObj.getTime()))
    ? new Intl.DateTimeFormat('nb-NO', { weekday: 'long' }).format(compareDateObj)
    : '';
  const comparisonLabel = weekdayPrev ? `forrige ${weekdayPrev}` : 'forrige uke';

  const describeChangeFull = (change) => {
    if (!Number.isFinite(change)) return null;
    if (change === 0) return `På nivå vs ${comparisonLabel}`;
    const formatted = percentFmt.format(Math.abs(change));
    return `${change > 0 ? 'Opp' : 'Ned'} ${formatted} vs ${comparisonLabel}`;
  };

  const describeChangeShort = (current, previous) => {
    if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
    if (previous === 0) {
      if (current === 0) return '0 %';
      return 'ny';
    }
    const change = percentChange(current, previous);
    if (!Number.isFinite(change)) return null;
    if (change === 0) return '0 %';
    const formatted = percentFmt.format(Math.abs(change));
    return `${change > 0 ? '+' : '−'}${formatted}`;
  };

  const currentProducts = productByDate.get(targetDateKey) || new Map();
  const compareProducts = productByDate.get(compareDateKey) || new Map();
  const cards = [];
  const recurring = computeRecurringStandout(context, { limit: 5 });

  const topArray = Array.from(currentProducts.values()).filter((item) => (item?.revenue || 0) > 0)
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
  const topSelection = topArray.slice(0, 3);
  const topCurrentRevenue = topSelection.reduce((sum, item) => sum + (item.revenue || 0), 0);
  const topPreviousRevenue = topSelection.reduce((sum, item) => {
    const comp = compareProducts.get(item.key || makeProductKey(item));
    return sum + (comp?.revenue || 0);
  }, 0);

  if (topSelection.length) {
    const products = topSelection.map((item) => {
      const comp = compareProducts.get(item.key || makeProductKey(item));
      const previousRevenue = Number(comp?.revenue || 0);
      return {
        name: item.name,
        revenue: Number(item.revenue || 0),
        quantity: Number(item.quantity || 0),
        previousRevenue,
        change: percentChange(item.revenue || 0, previousRevenue),
        changeLabel: describeChangeShort(item.revenue || 0, previousRevenue),
      };
    });

    let summary = null;
    if (topPreviousRevenue === 0) {
      summary = topCurrentRevenue > 0 ? `Nytt salg vs ${comparisonLabel}` : 'Ingen salg i begge perioder';
    } else {
      summary = describeChangeFull(percentChange(topCurrentRevenue, topPreviousRevenue));
    }
    if (!summary) summary = 'Toppomsetning i dag.';

    let recommendation = `Fremhev ${products.map((p) => p.name).join(', ')}.`;
    if (recurring && recurring.occurrences >= 2 && Number.isFinite(recurring.lift) && recurring.lift > 0.05) {
      const liftText = percentFmt.format(recurring.lift);
      recommendation += ` ${recurring.name} gir ${liftText} mer på ${weekdayLong}.`;
    }

    cards.push({
      kind: 'top-products',
      title: 'Mest solgte produkter',
      summary,
      recommendation,
      products,
      comparisonLabel,
    });
  } else {
    cards.push({
      kind: 'status',
      title: 'Mest solgte produkter',
      summary: 'Ingen salg funnet for valgt dato – verifiser Lightspeed-integrasjonen.',
    });
  }

  const bottomArray = Array.from(currentProducts.values())
    .filter((item) => (item?.revenue || 0) > 0)
    .sort((a, b) => (a.revenue || 0) - (b.revenue || 0));
  const bottomSelection = bottomArray.slice(0, 3);
  const bottomCurrent = bottomSelection.reduce((sum, item) => sum + (item.revenue || 0), 0);
  const bottomPrevious = bottomSelection.reduce((sum, item) => {
    const comp = compareProducts.get(item.key || makeProductKey(item));
    return sum + (comp?.revenue || 0);
  }, 0);

  if (bottomSelection.length) {
    const products = bottomSelection.map((item) => {
      const comp = compareProducts.get(item.key || makeProductKey(item));
      const previousRevenue = Number(comp?.revenue || 0);
      return {
        name: item.name,
        revenue: Number(item.revenue || 0),
        quantity: Number(item.quantity || 0),
        previousRevenue,
        change: percentChange(item.revenue || 0, previousRevenue),
        changeLabel: describeChangeShort(item.revenue || 0, previousRevenue),
      };
    });

    let summary = null;
    if (bottomPrevious === 0) {
      summary = bottomCurrent > 0 ? `Nytt salg vs ${comparisonLabel}` : 'Ingen salg registrert enda';
    } else {
      summary = describeChangeFull(percentChange(bottomCurrent, bottomPrevious));
    }
    if (!summary) summary = `Følg opp ${products.map((p) => p.name).join(', ')}.`;

    const bottomChange = percentChange(bottomCurrent, bottomPrevious);
    const directive = bottomChange != null && bottomChange < -0.05
      ? 'Vurder menyjustering eller kampanje i rushtiden.'
      : 'Gi personalet et mål om mersalg på disse rettene.';

    cards.push({
      kind: 'bottom-products',
      title: 'Minst solgte produkter',
      summary,
      recommendation: directive,
      products,
      comparisonLabel,
    });
  } else {
    cards.push({
      kind: 'status',
      title: 'Minst solgte produkter',
      summary: 'Ingen svake produkter registrert – bruk rommet til å teste sesongvarer.',
    });
  }

  const targetTotals = dayTotals.get(targetDateKey) || { revenue: 0, receipts: 0, guests: 0 };
  const compareTotals = dayTotals.get(compareDateKey) || { revenue: 0, receipts: 0, guests: 0 };
  const revenueChange = percentChange(targetTotals.revenue, compareTotals.revenue);
  const receiptsChange = percentChange(targetTotals.receipts, compareTotals.receipts);

  const salesSummaryParts = [];
  const revenueSummary = describeChangeFull(revenueChange);
  if (revenueSummary) salesSummaryParts.push(`Omsetning: ${revenueSummary}`);
  const receiptsSummary = describeChangeFull(receiptsChange);
  if (receiptsSummary) salesSummaryParts.push(`Kvitteringer: ${receiptsSummary}`);
  const salesSummary = salesSummaryParts.join(' • ') || 'Ingen referansedata tilgjengelig.';

  const avgTicketCurrent = targetTotals.receipts > 0 ? targetTotals.revenue / targetTotals.receipts : null;
  const avgTicketPrev = compareTotals.receipts > 0 ? compareTotals.revenue / compareTotals.receipts : null;
  const avgTicketChange = percentChange(avgTicketCurrent, avgTicketPrev);

  let salesRecommendation = 'Fortsett med dagens tiltak.';
  if (revenueChange != null && revenueChange < -0.05) {
    salesRecommendation = 'Planlegg en kampanje for å løfte trafikken igjen.';
  } else if (receiptsChange != null && receiptsChange < -0.05 && (avgTicketChange == null || avgTicketChange <= 0)) {
    salesRecommendation = `Aktiver kundeklubb eller SMS-invitasjon før neste ${weekdayLong || 'uke'}.`;
  } else if (revenueChange != null && revenueChange > 0.05) {
    salesRecommendation = 'Sikre nok bemanning og råvarer til kveldstoppen.';
  }

  cards.push({
    kind: 'sales-trend',
    title: 'Salgsutvikling',
    summary: salesSummary,
    recommendation: salesRecommendation,
    metrics: {
      revenue: {
        current: Number(targetTotals.revenue || 0),
        previous: Number(compareTotals.revenue || 0),
        change: revenueChange,
      },
      receipts: {
        current: Number(targetTotals.receipts || 0),
        previous: Number(compareTotals.receipts || 0),
        change: receiptsChange,
      },
    },
    comparisonLabel,
  });

  const busiest = hourly.reduce((best, slot) => (slot.revenue > best.revenue ? slot : best), { hour: 0, revenue: -1, receipts: 0 });
  let quietest = null;
  for (const slot of hourly) {
    if (!quietest || slot.revenue < quietest.revenue) {
      quietest = slot;
    }
  }

  if (busiest && busiest.revenue > 0 && quietest) {
    const busyLabel = formatHourSlot(busiest.hour);
    const quietLabel = formatHourSlot(quietest.hour);
    const quietDirective = quietest.revenue > 0 ? 'Styrk mersalget i denne timen.' : 'Bruk timen til happy hour eller prep.';

    cards.push({
      kind: 'busy-hours',
      title: 'Tidsanalyse',
      summary: `Travlest: ${busyLabel} (${moneyFmt.format(busiest.revenue)}) • Roligst: ${quietLabel} (${moneyFmt.format(Math.max(0, quietest.revenue))})`,
      recommendation: quietDirective,
      slots: {
        busiest: { ...busiest, label: busyLabel },
        quietest: { ...quietest, label: quietLabel },
      },
    });
  } else {
    cards.push({
      kind: 'status',
      title: 'Tidsanalyse',
      summary: 'Ingen timefordeling tilgjengelig – sikre at kvitteringstid lagres i Lightspeed.',
    });
  }

  const marginCandidates = topArray.filter((item) => (item.cost || 0) > 0 && (item.revenue || 0) > 0)
    .sort((a, b) => (b.margin || 0) - (a.margin || 0));
  const worstMarginSorted = [...marginCandidates].sort((a, b) => (a.margin || 0) - (b.margin || 0));

  if (marginCandidates.length) {
    const best = marginCandidates[0];
    const worst = worstMarginSorted[0] || best;
    const bestMarginValue = Number(best.margin || 0);
    const worstMarginValue = Number(worst.margin || 0);

    cards.push({
      kind: 'margin',
      title: 'Dekningsbidrag',
      summary: `Høyest margin: ${best.name} (${moneyFmt.format(bestMarginValue)}) • Lavest: ${worst.name} (${moneyFmt.format(worstMarginValue)})`,
      recommendation: `Fremhev ${best.name}; vurder pris eller tilbehør på ${worst.name}.`,
      products: {
        best: {
          name: best.name,
          margin: bestMarginValue,
          revenue: Number(best.revenue || 0),
          quantity: Number(best.quantity || 0),
        },
        worst: {
          name: worst.name,
          margin: worstMarginValue,
          revenue: Number(worst.revenue || 0),
          quantity: Number(worst.quantity || 0),
        },
      },
    });
  } else {
    cards.push({
      kind: 'status',
      title: 'Dekningsbidrag',
      summary: 'Ingen varekost registrert – legg inn kostpriser for å få lønnsomhetstips.',
    });
  }

  if (avgTicketCurrent != null) {
    const averageSummary = describeChangeFull(percentChange(avgTicketCurrent, avgTicketPrev));
    const receiptsSummary = describeChangeFull(receiptsChange);
    const ticketSummaryParts = [];
    ticketSummaryParts.push(`Snittkvittering: ${moneyFmt.format(avgTicketCurrent)}${averageSummary ? ` (${averageSummary})` : ''}`);
    if (receiptsSummary) ticketSummaryParts.push(`Kvitteringer: ${receiptsSummary}`);

    let ticketRecommendation = (avgTicketChange != null && avgTicketChange < 0)
      ? 'Be teamet anbefale dessert eller drikke etter hovedrett.'
      : 'Fortsett mersalgsfokuset etter kl. 19.';

    if (recurring && recurring.occurrences >= 2 && Number.isFinite(recurring.lift) && recurring.lift > 0.05) {
      const liftText = percentFmt.format(recurring.lift);
      ticketRecommendation += ` Planlegg ${recurring.name} på ${weekdayLong} – ${liftText} høyere salg enn ellers.`;
    }

    cards.push({
      kind: 'ticket',
      title: 'Kvitteringsanalyse',
      summary: ticketSummaryParts.join(' • '),
      recommendation: ticketRecommendation,
      metrics: {
        averageTicket: {
          current: avgTicketCurrent,
          previous: Number(avgTicketPrev || 0),
          change: percentChange(avgTicketCurrent, avgTicketPrev),
        },
        receipts: {
          current: Number(targetTotals.receipts || 0),
          previous: Number(compareTotals.receipts || 0),
          change: receiptsChange,
        },
      },
      pattern: recurring ? {
        name: recurring.name,
        occurrences: recurring.occurrences,
        lift: recurring.lift,
        avgRevenue: recurring.avgRevenue,
        weekday: weekdayLong,
      } : null,
      comparisonLabel,
    });
  } else {
    cards.push({
      kind: 'status',
      title: 'Kvitteringsanalyse',
      summary: 'Manglende kvitteringsdata – kontroller at rapportene henter customerCount og totals.',
    });
  }

  return cards.slice(0, 6);
}

function dayTotalsToPlain(entry){
  if (!entry) return null;
  return {
    date: entry.date,
    revenue: Number(entry.revenue || 0),
    receipts: Number(entry.receipts || 0),
    guests: Number(entry.guests || 0),
    transactions: Number(entry.transactions || entry.receipts || 0),
  };
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

    const insightsRequested = q.insights === '1' || q.insights === 'true' || q.ai === '1';
    if (insightsRequested) {
      const targetDateKey = singleDate || to;
      if (!targetDateKey) {
        return err(400, 'BAD_REQUEST', 'Insights krever en dato.');
      }
      const targetDateObj = new Date(`${targetDateKey}T00:00:00`);
      if (Number.isNaN(targetDateObj.getTime())) {
        return err(400, 'BAD_DATE', `Ugyldig dato: ${targetDateKey}`);
      }
      const compareDateObj = addDays(targetDateObj, -7);
      const compareDateKey = formatDateKey(compareDateObj);

      if (q.demo === '1') {
        const weekday = new Intl.DateTimeFormat('nb-NO', { weekday: 'long' }).format(targetDateObj);
        const prevWeekday = new Intl.DateTimeFormat('nb-NO', { weekday: 'long' }).format(compareDateObj);
        const comparisonLabel = `forrige ${prevWeekday}`;
        const demoInsights = [
          {
            kind: 'top-products',
            title: 'Mest solgte produkter',
            summary: `Opp 12 % vs ${comparisonLabel}`,
            recommendation: 'Fremhev Burger 180g, Pasta Alfredo og Husets IPA.',
            products: [
              { name: 'Burger 180g', revenue: 48650, quantity: 68, previousRevenue: 43500, change: 0.12, changeLabel: '+12 %' },
              { name: 'Pasta Alfredo', revenue: 31890, quantity: 44, previousRevenue: 29200, change: 0.092, changeLabel: '+9 %' },
              { name: 'Husets IPA', revenue: 27440, quantity: 86, previousRevenue: 25100, change: 0.093, changeLabel: '+9 %' },
            ],
            comparisonLabel,
          },
          {
            kind: 'bottom-products',
            title: 'Minst solgte produkter',
            summary: `Ned 18 % vs ${comparisonLabel}`,
            recommendation: 'Gi personalet et mersalgsmål på disse rettene.',
            products: [
              { name: 'Vegansk salat', revenue: 6240, quantity: 12, previousRevenue: 7600, change: -0.179, changeLabel: '−18 %' },
              { name: 'Focaccia', revenue: 5820, quantity: 18, previousRevenue: 7200, change: -0.191, changeLabel: '−19 %' },
              { name: 'Mineralvann', revenue: 5480, quantity: 34, previousRevenue: 6680, change: -0.18, changeLabel: '−18 %' },
            ],
            comparisonLabel,
          },
          {
            kind: 'sales-trend',
            title: 'Salgsutvikling',
            summary: `Omsetning: Opp 8 % vs ${comparisonLabel} • Kvitteringer: Opp 5 % vs ${comparisonLabel}`,
            recommendation: 'Sikre nok bemanning og råvarer til kveldstoppen.',
            metrics: {
              revenue: { current: 186500, previous: 172400, change: 0.081 },
              receipts: { current: 410, previous: 390, change: 0.051 },
            },
            comparisonLabel,
          },
          {
            kind: 'busy-hours',
            title: 'Tidsanalyse',
            summary: 'Travlest: kl. 18–19 (kr 42 800) • Roligst: kl. 15–16 (kr 6 200)',
            recommendation: 'Bruk den rolige timen til happy hour.',
            slots: {
              busiest: { hour: 18, revenue: 42800, receipts: 68, label: 'kl. 18–19' },
              quietest: { hour: 15, revenue: 6200, receipts: 11, label: 'kl. 15–16' },
            },
          },
          {
            kind: 'margin',
            title: 'Dekningsbidrag',
            summary: 'Høyest margin: Entrecôte (kr 145) • Lavest: Nachos (kr 42)',
            recommendation: 'Fremhev Entrecôte; vurder pris eller tilbehør på Nachos.',
            products: {
              best: { name: 'Entrecôte', margin: 145, revenue: 32500, quantity: 22 },
              worst: { name: 'Nachos', margin: 42, revenue: 9800, quantity: 28 },
            },
          },
          {
            kind: 'ticket',
            title: 'Kvitteringsanalyse',
            summary: `Snittkvittering: kr 472 (Opp 6 % vs ${comparisonLabel}) • Kvitteringer: Opp 5 % vs ${comparisonLabel}`,
            recommendation: `Følg opp dessertanbefalinger etter kl. 19. Planlegg Taco Tuesday – ${comparisonLabel.includes('tirsdag') ? 'gir 18 % mer salg.' : 'gir 18 % mer salg.'}`,
            metrics: {
              averageTicket: { current: 472, previous: 446, change: 0.058 },
              receipts: { current: 410, previous: 390, change: 0.051 },
            },
            pattern: {
              name: 'Taco Tuesday',
              occurrences: 4,
              lift: 0.18,
              avgRevenue: 14800,
              weekday: weekday,
            },
            comparisonLabel,
          },
        ];

        return ok({
          mode: 'demo',
          date: targetDateKey,
          compareDate: compareDateKey,
          insights: demoInsights,
          totals: {
            current: { revenue: 186500, receipts: 410, guests: 372, transactions: 410 },
            compare: { revenue: 172400, receipts: 390, guests: 355, transactions: 390 },
          },
        });
      }

      if(!CFG.xToken || !CFG.businessId){
        return err(400,'CONFIG_MISSING','Missing Lightspeed env vars (X_TOKEN or BUSINESS_ID)');
      }

      const insightsFromDate = addDays(targetDateObj, -35);
      const insightsFrom = formatDateKey(insightsFromDate);
      let transactionsForInsights;
      try {
        transactionsForInsights = await fetchTransactionsRange({ from: insightsFrom, to: targetDateKey, maxPeriods: 90 });
      } catch (e) {
        const status = e?.status || 502;
        return err(status, 'TRANSACTIONS_FAIL', String(e.message || e), {
          details: e?.body,
          endpoint: BUSINESS_PERIODS_ENDPOINT,
        });
      }

      const context = buildAiInsightContext(transactionsForInsights, targetDateKey, { compareOffset: 7 });
      const insights = generateInsightCards(context);
      return ok({
        date: targetDateKey,
        compareDate: context.compareDateKey,
        insights,
        totals: {
          current: dayTotalsToPlain(context.dayTotals.get(targetDateKey)),
          compare: dayTotalsToPlain(context.dayTotals.get(context.compareDateKey)),
        }
      });
    }

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
      const items = aggregateTopProducts(demoReceipts, metric);
      const daily = summarizeReceiptsByDay(demoReceipts);
      const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
      const dayTotal = singleDate ? (daily.find((d) => d.date === singleDate) || { date: singleDate, revenue: 0, guests: 0, receipts: 0 }) : undefined;
      return ok({ from, to, endpoint: BUSINESS_PERIODS_ENDPOINT, count: demoReceipts.length, top: items.slice(0,limit), items, daily, dayTotal, mode: 'demo' });
    }

    if(!CFG.xToken || !CFG.businessId){
      return err(400,'CONFIG_MISSING','Missing Lightspeed env vars (X_TOKEN or BUSINESS_ID)');
    }

    // Fetch transactions and aggregate
    let transactions;
    try{
      const fromDateObj = from ? normalizeDateValue(from) : null;
      const toDateObj = to ? normalizeDateValue(to) : null;
      const daySpan = (() => {
        if (fromDateObj && toDateObj) {
          const diff = Math.floor((toDateObj - fromDateObj) / 86400000) + 1;
          if (Number.isFinite(diff) && diff > 0) return diff;
        }
        return 30;
      })();
      const requestedWindow = Number(q.window || q.days || q.maxPeriods || '') || null;
      const maxPeriods = Math.max(14, Math.min(90, requestedWindow || daySpan));
      transactions = await fetchTransactionsRange({ from, to, maxPeriods });
    }catch(e){
      const status = e?.status || 502;
      return err(status, 'TRANSACTIONS_FAIL', String(e.message||e), {
        details: e?.body,
        endpoint: BUSINESS_PERIODS_ENDPOINT
      });
    }

    const summary = summarizePeriodSalesFromData({ transactions });
    const itemsArray = Object.values(summary.items || {}).map(entry => ({
      sku: entry.sku,
      name: entry.name,
      revenue: Number(entry.revenue || 0),
      quantity: Number(entry.quantity || 0),
    }));
    const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
    itemsArray.sort(metric === 'qty'
      ? (a, b) => b.quantity - a.quantity
      : (a, b) => b.revenue - a.revenue
    );

    const includeDaily = singleDate || q.group === 'daily' || q.daily === '1';
    const daily = includeDaily ? (summary.daily || []) : undefined;
    let dayTotal = null;
    if (singleDate) {
      const match = (daily || []).find((d) => d.date === singleDate);
      dayTotal = match || { date: singleDate, revenue: 0, guests: 0, receipts: 0 };
    }

    return ok({
      from,
      to,
      endpoint: BUSINESS_PERIODS_ENDPOINT,
      count: transactions.length,
      top: itemsArray.slice(0, limit),
      items: itemsArray,
      totalRevenue: Number(summary.totalRevenue || 0),
      daily,
      dayTotal
    });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};

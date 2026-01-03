// Netlify Function: Lightspeed (Gastrofix) proxy + top products
// Env vars (configure in Netlify):
// - LIGHTSPEED_GASTROFIX_BASE_URL (default: https://no.gastrofix.com/api/)
// - LIGHTSPEED_X_TOKEN (required)
// - LIGHTSPEED_BUSINESS_ID (required)
// - LIGHTSPEED_OPERATOR (optional; for some endpoints)

const fs = require('fs');
const path = require('path');

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const CACHE_TIMEZONE = process.env.CACHED_TIMEZONE || 'Europe/Oslo';
const osloHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: CACHE_TIMEZONE, hour: '2-digit', hour12: false });
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

let cachedDailyDataset = null;
let cachedDailyDatasetMtime = 0;

function resolveCachedDatasetDir(){
  const override = process.env.CACHED_DATASET_DIR;
  if (override && fs.existsSync(override)) return override;
  const cwdPath = path.join(process.cwd(), '.netlify', 'cached-dataset-all');
  if (fs.existsSync(cwdPath)) return cwdPath;
  const localPath = path.resolve(__dirname, '..', '..', '.netlify', 'cached-dataset-all');
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

function loadCachedDailyDataset(){
  const dir = resolveCachedDatasetDir();
  if (!dir) return null;
  const file = path.join(dir, 'daily-2025.json');
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (cachedDailyDataset && cachedDailyDatasetMtime === stat.mtimeMs) return cachedDailyDataset;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.data)) return null;
    cachedDailyDataset = parsed;
    cachedDailyDatasetMtime = stat.mtimeMs;
    return parsed;
  } catch (_) {
    return null;
  }
}

function hourFromTimestamp(timestamp){
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  const hour = Number(osloHourFmt.format(parsed));
  return Number.isFinite(hour) ? hour : null;
}

function hourFromRow(row){
  if (!row) return null;
  const hourValue = row.hour ?? row.hr ?? row.h;
  if (hourValue != null) {
    if (typeof hourValue === 'number' && Number.isFinite(hourValue)) {
      return Math.max(0, Math.min(23, Math.floor(hourValue)));
    }
    const hourPart = String(hourValue).split('T')[1] || '';
    const hour = Number(hourPart.slice(0, 2));
    if (Number.isFinite(hour)) return hour;
  }
  return hourFromTimestamp(row.timestamp || row.time || row.ts || null);
}

function buildHourlySeries(entry){
  const timeline = entry?.timeline;
  if (Array.isArray(timeline) && timeline.length) {
    const series = Array.from({ length: 24 }, () => 0);
    timeline.forEach((row) => {
      const hour = hourFromRow(row);
      if (hour == null) return;
      const numeric = Number(row?.net_total ?? row?.total ?? row?.amount ?? 0);
      if (!Number.isFinite(numeric)) return;
      series[hour] += numeric;
    });
    const hasValues = series.some((value) => Number(value) > 0);
    if (hasValues) return series;
  }
  const totals = entry?.hourly_totals;
  if (!totals || typeof totals !== 'object') return null;
  const series = Array.from({ length: 24 }, () => 0);
  Object.entries(totals).forEach(([key, value]) => {
    const hourPart = String(key).split('T')[1] || '';
    const hour = Number(hourPart.slice(0, 2));
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    series[hour] += numeric;
  });
  const hasValues = series.some((value) => Number(value) > 0);
  return hasValues ? series : null;
}

function normalizeCachedDailyEntry(entry){
  if (!entry || !entry.date) return null;
  const receipts = Array.isArray(entry.timeline) ? entry.timeline.length : 0;
  return {
    date: entry.date,
    revenue: Number(entry.total || 0),
    guests: 0,
    receipts,
  };
}

function itemsFromEntry(entry){
  const items = entry?.items || {};
  return Object.entries(items).map(([sku, item]) => ({
    sku,
    name: item?.name || String(sku),
    revenue: Number(item?.revenue || 0),
    quantity: Number(item?.quantity || 0),
  }));
}

function aggregateItemsFromEntries(entries){
  const map = new Map();
  entries.forEach((entry) => {
    const items = entry?.items || {};
    Object.entries(items).forEach(([sku, item]) => {
      const revenue = Number(item?.revenue || 0);
      const quantity = Number(item?.quantity || 0);
      const existing = map.get(sku) || { sku, name: item?.name || String(sku), revenue: 0, quantity: 0 };
      existing.revenue += Number.isFinite(revenue) ? revenue : 0;
      existing.quantity += Number.isFinite(quantity) ? quantity : 0;
      if (!existing.name && item?.name) existing.name = item.name;
      map.set(sku, existing);
    });
  });
  return Array.from(map.values());
}

function buildCachedPayload({ from, to, singleDate, limit, metric, includeDaily }){
  const dataset = loadCachedDailyDataset();
  const entries = Array.isArray(dataset?.data) ? dataset.data : [];
  if (!entries.length) return null;

  const fromKey = from || '0000-00-00';
  const toKey = to || '9999-99-99';
  const filtered = entries.filter((entry) => entry?.date && entry.date >= fromKey && entry.date <= toKey);
  if (!filtered.length && !singleDate) return null;
  const latestEntry = entries.reduce((latest, entry) => {
    if (!entry?.date) return latest;
    if (!latest || entry.date > latest.date) return entry;
    return latest;
  }, null);

  const comparisonDate = singleDate ? shiftIsoDate(singleDate, -7) : null;
  let daily = includeDaily
    ? filtered.map(normalizeCachedDailyEntry).filter(Boolean)
    : undefined;

  const hourlyByDay = includeDaily ? {} : undefined;
  if (includeDaily) {
    filtered.forEach((entry) => {
      const hourly = buildHourlySeries(entry);
      if (hourly) hourlyByDay[entry.date] = hourly;
    });
  }

  const dayEntry = singleDate ? entries.find((entry) => entry?.date === singleDate) : null;
  const fallbackEntry = singleDate && !dayEntry ? latestEntry : null;
  const resolvedDate = fallbackEntry ? fallbackEntry.date : null;
  const daySource = dayEntry || fallbackEntry;
  if (includeDaily && daySource?.date && hourlyByDay && !hourlyByDay[daySource.date]) {
    const fallbackSeries = buildHourlySeries(daySource);
    if (fallbackSeries) hourlyByDay[daySource.date] = fallbackSeries;
  }
  if (includeDaily && daySource && Array.isArray(daily) && !daily.length) {
    const fallbackDaily = normalizeCachedDailyEntry(daySource);
    if (fallbackDaily) daily = [fallbackDaily];
  }
  const dayReceipts = daySource && Array.isArray(daySource.timeline) ? daySource.timeline.length : 0;
  const dayTotal = singleDate ? {
    date: daySource?.date || singleDate,
    revenue: Number(daySource?.total || 0),
    guests: 0,
    receipts: dayReceipts,
    hourly: (hourlyByDay && daySource?.date) ? hourlyByDay[daySource.date] : buildHourlySeries(daySource),
  } : undefined;

  const itemsBase = singleDate ? (daySource ? itemsFromEntry(daySource) : []) : aggregateItemsFromEntries(filtered);
  const sortedItems = itemsBase.slice().sort((a, b) => {
    if (metric === 'qty') return b.quantity - a.quantity;
    return b.revenue - a.revenue;
  });

  const totalRevenue = filtered.reduce((sum, entry) => {
    const value = Number(entry?.total || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0) || (daySource ? Number(daySource.total || 0) : 0);
  const count = filtered.reduce((sum, entry) => {
    const receipts = Array.isArray(entry?.timeline) ? entry.timeline.length : 0;
    return sum + receipts;
  }, 0) || (daySource ? dayReceipts : 0);

  return {
    from,
    to,
    comparisonDate,
    count,
    top: sortedItems.slice(0, limit),
    items: sortedItems,
    totalRevenue,
    daily,
    hourlyByDay,
    dayTotal,
    resolvedDate,
    mode: 'cached',
    statusMessage: 'Using cached dataset',
  };
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

function normalizeHourValue(value){
  if (value == null) return null;
  if (value instanceof Date) {
    const hours = value.getHours();
    return Number.isFinite(hours) ? hours : null;
  }
  if (typeof value === 'number') {
    if (value >= 0 && value < 24) return Math.floor(value);
    if (value >= 24 && value < 2400) return Math.floor(value / 100);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/(\d{1,2})(?::\d{2})?/);
    if (match) {
      const hour = Number(match[1]);
      if (hour >= 0 && hour < 24) return hour;
    }
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length >= 2) {
      const hour = Number(digits.slice(0, 2));
      if (hour >= 0 && hour < 24) return hour;
    }
  }
  return null;
}

function seededNoise(seed, index = 0){
  const key = `${seed || 'seed'}:${index}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const sine = Math.sin(hash) * 10000;
  return sine - Math.floor(sine);
}

function buildHourlyProfile(total=0, { seed='default', weekend=false, lateRush=false } = {}){
  const baseWeights = [
    0,0,0,0,0,0,
    0.005,0.01,
    0.02,0.045,0.075,0.08,
    0.07,0.065,0.06,0.055,
    0.05,0.065,0.08,0.085,
    0.07,0.04,0.02,0.01
  ];
  const adjusted = baseWeights.map((weight, hour) => {
    if (weight === 0) return 0;
    const noise = 0.78 + seededNoise(seed, hour) * 0.44; // 0.78–1.22
    let value = weight * noise;
    if (weekend && hour >= 10 && hour <= 20) value *= 1.12;
    if (!weekend && hour < 8) value *= 0.75;
    if (lateRush && hour >= 19 && hour <= 22) value *= 1.25;
    return value;
  });
  const sum = adjusted.reduce((acc,val)=>acc+val,0);
  const safeTotal = Math.max(0, Number(total) || 0);
  if (!(safeTotal > 0) || !(sum > 0)) return Array.from({ length: 24 }, () => 0);
  return adjusted.map((weight)=> Math.max(0, Math.round((safeTotal * weight) / sum)));
}

function formatDateKey(date){
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

function shiftIsoDate(iso, deltaDays){
  if (!iso || !Number.isFinite(Number(deltaDays))) return null;
  const base = normalizeDateValue(iso);
  if (!base) return null;
  const shifted = new Date(base);
  shifted.setDate(shifted.getDate() + Number(deltaDays));
  return formatDateKey(shifted);
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
  const hourlyTotals = new Map();

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

    if (dayKey) {
      let hourIndex = dateObj ? dateObj.getHours() : null;
      if (hourIndex == null) {
        hourIndex = normalizeHourValue(
          head?.businessTime ??
          head?.receiptTime ??
          head?.time ??
          head?.timestamp ??
          null
        );
      }
      if (!(Number.isFinite(hourIndex) && hourIndex >= 0 && hourIndex < 24)) {
        hourIndex = null;
      }
      if (hourIndex != null) {
        const safeHour = Math.floor(hourIndex);
        const hourlySeries = hourlyTotals.get(dayKey) || Array.from({ length: 24 }, () => 0);
        hourlySeries[safeHour] += netTotal;
        hourlyTotals.set(dayKey, hourlySeries);
      }
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

  const hourlyByDay = {};
  hourlyTotals.forEach((series, key) => {
    hourlyByDay[key] = series.map((value) => Number((value || 0).toFixed(2)));
  });

  return {
    totalRevenue,
    items,
    daily: Array.from(dailyTotals.values()).sort((a,b)=> b.date.localeCompare(a.date)),
    hourlyByDay
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

    const metric = (q.metric === 'qty') ? 'qty' : 'revenue';
    const limit = Math.max(1, Math.min(50, Number(q.limit || 3) | 0));
    // Allow operator override via query for troubleshooting
    if (q.operator) CFG.operator = String(q.operator);

    // Dates
    let from = normDate(q.from || q.start);
    let to   = normDate(q.to || q.end);
    const singleDate = normDate(q.date || q.day || null);
    let comparisonDate = null;
    if (singleDate) {
      comparisonDate = shiftIsoDate(singleDate, -7);
      from = comparisonDate || singleDate;
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
      const items = aggregateTopProducts(demoReceipts, metric);
      const daily = summarizeReceiptsByDay(demoReceipts);
      const hourlyByDay = daily.reduce((acc, entry) => {
        const dateObj = normalizeDateValue(entry.date);
        const day = dateObj ? dateObj.getDay() : null;
        const weekend = day === 0 || day === 6;
        const lateRush = day === 5 || day === 6;
        acc[entry.date] = buildHourlyProfile(entry.revenue, { seed: entry.date, weekend, lateRush });
        return acc;
      }, {});
      const limit = Math.max(1, Math.min(50, Number(q.limit||3)|0));
      const dayTotal = singleDate ? ((daily.find((d) => d.date === singleDate) || { date: singleDate, revenue: 0, guests: 0, receipts: 0 })) : undefined;
      if (dayTotal && hourlyByDay[dayTotal.date]) {
        dayTotal.hourly = hourlyByDay[dayTotal.date];
      }
      return ok({ from, to, comparisonDate, endpoint: BUSINESS_PERIODS_ENDPOINT, count: demoReceipts.length, top: items.slice(0,limit), items, daily, hourlyByDay, dayTotal, mode: 'demo' });
    }

    const includeDaily = Boolean(singleDate || q.group === 'daily' || q.daily === '1');
    const cachedPayload = buildCachedPayload({ from, to, singleDate, limit, metric, includeDaily });
    if (cachedPayload && (!CFG.xToken || !CFG.businessId || q.cache === '1')) {
      return ok(cachedPayload);
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
      const cachedFallback = buildCachedPayload({ from, to, singleDate, limit, metric, includeDaily });
      if (cachedFallback) return ok(cachedFallback);
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
    itemsArray.sort(metric === 'qty'
      ? (a, b) => b.quantity - a.quantity
      : (a, b) => b.revenue - a.revenue
    );

    const daily = includeDaily ? (summary.daily || []) : undefined;
    let dayTotal = null;
    if (singleDate) {
      const match = (daily || []).find((d) => d.date === singleDate);
      const baseTotal = match || { date: singleDate, revenue: 0, guests: 0, receipts: 0 };
      dayTotal = { ...baseTotal };
      if (summary.hourlyByDay && summary.hourlyByDay[singleDate]) {
        dayTotal.hourly = summary.hourlyByDay[singleDate];
      }
    }

    return ok({
      from,
      to,
      comparisonDate,
      endpoint: BUSINESS_PERIODS_ENDPOINT,
      count: transactions.length,
      top: itemsArray.slice(0, limit),
      items: itemsArray,
      totalRevenue: Number(summary.totalRevenue || 0),
      daily,
      hourlyByDay: summary.hourlyByDay,
      dayTotal
    });
  }catch(e){
    return err(500,'UNEXPECTED', String(e.message||e));
  }
};

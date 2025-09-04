#!/usr/bin/env node
/**
 * Lightspeed (Gastrofix) Top Products CLI
 *
 * Usage examples:
 *   node scripts/lightspeed-top.js --from 2024-08-01 --to 2024-08-31 --limit 3 --use-function
 *   node scripts/lightspeed-top.js --from 2024-08-01 --to 2024-08-31 --limit 5
 *
 * If --use-function (or env USE_FUNCTION=1) is set, calls the Netlify function
 * at BASE_URL (default http://localhost:8888) -> /.netlify/functions/lightspeed
 *
 * Otherwise, calls Lightspeed API directly using env vars:
 *   LIGHTSPEED_GASTROFIX_BASE_URL, LIGHTSPEED_X_TOKEN, LIGHTSPEED_BUSINESS_ID, LIGHTSPEED_OPERATOR
 */

const { URL } = require('url');
const https = require('https');

function hasFetch(){ return typeof fetch === 'function'; }
function httpGet(url, headers={}){
  if (hasFetch()) return fetch(url, { headers }).then(async r=>{
    const txt = await r.text();
    let j = null; try{ j = JSON.parse(txt); }catch{}
    if(!r.ok){ const e = new Error(`HTTP_${r.status}`); e.status=r.status; e.body=j||txt; throw e; }
    return j;
  });
  return new Promise((resolve, reject)=>{
    const u = new URL(url);
    const opts = { method:'GET', headers };
    const req = https.request({ hostname:u.hostname, path:u.pathname+u.search, protocol:u.protocol, port:u.port || 443, method:'GET', headers }, res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', ()=>{
        if(res.statusCode < 200 || res.statusCode >= 300){ const e=new Error(`HTTP_${res.statusCode}`); e.status=res.statusCode; e.body=body; return reject(e);} 
        try{ resolve(JSON.parse(body)); } catch{ resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function parseArgs(argv){
  const out = { limit:3, metric:'revenue', useFunction:false, baseUrl: process.env.BASE_URL || 'http://localhost:8888' };
  for(let i=2;i<argv.length;i++){
    const a = argv[i];
    const [k,v] = a.startsWith('--') ? [a.slice(2), argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : ''] : [a, ''];
    switch(k){
      case 'from': out.from=v; break;
      case 'to': out.to=v; break;
      case 'limit': out.limit = Number(v)||3; break;
      case 'metric': out.metric = (v==='qty'?'qty':'revenue'); break;
      case 'endpoint': out.endpoint = v; break;
      case 'use-function': out.useFunction = true; break;
      case 'base-url': out.baseUrl = v; break;
      default: break;
    }
  }
  if(process.env.USE_FUNCTION==='1') out.useFunction = true;
  return out;
}

function normDate(s){
  if(!s) return null; s=String(s).trim();
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d=new Date(s); if(!Number.isNaN(d.getTime())){ const y=d.getFullYear(),M=String(d.getMonth()+1).padStart(2,'0'),D=String(d.getDate()).padStart(2,'0'); return `${y}-${M}-${D}`;}
  return null;
}

function authHeaders(){
  const h = { 'Accept':'application/json' };
  if(process.env.LIGHTSPEED_X_TOKEN) h['X-Token'] = process.env.LIGHTSPEED_X_TOKEN;
  if(process.env.LIGHTSPEED_BUSINESS_ID) h['X-Business-Id'] = process.env.LIGHTSPEED_BUSINESS_ID;
  if(process.env.LIGHTSPEED_OPERATOR) h['X-Operator-Id'] = process.env.LIGHTSPEED_OPERATOR;
  return h;
}

function buildReceiptsUrl(base, endpoint, from, to, page=0, size=200){
  const u = new URL(endpoint.replace(/^\/+|\/+$/g,''), base.endsWith('/')?base:base+'/');
  u.searchParams.set('start', from); u.searchParams.set('end', to);
  u.searchParams.set('page', String(page)); u.searchParams.set('size', String(size));
  return u.toString();
}
function buildReceiptsUrlAlt(base, endpoint, from, to, page=0, size=200){
  const u = new URL(endpoint.replace(/^\/+|\/+$/g,''), base.endsWith('/')?base:base+'/');
  u.searchParams.set('from', from); u.searchParams.set('to', to);
  u.searchParams.set('page', String(page)); u.searchParams.set('size', String(size));
  return u.toString();
}

async function fetchReceiptsRangeDirect({ from, to, endpoint }){
  const base = (process.env.LIGHTSPEED_GASTROFIX_BASE_URL || 'https://no.gastrofix.com/api/');
  const headers = authHeaders();
  const items = [];
  let page = 0; const size = 200; const ep = endpoint || 'reports/v3.0/receipts';
  for(let i=0;i<20;i++){
    let url = buildReceiptsUrl(base, ep, from, to, page, size);
    let data, ok = false;
    try{ data = await httpGet(url, headers); ok = true; }
    catch(e1){ try{ url = buildReceiptsUrlAlt(base, ep, from, to, page, size); data = await httpGet(url, headers); ok = true; } catch(e2){ if(page===0) throw e2; }}
    if(!ok) break;
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.values) ? data.values : Array.isArray(data?.receipts) ? data.receipts : Array.isArray(data) ? data : [];
    items.push(...arr);
    const total = (data?.totalElements ?? data?.total ?? null);
    const hasMore = arr.length === size || (typeof total==='number' && (page+1)*size < total);
    if(!hasMore) break; page++;
  }
  return items;
}

function extractLines(r){ const lines=r?.items||r?.positions||r?.lines||[]; return Array.isArray(lines)?lines:(lines?.data||[]); }
function pickLineName(l){ return l?.productName||l?.name||l?.title||l?.articleName||'Ukjent'; }
function pickLineId(l){ return l?.productId||l?.articleId||l?.id||null; }
function pickQty(l){ const n=Number(l?.quantity??l?.qty??1); return Number.isFinite(n)?n:1; }
function pickRevenue(l){ const n=Number(l?.amount??l?.grossAmount??l?.totalPrice??l?.priceTotal??0); return Number.isFinite(n)?n:0; }
function aggregateTopProducts(receipts, metric='revenue'){
  const map = new Map();
  for(const r of receipts){ for(const ln of extractLines(r)){ const id=pickLineId(ln), name=pickLineName(ln), key=`${id??name}`; const prev=map.get(key)||{id,name,qty:0,revenue:0}; prev.qty+=pickQty(ln); prev.revenue+=pickRevenue(ln); map.set(key,prev);} }
  const arr = Array.from(map.values()); arr.sort(metric==='qty'?(a,b)=>b.qty-a.qty:(a,b)=>b.revenue-a.revenue); return arr;
}

async function viaFunction({ from, to, metric, limit, endpoint, baseUrl }){
  const u = new URL('/.netlify/functions/lightspeed', baseUrl);
  u.searchParams.set('from', from); u.searchParams.set('to', to);
  u.searchParams.set('metric', metric); u.searchParams.set('limit', String(limit));
  if(endpoint) u.searchParams.set('endpoint', endpoint);
  const data = await httpGet(u.toString(), { 'accept':'application/json' });
  if(!data || !Array.isArray(data.top)) throw new Error('Unexpected response from function');
  return data.top;
}

async function main(){
  const args = parseArgs(process.argv);
  let from = normDate(args.from); let to = normDate(args.to);
  if(!from || !to){
    const now = new Date(); const y = now.getFullYear();
    from = `${y}-01-01`; const M=String(now.getMonth()+1).padStart(2,'0'); const D=String(now.getDate()).padStart(2,'0'); to = `${y}-${M}-${D}`;
  }
  if(from>to) [from,to] = [to,from];

  let top;
  if(args.useFunction){
    top = await viaFunction({ from, to, metric:args.metric, limit:args.limit, endpoint:args.endpoint, baseUrl: args.baseUrl });
  } else {
    if(!process.env.LIGHTSPEED_X_TOKEN || !process.env.LIGHTSPEED_BUSINESS_ID){
      console.error('Missing env: LIGHTSPEED_X_TOKEN and LIGHTSPEED_BUSINESS_ID');
      console.error('Either set them, or pass --use-function and run `netlify dev`.');
      process.exit(2);
    }
    const receipts = await fetchReceiptsRangeDirect({ from, to, endpoint: args.endpoint });
    top = aggregateTopProducts(receipts, args.metric).slice(0, Math.max(1, Math.min(50, args.limit|0)));
  }

  // Print
  const money = new Intl.NumberFormat('nb-NO', { style:'currency', currency:'NOK', maximumFractionDigits:0 });
  console.log(`Lightspeed Top ${top.length} produkter (${from} .. ${to})`);
  console.log('---------------------------------------------');
  top.forEach((t,i)=>{
    const rank = String(i+1).padStart(2,'0');
    const name = String(t.name || 'Ukjent');
    const qty = Number(t.qty || 0);
    const rev = Number(t.revenue || 0);
    console.log(`#${rank}  ${name}  x${qty}  ${money.format(rev)}`);
  });
}

main().catch(e=>{ console.error('Error:', e?.message||e); if(e?.body) console.error('Details:', typeof e.body==='string'?e.body:JSON.stringify(e.body)); process.exit(1); });


// server.mjs — IaLife Backend (timezone-aware HORÁRIO)
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());

const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/Sao_Paulo';

// -------- CORS --------
const allowOriginEnv = process.env.ALLOW_ORIGIN || '';
const allowed = allowOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && allowed.includes(o)) {
    res.header('Access-Control-Allow-Origin', o);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
const SIGNAL_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_QUOTE_ACTIVES  = 10;

let SDKModule = null, sdk = null, connected = false, lastError = null;
let demoMode = (process.env.DEMO_MODE || '').trim() === '1';
let pairsCache = [];
let allowedTickersSet = new Set();
let demoTimer = null;

let tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0 };

const sseClients = new Set();
const SSE_PING_MS = 15000;
function sseSend(res, payload, eventName='message'){ res.write(`event: ${eventName}\n`); res.write(`data: ${JSON.stringify(payload)}\n\n`); }
function broadcastSignal(sig){ for (const r of sseClients){ try{ sseSend(r, sig, 'signal'); }catch{} } }
setInterval(()=>{ for (const r of sseClients){ try{ sseSend(r, { t: Date.now() }, 'ping'); }catch{} } }, SSE_PING_MS);

const log=(...a)=>console.log('[IaLife]',...a);
const errlog=(...a)=>console.error('[IaLife][ERR]',...a);
const pad2=(n)=>String(n).padStart(2,'0');

function envView(){ return { DISPLAY_TZ, WS_URL:process.env.WS_URL, HTTP_HOST:process.env.HTTP_HOST, PLATFORM_ID:process.env.PLATFORM_ID, DEMO_MODE: demoMode?'1':'0' }; }

// TZ formatter HH:MM
function fmtHHMM(dateOrTs){
  const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs);
  return new Intl.DateTimeFormat('pt-BR', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone: DISPLAY_TZ }).format(d);
}

function computeCandleWindow(nowDate){
  const now = nowDate instanceof Date ? nowDate : new Date();
  const nextMinuteStart = new Date(Math.ceil(now.getTime() / 60000) * 60000);
  const validUntil = new Date(nextMinuteStart.getTime() + 2 * 60000);
  return { entryAt: nextMinuteStart, validUntil };
}

const priceBuffers = new Map();
const lastSignalAt = new Map();
function sma(arr, len){ if (!arr || arr.length < len) return null; let s=0; for (let i=arr.length-len;i<arr.length;i++) s+=arr[i]; return s/len; }
function pushPrice(activeId, price, maxLen=50){ const buf=priceBuffers.get(activeId)||[]; buf.push(price); if (buf.length>maxLen) buf.shift(); priceBuffers.set(activeId, buf); return buf; }
function probFromDistance(p, avg){ const dist=Math.abs((p-avg)/avg); let base=40+Math.min(50,Math.round(dist*10000)); if (base>90) base=90; if (base<40) base=40; return base; }

function maybeReleaseTradeLock(){
  if (tradeLock.locked && Date.now() >= tradeLock.validUntil){
    tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0 };
    log('Trade lock liberado.');
  }
}
function acquireTradeLock(name, id, entryAt, validUntil){
  tradeLock = { locked:true, active:name, activeId:id, openedAt:Date.now(), expiresAt: validUntil.getTime(), entryAt: entryAt.getTime(), validUntil: validUntil.getTime() };
  log('Trade lock até', validUntil.toISOString(), 'para', name);
}

async function loadSdkIfPossible(){
  if (SDKModule || demoMode) return !!SDKModule;
  try { SDKModule = await import('@quadcode-tech/client-sdk-js'); log('SDK importado.'); return true; }
  catch(e){ demoMode=true; lastError='sdk_import_failed'; errlog('Import SDK falhou → DEMO', e?.message || e); return false; }
}

async function loadBinaryDigitalTickers(currentSdk){
  const all = new Set();
  const now = currentSdk.currentTime ? currentSdk.currentTime() : new Date();
  const sources = [
    { name:'binary',  getter: () => currentSdk.binaryOptions?.() },
    { name:'digital', getter: () => currentSdk.digitalOptions?.() },
  ];
  for (const src of sources){
    try{
      const m = await src.getter();
      if (m && typeof m.getActives === 'function'){
        const actives = m.getActives().filter(a => a.canBeBoughtAt(now));
        for (const a of actives) all.add(a.ticker || (`ACTIVE_${a.id}`));
        log(`Ativos ${src.name}:`, actives.length);
      }
    }catch(e){ errlog(`Erro lendo ${src.name}:`, e?.message || e); }
  }
  return all;
}

async function wireQuoteSignals(currentSdk){
  const quotes = await currentSdk.quotes();
  const bo = await currentSdk.blitzOptions();
  const now = currentSdk.currentTime ? currentSdk.currentTime() : new Date();
  const actives = bo.getActives().filter(a => a.canBeBoughtAt(now));

  const filtered = actives.filter(a => allowedTickersSet.has(a.ticker || (`ACTIVE_${a.id}`))).slice(0, MAX_QUOTE_ACTIVES);
  log('Assinando', filtered.length, 'ativos (Blitz ∩ Bin/Digi)');

  for (const a of filtered){
    const activeId = a.id;
    const name = a.ticker || (`ACTIVE_${a.id}`);
    const cq = await quotes.getCurrentQuoteForActive(activeId);

    cq.subscribeOnUpdate((updated) => {
      maybeReleaseTradeLock();
      if (tradeLock.locked) return;

      const price = updated?.quote ?? updated?.value ?? updated?.ask ?? updated?.bid;
      if (typeof price !== 'number') return;

      const buf = pushPrice(activeId, price);
      const avg = sma(buf, 20);
      if (!avg) return;

      const lastAt = lastSignalAt.get(activeId) || 0;
      if (Date.now() - lastAt < SIGNAL_COOLDOWN_MS) return;

      const prev = buf[buf.length - 2];
      if (typeof prev !== 'number') return;

      const crossedUp   = prev < avg && price > avg;
      const crossedDown = prev > avg && price < avg;
      if (!crossedUp && !crossedDown) return;

      lastSignalAt.set(activeId, Date.now());
      if (!allowedTickersSet.has(name)) return;

      const refNow = currentSdk.currentTime ? currentSdk.currentTime() : new Date();
      const { entryAt, validUntil } = computeCandleWindow(refNow);
      acquireTradeLock(name, activeId, entryAt, validUntil);

      const ordem = crossedUp ? 'COMPRA' : 'VENDA';
      const prob  = probFromDistance(price, avg);
      const horario = fmtHHMM(entryAt);

      broadcastSignal({ ativo:name, timeframe:'M1', ordem, horario, prob, entryAt: entryAt.getTime(), validUntil: validUntil.getTime(), candles:2 });
    });
  }

  pairsCache = filtered.map(a => a.ticker || (`ACTIVE_${a.id}`));
}

async function connectReal(){
  await loadSdkIfPossible();
  if (!SDKModule) return { ok:false, error:'sdk_unavailable' };

  const { ClientSdk, LoginPasswordAuthMethod } = SDKModule;
  const WS_URL = process.env.WS_URL;
  const HTTP_HOST = process.env.HTTP_HOST;
  const PLATFORM_ID = Number(process.env.PLATFORM_ID || '0');
  const LOGIN = process.env.ATRIUN_LOGIN;
  const PASSWORD = process.env.ATRIUN_PASSWORD;

  const missing = [];
  if (!WS_URL) missing.push('WS_URL');
  if (!HTTP_HOST) missing.push('HTTP_HOST');
  if (!PLATFORM_ID) missing.push('PLATFORM_ID');
  if (!LOGIN) missing.push('ATRIUN_LOGIN');
  if (!PASSWORD) missing.push('ATRIUN_PASSWORD');
  if (missing.length){ lastError = 'missing_env:' + missing.join(','); return { ok:false, error:lastError }; }

  try{
    sdk = await ClientSdk.create(WS_URL, PLATFORM_ID, new LoginPasswordAuthMethod(HTTP_HOST, LOGIN, PASSWORD));
    connected = true; lastError = null; log('Conectado (real).');

    allowedTickersSet = await loadBinaryDigitalTickers(sdk);
    log('Tickers permitidos:', allowedTickersSet.size);
    if (allowedTickersSet.size === 0){ pairsCache = []; return { ok:true, note:'no_binary_digital_open' }; }

    await wireQuoteSignals(sdk);
    return { ok:true };
  }catch(e){
    connected=false; lastError='connect_failed:'+(e?.message || String(e)); errlog('Erro conectar (real):', e); return { ok:false, error:lastError };
  }
}

function startDemoTicker(){
  stopDemoTicker();
  demoTimer = setInterval(()=>{
    if (!connected) return;
    maybeReleaseTradeLock();
    if (tradeLock.locked) return;

    const base = pairsCache.length ? pairsCache : ['EUR/USD','GBP/USD','USD/JPY'];
    const ativo = base[Math.floor(Math.random()*base.length)];
    const now = new Date();
    const { entryAt, validUntil } = computeCandleWindow(now);
    acquireTradeLock(ativo, null, entryAt, validUntil);

    const prob = 58 + Math.floor(Math.random()*29);
    const horario = fmtHHMM(entryAt);
    broadcastSignal({ ativo, timeframe:'M1', ordem: Math.random()>0.5?'COMPRA':'VENDA', horario, prob, entryAt: entryAt.getTime(), validUntil: validUntil.getTime(), candles:2 });
  }, 20000);
  log('Demo ticker iniciado.');
}
function stopDemoTicker(){ if (demoTimer){ clearInterval(demoTimer); demoTimer=null; log('Demo ticker parado.'); } }

async function connectDemo(){
  connected = true; lastError = null;
  if (allowedTickersSet.size === 0) allowedTickersSet = new Set(['EUR/USD','GBP/USD','USD/JPY']);
  pairsCache = Array.from(allowedTickersSet);
  startDemoTicker();
  return { ok:true, demo:true };
}

app.get('/status', (req,res)=>{
  res.json({ ok:true, connected, lastError, lock: tradeLock, pairs: pairsCache, env: envView() });
});

app.post('/connect', async (req,res)=>{
  if (connected) return res.json({ ok:true, already:true, demo: demoMode, lock: tradeLock });
  const result = demoMode ? await connectDemo() : await connectReal();
  if (!result.ok) { const fb = await connectDemo(); return res.json({ ...fb, fallbackFrom: result.error || 'unknown' }); }
  return res.json({ ...result, lock: tradeLock });
});

app.post('/disconnect', (req,res)=>{
  connected=false; lastError=null;
  if (sdk?.disconnect) try{ sdk.disconnect(); }catch{}
  sdk=null; stopDemoTicker();
  tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0 };
  res.json({ ok:true });
});

app.get('/open-pairs', async (req,res)=>{
  if (!connected) return res.status(400).json({ ok:false, error:'not_connected' });
  return res.json({ ok:true, pairs: pairsCache });
});

app.get('/events', (req,res)=>{
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  log('SSE client +1 total:', sseClients.size);
  sseSend(res, { t: Date.now(), connected }, 'ping');
  req.on('close', ()=>{ sseClients.delete(res); log('SSE client -1 total:', sseClients.size); try{ res.end(); }catch{} });
});

app.get('/', (req,res)=> res.json({ ok:true, service:'IaLife Backend', connected, lastError }) );

app.listen(PORT, ()=>{ log(`Servidor ouvindo :${PORT}`, envView()); });

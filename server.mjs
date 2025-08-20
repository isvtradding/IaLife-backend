// server.mjs — IaLife Backend v2.0
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());

const DISPLAY_TZ = process.env.DISPLAY_TZ || 'America/Sao_Paulo';
const PORT = process.env.PORT || 3000;
const MAX_QUOTE_ACTIVES  = 10;
const MIN_PROB = 55;
const MAX_PROB = 92;

const COOLDOWN_BASE_MIN = Number(process.env.COOLDOWN_BASE_MIN || 2);
const COOLDOWN_BASE_MAX = Number(process.env.COOLDOWN_BASE_MAX || 4);
const COOLDOWN_EXTRA_MIN = Number(process.env.COOLDOWN_EXTRA_MIN || 5);
const COOLDOWN_EXTRA_MAX = Number(process.env.COOLDOWN_EXTRA_MAX || 6);
const COOLDOWN_EXTRA_CHANCE = Number(process.env.COOLDOWN_EXTRA_CHANCE || 0.3);

function rngCooldownMs(){
  const r = Math.random();
  const mins = (r < (1 - COOLDOWN_EXTRA_CHANCE))
    ? (COOLDOWN_BASE_MIN + Math.random()*(COOLDOWN_BASE_MAX-COOLDOWN_BASE_MIN))
    : (COOLDOWN_EXTRA_MIN + Math.random()*(COOLDOWN_EXTRA_MAX-COOLDOWN_EXTRA_MIN));
  return Math.round(mins * 60 * 1000);
}

const allowed = String(process.env.ALLOW_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
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

let SDKModule = null, sdk = null, connected = false, lastError = null;
let demoMode = (process.env.DEMO_MODE || '').trim() === '1';
let pairsCache = [];
let allowedTickersSet = new Set();

let tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0, preOpenAt:0 };
let globalNextAllowedAt = 0;

const latestPrice = new Map();
const priceBuffers = new Map();

const sseClients = new Set();
const SSE_PING_MS = 15000;
function sseSend(res, payload, eventName='message'){ res.write(`event: ${eventName}\n`); res.write(`data: ${JSON.stringify(payload)}\n\n`); }
function sseHello(res){ res.write('retry: 4000\n\n'); }
function broadcast(type, payload){ for (const r of sseClients){ try{ sseSend(r, payload, type); }catch{} } }
function broadcastSignal(sig){ broadcast('signal', sig); }
function broadcastResult(resu){ broadcast('result', resu); }
setInterval(()=>{ for (const r of sseClients){ try{ sseSend(r, { t: Date.now(), nextAllowedAt: globalNextAllowedAt }, 'ping'); }catch{} } }, SSE_PING_MS);

const log=(...a)=>console.log('[IaLife]',...a);
const errlog=(...a)=>console.error('[IaLife][ERR]',...a);

function envView(){ return { DISPLAY_TZ, WS_URL:process.env.WS_URL, HTTP_HOST:process.env.HTTP_HOST, PLATFORM_ID:process.env.PLATFORM_ID, DEMO_MODE: demoMode?'1':'0' }; }

function fmtHHMM(dateOrTs){
  const d = dateOrTs instanceof Date ? dateOrTs : new Date(dateOrTs);
  return new Intl.DateTimeFormat('pt-BR', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone: DISPLAY_TZ }).format(d);
}

function computeOpWindow(nowDate){
  const now = nowDate instanceof Date ? nowDate : new Date();
  const entryAt = new Date(Math.ceil(now.getTime() / 60000) * 60000);
  const preOpenAt = new Date(entryAt.getTime() - 30000);
  const validUntil = new Date(entryAt.getTime() + 60000);
  return { preOpenAt, entryAt, validUntil };
}

function sma(arr, len){
  if (!arr || arr.length < len) return null;
  let s=0; for (let i=arr.length-len;i<arr.length;i++) s+=arr[i];
  return s/len;
}
function stddev(arr, len){
  if (!arr || arr.length < len) return null;
  let m = sma(arr, len); if (m == null) return null;
  let s2 = 0;
  for (let i=arr.length-len;i<arr.length;i++){ const d=arr[i]-m; s2 += d*d; }
  return Math.sqrt(s2/len);
}
function pushPrice(activeId, price, maxLen=180){
  const buf=priceBuffers.get(activeId)||[]; buf.push(price); if (buf.length>maxLen) buf.shift();
  priceBuffers.set(activeId, buf); return buf;
}
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function probFromBuffer(p, buf){
  const avg = sma(buf, 20);
  const st  = stddev(buf, 20);
  if (!avg){
    return clamp(Math.round(57 + Math.random()*25), MIN_PROB, MAX_PROB);
  }
  const dist = Math.abs(p-avg);
  if (st && st>0){
    const sigma = dist / st;
    const scaled = 1 - Math.exp(-0.9 * Math.min(3, sigma));
    let base = MIN_PROB + Math.round(scaled * (MAX_PROB - MIN_PROB));
    base += (Math.random()*6 - 3);
    return clamp(Math.round(base), MIN_PROB, MAX_PROB);
  } else {
    return clamp(Math.round(60 + Math.random()*25), MIN_PROB, MAX_PROB);
  }
}

function maybeReleaseTradeLock(){
  if (tradeLock.locked && Date.now() >= tradeLock.validUntil){
    tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0, preOpenAt:0 };
    log('Trade lock liberado no fim da vela.');
  }
}
function acquireTradeLock(name, id, preOpenAt, entryAt, validUntil){
  tradeLock = {
    locked:true, active:name, activeId:id,
    openedAt:Date.now(), expiresAt: validUntil.getTime(),
    preOpenAt: preOpenAt.getTime(), entryAt: entryAt.getTime(), validUntil: validUntil.getTime()
  };
  log('Trade lock até (fim da vela):', validUntil.toISOString(), 'ativo:', name);
}

function applyCooldownFrom(validUntilMs){
  const cd = rngCooldownMs();
  const next = Math.max(globalNextAllowedAt, validUntilMs + cd);
  globalNextAllowedAt = next;
  log('Cooldown ON → próximo permitido após:', new Date(next).toISOString());
  return next;
}

function scheduleResult(activeId, name, ordem, entryAtMs, validUntilMs, extra={}){
  const snap = ()=> latestPrice.get(activeId);
  const t1 = Math.max(0, entryAtMs - Date.now());
  const t2 = Math.max(0, validUntilMs - Date.now());

  let entryPrice = null;
  setTimeout(()=>{
    entryPrice = snap();
    if (entryPrice == null){
      const buf = priceBuffers.get(activeId) || [];
      entryPrice = buf.length ? buf[buf.length-1] : null;
    }
    setTimeout(()=>{
      const closePrice = snap();
      const cp = (closePrice == null) ? entryPrice : closePrice;
      let win = null;
      if (entryPrice != null && cp != null){
        win = (ordem === 'COMPRA') ? (cp > entryPrice) : (cp < entryPrice);
      }
      broadcastResult({
        ativo: name, timeframe: 'M1', ordem,
        entryAt: entryAtMs, validUntil: validUntilMs,
        entryPrice, closePrice: cp, win, ...extra
      });
      applyCooldownFrom(validUntilMs);
    }, t2 - t1);
  }, t1);
}

async function loadSdkIfPossible(){
  if (SDKModule || demoMode) return !!SDKModule;
  try { SDKModule = await import('@quadcode-tech/client-sdk-js'); log('Quadcode SDK importado.'); return true; }
  catch(e){ demoMode=true; lastError='sdk_import_failed'; errlog('Falha import SDK → DEMO', e?.message || e); return false; }
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
      const price = updated?.quote ?? updated?.value ?? updated?.ask ?? updated?.bid;
      if (typeof price !== 'number') return;
      latestPrice.set(activeId, price);

      if (tradeLock.locked) return;
      if (Date.now() < globalNextAllowedAt) return;

      const buf = pushPrice(activeId, price);
      const avg = sma(buf, 20);
      if (!avg) return;

      const prev = buf[buf.length - 2];
      if (typeof prev !== 'number') return;

      const crossedUp   = prev < avg && price > avg;
      const crossedDown = prev > avg && price < avg;
      if (!crossedUp && !crossedDown) return;

      const ordemRaw = crossedUp ? 'COMPRA' : 'VENDA';
      const ordem = (ordemRaw === 'COMPRA') ? 'VENDA' : 'COMPRA';

      const { preOpenAt, entryAt, validUntil } = computeOpWindow(currentSdk.currentTime ? currentSdk.currentTime() : new Date());
      acquireTradeLock(name, activeId, preOpenAt, entryAt, validUntil);

      const prob  = probFromBuffer(price, buf);
      const horario = fmtHHMM(entryAt);

      const nextAllowed = applyCooldownFrom(validUntil.getTime());

      const payload = {
        ativo:name, timeframe:'M1', ordem, horario, prob,
        preOpenAt: preOpenAt.getTime(), entryAt: entryAt.getTime(), validUntil: validUntil.getTime(),
        nextAllowedAt: nextAllowed,
        window: { pre: 30000, entry: 30000, close: 30000 }
      };
      broadcastSignal(payload);
      scheduleResult(activeId, name, ordem, payload.entryAt, payload.validUntil, { prob });
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
    log('Tickers permitidos (Bin/Digi):', allowedTickersSet.size);
    if (allowedTickersSet.size === 0){ pairsCache = []; return { ok:true, note:'no_binary_digital_open' }; }

    await wireQuoteSignals(sdk);
    return { ok:true };
  }catch(e){
    connected=false; lastError='connect_failed:'+(e?.message || String(e)); errlog('Erro conectar (real):', e); return { ok:false, error:lastError };
  }
}

// Demo
let demoInterval = null;
function startDemoTicker(){
  stopDemoTicker();
  demoInterval = setInterval(()=>{
    if (!connected) return;
    if (Date.now() < globalNextAllowedAt) return;

    const base = pairsCache.length ? pairsCache : ['EUR/USD','GBP/USD','USD/JPY'];
    const ativo = base[Math.floor(Math.random()*base.length)];
    const now = new Date();
    const { preOpenAt, entryAt, validUntil } = computeOpWindow(now);

    acquireTradeLock(ativo, null, preOpenAt, entryAt, validUntil);

    const ordemRaw = Math.random()>0.5?'COMPRA':'VENDA';
    const ordem = (ordemRaw === 'COMPRA') ? 'VENDA' : 'COMPRA';

    const prob = Math.max(MIN_PROB, Math.min(MAX_PROB, Math.round(57 + Math.random()*28)));
    const horario = fmtHHMM(entryAt);

    const nextAllowed = applyCooldownFrom(validUntil.getTime());

    const payload = {
      ativo, timeframe:'M1', ordem, horario, prob,
      preOpenAt: preOpenAt.getTime(), entryAt: entryAt.getTime(), validUntil: validUntil.getTime(),
      nextAllowedAt: nextAllowed,
      window: { pre: 30000, entry: 30000, close: 30000 }
    };
    broadcastSignal(payload);

    setTimeout(()=>{
      const winChance = Math.min(0.9, Math.max(MIN_PROB/100, prob/100));
      const win = Math.random() < winChance;
      broadcastResult({ ativo, timeframe:'M1', ordem, entryAt: payload.entryAt, validUntil: payload.validUntil, entryPrice: 1, closePrice: win?1.001:0.999, win, prob });
      applyCooldownFrom(payload.validUntil);
    }, Math.max(0, payload.validUntil - Date.now()));
  }, 20000);
  log('Demo ticker iniciado.');
}
function stopDemoTicker(){ if (demoInterval){ clearInterval(demoInterval); demoInterval=null; log('Demo ticker parado.'); } }

async function connectDemo(){
  connected = true; lastError = null;
  if (allowedTickersSet.size === 0) allowedTickersSet = new Set(['EUR/USD','GBP/USD','USD/JPY']);
  pairsCache = Array.from(allowedTickersSet);
  startDemoTicker();
  return { ok:true, demo:true };
}

app.get('/status', (req,res)=>{ res.json({ ok:true, connected, lastError, lock: tradeLock, pairs: pairsCache, env: envView(), nextAllowedAt: globalNextAllowedAt }); });
app.post('/connect', async (req,res)=>{
  if (connected) return res.json({ ok:true, already:true, demo: demoMode, lock: tradeLock, nextAllowedAt: globalNextAllowedAt });
  const result = demoMode ? await connectDemo() : await connectReal();
  if (!result.ok) { const fb = await connectDemo(); return res.json({ ...fb, fallbackFrom: result.error || 'unknown', nextAllowedAt: globalNextAllowedAt }); }
  return res.json({ ...result, lock: tradeLock, nextAllowedAt: globalNextAllowedAt });
});
app.post('/disconnect', (req,res)=>{
  connected=false; lastError=null;
  if (sdk?.disconnect) try{ sdk.disconnect(); }catch{}
  sdk=null; stopDemoTicker();
  tradeLock = { locked:false, active:null, activeId:null, openedAt:0, expiresAt:0, entryAt:0, validUntil:0, preOpenAt:0 };
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
  sseHello(res);
  sseClients.add(res);
  log('SSE client +1 total:', sseClients.size);
  sseSend(res, { t: Date.now(), connected, nextAllowedAt: globalNextAllowedAt }, 'ping');
  req.on('close', ()=>{ sseClients.delete(res); log('SSE client -1 total:', sseClients.size); try{ res.end(); }catch{} });
});
app.get('/', (req,res)=> res.json({ ok:true, service:'IaLife Backend', connected, lastError, nextAllowedAt: globalNextAllowedAt }) );

app.listen(PORT, ()=>{ log(`Servidor ouvindo :${PORT}`, envView()); });

// server.mjs — IaLife Backend (Express + SSE) — FIXED to use ClientSdk.create
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());

// --- CORS ---
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

// --- State ---
let SDK = null;         // module
let sdk = null;         // ClientSdk instance
let connected = false;
let lastError = null;
let demoMode = (process.env.DEMO_MODE || '').trim() === '1';
let pairsCache = [];
let demoTimer = null;

// --- SSE ---
const sseClients = new Set();
const SSE_PING_MS = 15000;

function sseSend(res, payload, eventName='message') {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function broadcastSignal(signal) {
  for (const res of sseClients) {
    try { sseSend(res, signal, 'signal'); } catch {}
  }
}
setInterval(() => {
  for (const res of sseClients) {
    try { sseSend(res, { t: Date.now() }, 'ping'); } catch {}
  }
}, SSE_PING_MS);

// --- Utils ---
const log = (...a)=>console.log('[IaLife]', ...a);
const errlog = (...a)=>console.error('[IaLife][ERR]', ...a);
const envView = ()=>({
  WS_URL: process.env.WS_URL,
  HTTP_HOST: process.env.HTTP_HOST,
  PLATFORM_ID: process.env.PLATFORM_ID,
  ALLOW_ORIGIN: allowOriginEnv,
  DEMO_MODE: demoMode ? '1' : '0',
  ATRIUN_LOGIN: process.env.ATRIUN_LOGIN ? '(set)' : '(unset)',
  ATRIUN_PASSWORD: process.env.ATRIUN_PASSWORD ? '(set)' : '(unset)',
});

// --- SDK loader ---
async function loadSdkIfPossible(){
  if (SDK || demoMode) return !!SDK;
  try {
    SDK = await import('@quadcode-tech/client-sdk-js');
    log('Quadcode SDK importado.');
    return true;
  } catch(e){
    demoMode = true;
    lastError = 'sdk_import_failed';
    errlog('Falha import SDK → DEMO_MODE', e?.message || e);
    return false;
  }
}

async function connectReal(){
  await loadSdkIfPossible();
  if (!SDK) return { ok:false, error:'sdk_unavailable' };

  const { ClientSdk, LoginPasswordAuthMethod } = SDK;
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
  if (missing.length){
    lastError = 'missing_env:' + missing.join(',');
    return { ok:false, error:lastError };
  }

  try{
    // Conforme README do SDK (npm): ClientSdk.create(ws, platformId, new LoginPasswordAuthMethod(apiHost, login, pwd), { host? })
    sdk = await ClientSdk.create(
      WS_URL,
      PLATFORM_ID,
      new LoginPasswordAuthMethod(HTTP_HOST, LOGIN, PASSWORD)
      // , { host: 'https://trade.atriunbroker.finance' } // opcional
    );

    connected = true;
    lastError = null;
    log('Conectado (real)');

    // Carrega "pares abertos" com base em Blitz Options que podem ser comprados agora
    try{
      const bo = await sdk.blitzOptions();
      const now = sdk.currentTime ? sdk.currentTime() : new Date();
      const actives = bo.getActives().filter(a => a.canBeBoughtAt(now));
      // use ticker (quando houver) ou id
      pairsCache = actives.map(a => a.ticker || (`ACTIVE_${a.id}`));
      log('Pairs/Actives abertos:', pairsCache.length);
    }catch(e){
      errlog('Falha ao obter actives:', e?.message || e);
    }

    // Aqui você pode assinar eventos reais (ex.: posições, quotes) se o SDK expuser:
    // const positions = await sdk.positions();
    // positions.subscribeOnUpdatePosition((pos) => { ...broadcastSignal(...) });

    return { ok:true };
  }catch(e){
    connected = false;
    lastError = 'connect_failed:' + (e?.message || String(e));
    errlog('Erro conectar (real):', e);
    return { ok:false, error:lastError };
  }
}

function startDemoTicker(){
  stopDemoTicker();
  demoTimer = setInterval(()=>{
    if (!connected) return;
    const ativos = pairsCache.length ? pairsCache : ['EUR/USD','GBP/USD','USD/JPY','EUR/JPY','AUD/USD','NZD/USD'];
    const ativo = ativos[Math.floor(Math.random()*ativos.length)];
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    const prob = 58 + Math.floor(Math.random()*29);
    broadcastSignal({ ativo, timeframe:'M1', ordem: Math.random()>0.5?'COMPRA':'VENDA', horario:`${h}:${m}`, prob });
  }, 20000);
  log('Demo ticker iniciado.');
}
function stopDemoTicker(){ if (demoTimer){ clearInterval(demoTimer); demoTimer=null; log('Demo ticker parado.'); } }

async function connectDemo(){
  connected = true;
  lastError = null;
  if (!pairsCache.length) pairsCache = ['EUR/USD','GBP/USD','USD/JPY','EUR/JPY','AUD/USD','NZD/USD'];
  startDemoTicker();
  return { ok:true, demo:true };
}

// --- Routes ---
app.get('/status', (req,res)=>{
  res.json({ ok:true, connected, lastError, env: envView() });
});

app.post('/connect', async (req,res)=>{
  if (connected) return res.json({ ok:true, already:true, demo: demoMode });
  const result = demoMode ? await connectDemo() : await connectReal();
  // Fallback para DEMO se falhar por qualquer motivo (facilita teste)
  if (!result.ok) {
    const fallback = await connectDemo();
    return res.json({ ...fallback, fallbackFrom: result.error || 'unknown' });
  }
  return res.json(result);
});

app.post('/disconnect', (req,res)=>{
  connected = false;
  lastError = null;
  if (sdk?.disconnect) try{ sdk.disconnect(); }catch{}
  sdk = null;
  stopDemoTicker();
  res.json({ ok:true });
});

app.get('/open-pairs', async (req,res)=>{
  if (!connected) return res.status(400).json({ ok:false, error:'not_connected' });
  if (!demoMode && sdk){
    try{
      const bo = await sdk.blitzOptions();
      const now = sdk.currentTime ? sdk.currentTime() : new Date();
      const actives = bo.getActives().filter(a => a.canBeBoughtAt(now));
      pairsCache = actives.map(a => a.ticker || (`ACTIVE_${a.id}`));
      return res.json({ ok:true, pairs: pairsCache });
    }catch(e){
      lastError = 'pairs_failed:' + (e?.message || e);
      return res.status(500).json({ ok:false, error:lastError });
    }
  }
  return res.json({ ok:true, pairs: pairsCache });
});

app.get('/events', (req,res)=>{
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  log('SSE client +1 total:', sseClients.size);
  sseSend(res, { t: Date.now(), connected }, 'ping');
  req.on('close', ()=>{
    sseClients.delete(res);
    log('SSE client -1 total:', sseClients.size);
    try{ res.end(); }catch{}
  });
});

app.get('/', (req,res)=> res.json({ ok:true, service:'IaLife Backend', connected, lastError }) );

app.listen(PORT, ()=>{
  log(`Servidor ouvindo :${PORT}`, envView());
});

// server.mjs — IaLife Backend (Express + SSE) com estratégia SMA-20
// - Conecta no SDK da Quadcode (Atriun) usando ClientSdk.create
// - Assina quotes de até 10 "actives" compráveis agora (Blitz Options)
// - Gera sinais quando o preço cruza a SMA-20 (compra pra cima, venda pra baixo)
// - Probabilidade calculada pela distância ao SMA (40–90) e NUNCA < 40
// - SSE em /events para o frontend (event: signal)
//
// Endpoints:
//  GET  /status
//  POST /connect
//  POST /disconnect
//  GET  /open-pairs
//  GET  /events
//
// Variáveis de ambiente (Render):
//  WS_URL=wss://ws.trade.atriunbroker.finance/echo/websocket
//  HTTP_HOST=https://api.trade.atriunbroker.finance
//  PLATFORM_ID=499
//  ATRIUN_LOGIN=atriun.baseapi@gmail.com
//  ATRIUN_PASSWORD=Atriun@33225608
//  ALLOW_ORIGIN=https://italosantanatrader.com,https://www.italosantanatrader.com
//  DEMO_MODE=0   (opcional: 1 para forçar demo)
//
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());

// --------- CORS ---------
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

// --------- Estado ---------
let SDKModule = null;   // módulo importado
let sdk = null;         // instância ClientSdk
let connected = false;
let lastError = null;
let demoMode = (process.env.DEMO_MODE || '').trim() === '1';
let pairsCache = [];    // nomes (tickers) dos ativos abertos
let demoTimer = null;

// --------- SSE ---------
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

// --------- Utils ---------
function log(...a){ console.log('[IaLife]', ...a); }
function errlog(...a){ console.error('[IaLife][ERR]', ...a); }
function envView(){
  return {
    WS_URL: process.env.WS_URL,
    HTTP_HOST: process.env.HTTP_HOST,
    PLATFORM_ID: process.env.PLATFORM_ID,
    ALLOW_ORIGIN: allowOriginEnv,
    DEMO_MODE: demoMode ? '1' : '0',
    ATRIUN_LOGIN: process.env.ATRIUN_LOGIN ? '(set)' : '(unset)',
    ATRIUN_PASSWORD: process.env.ATRIUN_PASSWORD ? '(set)' : '(unset)',
  };
}

// --------- SMA + buffer + cooldown ---------
const priceBuffers = new Map();    // activeId -> number[]
const lastSignalAt = new Map();    // activeId -> timestamp
const SIGNAL_COOLDOWN_MS = 2 * 60 * 1000; // 2 min

function sma(arr, len) {
  if (!Array.isArray(arr) || arr.length < len) return null;
  let sum = 0;
  for (let i = arr.length - len; i < arr.length; i++) sum += arr[i];
  return sum / len;
}
function pushPrice(activeId, price, maxLen = 50) {
  const buf = priceBuffers.get(activeId) || [];
  buf.push(price);
  if (buf.length > maxLen) buf.shift();
  priceBuffers.set(activeId, buf);
  return buf;
}
function probFromDistance(p, avg) {
  const dist = Math.abs((p - avg) / avg);   // 0.001 = 0.1%
  let base = 40 + Math.min(50, Math.round(dist * 10000)); // 0.1% => +10
  if (base > 90) base = 90;
  if (base < 40) base = 40;
  return base;
}

// --------- SDK Loader ---------
async function loadSdkIfPossible(){
  if (SDKModule || demoMode) return !!SDKModule;
  try {
    SDKModule = await import('@quadcode-tech/client-sdk-js');
    log('Quadcode SDK importado.');
    return true;
  } catch(e){
    demoMode = true;
    lastError = 'sdk_import_failed';
    errlog('Falha no import do SDK → DEMO_MODE', e?.message || e);
    return false;
  }
}

// --------- Assinatura de quotes e geração de sinais ---------
async function wireQuoteSignals(currentSdk, pairsTargetArray) {
  const quotes = await currentSdk.quotes();
  const bo = await currentSdk.blitzOptions();
  const now = currentSdk.currentTime ? currentSdk.currentTime() : new Date();

  // Seleciona até 10 ativos "compráveis agora"
  const actives = bo.getActives().filter(a => a.canBeBoughtAt(now)).slice(0, 10);
  const names = actives.map(a => a.ticker || (`ACTIVE_${a.id}`));
  if (Array.isArray(pairsTargetArray)) {
    pairsTargetArray.splice(0, pairsTargetArray.length, ...names);
  }

  for (const a of actives) {
    const activeId = a.id;
    const name = a.ticker || (`ACTIVE_${a.id}`);
    const cq = await quotes.getCurrentQuoteForActive(activeId);

    cq.subscribeOnUpdate((updated) => {
      // Normaliza possíveis campos de preço
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
      const ordem = crossedUp ? 'COMPRA' : 'VENDA';
      const prob  = probFromDistance(price, avg);
      const h = new Date();
      const horario = `${String(h.getHours()).padStart(2,'0')}:${String(h.getMinutes()).padStart(2,'0')}`;

      broadcastSignal({ ativo: name, timeframe: 'M1', ordem, horario, prob });
    });
  }

  log('wireQuoteSignals: assinaturas ativas em', actives.length, 'ativos');
}

// --------- Conexões ---------
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
  if (missing.length){
    lastError = 'missing_env:' + missing.join(',');
    return { ok:false, error:lastError };
  }

  try{
    sdk = await ClientSdk.create(
      WS_URL,
      PLATFORM_ID,
      new LoginPasswordAuthMethod(HTTP_HOST, LOGIN, PASSWORD)
    );

    connected = true;
    lastError = null;
    log('Conectado (real).');

    // Carrega e assina quotes → sinais SMA-20
    await wireQuoteSignals(sdk, pairsCache);

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

// --------- Rotas ---------
app.get('/status', (req,res)=>{
  res.json({ ok:true, connected, lastError, env: envView() });
});

app.post('/connect', async (req,res)=>{
  if (connected) return res.json({ ok:true, already:true, demo: demoMode });
  const result = demoMode ? await connectDemo() : await connectReal();
  // Fallback para DEMO se a conexão real falhar (facilita teste)
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
      const names = actives.map(a => a.ticker || (`ACTIVE_${a.id}`));
      pairsCache = names.slice();
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

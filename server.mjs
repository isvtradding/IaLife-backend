// server.mjs — IaLife Backend (Express + SSE)
import express from 'express';
import cors from 'cors';

const app = express();
app.use(express.json());

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

let SDK = null;
let client = null;
let connected = false;
let lastError = null;
let demoMode = (process.env.DEMO_MODE || '').trim() === '1';
let pairsCache = [];
let demoTimer = null;

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

function log(...a){ console.log('[IaLife]', ...a); }
function errlog(...a){ console.error('[IaLife][ERR]', ...a); }
function getEnv() {
  return {
    WS_URL: process.env.WS_URL,
    HTTP_HOST: process.env.HTTP_HOST,
    PLATFORM_ID: process.env.PLATFORM_ID,
    ATRIUN_LOGIN: process.env.ATRIUN_LOGIN ? '(set)' : '(unset)',
    ATRIUN_PASSWORD: process.env.ATRIUN_PASSWORD ? '(set)' : '(unset)',
    ALLOW_ORIGIN: allowOriginEnv,
    DEMO_MODE: demoMode ? '1' : '0',
  };
}

async function loadSdkIfPossible() {
  if (SDK || demoMode) return !!SDK;
  try {
    SDK = await import('@quadcode-tech/client-sdk-js');
    log('SDK importado com sucesso.');
    return true;
  } catch (e) {
    errlog('Falha ao importar SDK, ativando DEMO_MODE:', e?.message || e);
    demoMode = true;
    lastError = 'sdk_import_failed';
    return false;
  }
}

async function connectReal() {
  await loadSdkIfPossible();
  if (!SDK) return { ok:false, error:'sdk_unavailable' };

  const WS_URL = process.env.WS_URL;
  const HTTP_HOST = process.env.HTTP_HOST;
  const PLATFORM_ID = Number(process.env.PLATFORM_ID || '0');
  const LOGIN = process.env.ATRIUN_LOGIN;
  const PASSWORD = process.env.ATRIUN_PASSWORD;

  if (!WS_URL || !HTTP_HOST || !PLATFORM_ID || !LOGIN || !PASSWORD) {
    const miss = [];
    if (!WS_URL) miss.push('WS_URL');
    if (!HTTP_HOST) miss.push('HTTP_HOST');
    if (!PLATFORM_ID) miss.push('PLATFORM_ID');
    if (!LOGIN) miss.push('ATRIUN_LOGIN');
    if (!PASSWORD) miss.push('ATRIUN_PASSWORD');
    lastError = 'missing_env:' + miss.join(',');
    return { ok:false, error:lastError };
  }

  try {
    const { LoginPasswordAuthMethod, createClient } = SDK;
    const auth = new LoginPasswordAuthMethod(HTTP_HOST, LOGIN, PASSWORD);
    client = await createClient({ platformId: PLATFORM_ID, wsUrl: WS_URL, authMethod: auth });

    connected = true;
    lastError = null;
    log('Conectado na Atriun (real).');

    try {
      if (client?.instruments?.getInstruments) {
        const list = await client.instruments.getInstruments();
        pairsCache = Array.isArray(list) ? list.map(x => (x?.displayName || x?.symbol || x?.name)).filter(Boolean) : [];
        log('Pares carregados:', pairsCache.length);
      }
    } catch (e) { errlog('Falha ao carregar pares:', e?.message || e); }

    // Exemplo de assinatura de sinais (ajuste conforme SDK real):
    // if (client.signals?.on) {
    //   client.signals.on('signal', (sig) => {
    //     const normalized = {
    //       ativo: sig?.symbol || sig?.asset || 'DESCONHECIDO',
    //       timeframe: sig?.timeframe || 'M1',
    //       ordem: (sig?.direction || 'COMPRA').toUpperCase(),
    //       horario: new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}),
    //       prob: Math.max(40, Math.min(100, Math.round(sig?.probability ?? 60)))
    //     };
    //     broadcastSignal(normalized);
    //   });
    // }

    return { ok:true };
  } catch (e) {
    connected = false;
    lastError = 'connect_failed:' + (e?.message || String(e));
    errlog('Erro ao conectar (real):', e);
    return { ok:false, error:lastError };
  }
}

function startDemoTicker() {
  stopDemoTicker();
  demoTimer = setInterval(() => {
    if (!connected) return;
    const ativos = pairsCache.length ? pairsCache : ['EUR/USD','GBP/USD','USD/JPY','EUR/JPY','AUD/USD','NZD/USD'];
    const ativo = ativos[Math.floor(Math.random()*ativos.length)];
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const prob = 58 + Math.floor(Math.random()*29);
    broadcastSignal({ ativo, timeframe:'M1', ordem: Math.random()>0.5?'COMPRA':'VENDA', horario:`${h}:${m}`, prob });
  }, 20000);
  log('Demo ticker iniciado.');
}
function stopDemoTicker() { if (demoTimer) { clearInterval(demoTimer); demoTimer = null; log('Demo ticker parado.'); } }

async function connectDemo() {
  connected = true;
  lastError = null;
  if (pairsCache.length === 0) pairsCache = ['EUR/USD','GBP/USD','USD/JPY','EUR/JPY','AUD/USD','NZD/USD'];
  startDemoTicker();
  return { ok:true, demo:true };
}

// Routes
app.get('/status', (req, res) => { res.json({ ok:true, connected, lastError, env:{
  WS_URL: process.env.WS_URL,
  HTTP_HOST: process.env.HTTP_HOST,
  PLATFORM_ID: process.env.PLATFORM_ID,
  ALLOW_ORIGIN: allowOriginEnv,
  DEMO_MODE: demoMode ? '1' : '0',
}}); });

app.post('/connect', async (req, res) => {
  if (connected) return res.json({ ok:true, already:true, demo: demoMode });
  const result = demoMode ? await connectDemo() : await connectReal();
  if (!result.ok && result.error?.startsWith('sdk_')) {
    demoMode = true;
    const fallback = await connectDemo();
    return res.json({ ...fallback, fallbackFrom: result.error });
  }
  return res.status(result.ok ? 200 : 500).json(result);
});

app.post('/disconnect', (req, res) => {
  connected = false;
  lastError = null;
  if (client?.disconnect) try { client.disconnect(); } catch {}
  client = null;
  stopDemoTicker();
  res.json({ ok:true });
});

app.get('/open-pairs', async (req, res) => {
  if (!connected) return res.status(400).json({ ok:false, error:'not_connected' });
  if (!demoMode && client?.instruments?.getInstruments) {
    try {
      const list = await client.instruments.getInstruments();
      pairsCache = Array.isArray(list) ? list.map(x => (x?.displayName || x?.symbol || x?.name)).filter(Boolean) : [];
      return res.json({ ok:true, pairs: pairsCache });
    } catch (e) {
      lastError = 'pairs_failed:' + (e?.message || e);
      return res.status(500).json({ ok:false, error:lastError });
    }
  }
  return res.json({ ok:true, pairs: pairsCache });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  log('SSE client conectado. Total:', sseClients.size);
  sseSend(res, { t: Date.now(), connected }, 'ping');
  req.on('close', () => {
    sseClients.delete(res);
    log('SSE client desconectado. Total:', sseClients.size);
    try { res.end(); } catch {}
  });
});

app.get('/', (req, res) => { res.json({ ok:true, service:'IaLife Backend', connected, lastError }); });
app.listen(PORT, () => { log(`Servidor ouvindo em :${PORT}`, getEnv()); });

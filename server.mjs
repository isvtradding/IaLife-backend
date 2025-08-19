// server.mjs — IaLife backend (Express + Quadcode SDK) com DEBUG

import express from 'express';
import dotenv from 'dotenv';
import { ClientSdk, LoginPasswordAuthMethod, SsidAuthMethod } from '@quadcode-tech/client-sdk-js';

dotenv.config();
const app = express();

/* ---------- CORS ---------- */
const allowed = (process.env.ALLOW_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowed.includes('*')) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  }
  if (origin && allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  return next();
});
/* -------------------------- */

app.use(express.json());

/* ---------- ENV / Config ---------- */
const WS_URL = process.env.WS_URL || 'wss://ws.trade.atriunbroker.finance/echo/websocket';
const PLATFORM_ID = Number(process.env.PLATFORM_ID || 499);
const HTTP_HOST = process.env.HTTP_HOST || 'https://trade.atriunbroker.finance';

let sdk = null;
let lastConnectError = null;

const mustHave = (...keys) => keys.filter(k => !process.env[k] || String(process.env[k]).trim()==='');

function mkError(e) {
  return {
    ok: false,
    error: e?.message || String(e) || 'connect_failed',
    type: e?.constructor?.name || null,
    code: e?.code || null,
    httpStatus: e?.response?.status || null,
    httpStatusText: e?.response?.statusText || null,
  };
}

/* ---------- SDK Connect helpers ---------- */
async function connectWithLogin(login, password) {
  console.log('[IaLife] connectWithLogin → start', { HTTP_HOST, PLATFORM_ID, WS_URL, login: !!login });
  lastConnectError = null;

  // Passo 1: criar SDK
  const client = await ClientSdk.create(
    WS_URL,
    PLATFORM_ID,
    new LoginPasswordAuthMethod(HTTP_HOST, login, password),
    { host: HTTP_HOST }
  );

  console.log('[IaLife] connectWithLogin → SDK criado');

  // Passo 2: fazer uma chamada simples para validar sessão
  try {
    await client.profile?.getProfile?.(); // se existir
    console.log('[IaLife] connectWithLogin → profile OK');
  } catch (e) {
    console.warn('[IaLife] profile check falhou (não é crítico):', e?.message || e);
  }

  sdk = client;
  return true;
}

async function connectWithSSID(ssid) {
  console.log('[IaLife] connectWithSSID → start', { HTTP_HOST, PLATFORM_ID, WS_URL, ssid: !!ssid });
  lastConnectError = null;

  const client = await ClientSdk.create(
    WS_URL,
    PLATFORM_ID,
    new SsidAuthMethod(ssid),
    { host: HTTP_HOST }
  );

  console.log('[IaLife] connectWithSSID → SDK criado');
  sdk = client;
  return true;
}

/* ---------- Rotas ---------- */
app.get('/', (_req, res) => res.json({ ok: true, message: 'IaLife backend up' }));

app.get('/debug/env', (_req, res) => {
  res.json({
    ok: true,
    WS_URL, PLATFORM_ID, HTTP_HOST,
    ALLOW_ORIGIN: process.env.ALLOW_ORIGIN || null,
    ATRIUN_LOGIN: process.env.ATRIUN_LOGIN ? '(set)' : '(missing)',
    ATRIUN_PASSWORD: process.env.ATRIUN_PASSWORD ? '(set)' : '(missing)'
  });
});

app.get('/status', (_req, res) =>
  res.json({ ok: true, connected: Boolean(sdk), lastError: lastConnectError ? String(lastConnectError) : null })
);

app.post('/connect', async (req, res) => {
  try {
    const miss = mustHave('HTTP_HOST', 'WS_URL', 'PLATFORM_ID');
    if (miss.length) return res.status(500).json({ ok:false, error:'missing_env', details:miss });

    const { login, password, ssid } = req.body || {};
    if (ssid) {
      await connectWithSSID(ssid);
    } else {
      const user = login || process.env.ATRIUN_LOGIN;
      const pass = password || process.env.ATRIUN_PASSWORD;
      if (!user || !pass) return res.status(400).json({ ok:false, error:'missing_credentials' });
      await connectWithLogin(user, pass);
    }
    return res.json({ ok:true });
  } catch (e) {
    lastConnectError = e?.message || e;
    console.error('[IaLife] connect error:', e);
    return res.status(500).json(mkError(e));
  }
});

app.get('/open-pairs', async (_req, res) => {
  if (!sdk) return res.status(400).json({ ok:false, error:'not_connected' });
  try {
    const result = new Set();
    const now = sdk.currentTime ? sdk.currentTime() : Date.now();

    try {
      const digital = await sdk.digitalOptions();
      const under = digital.getUnderlyingsAvailableForTradingAt(now);
      under.forEach(u => result.add(u.ticker || u.symbol || `ID:${u.activeId}`));
    } catch (e) { console.warn('[IaLife] digitalOptions skip:', e?.message || e); }

    try {
      const blitz = await sdk.blitzOptions();
      blitz.getActives().forEach(a => {
        try { if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`); } catch {}
      });
    } catch (e) { console.warn('[IaLife] blitzOptions skip:', e?.message || e); }

    try {
      const binary = await sdk.binaryOptions();
      binary.getActives().forEach(a => {
        try { if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`); } catch {}
      });
    } catch (e) { console.warn('[IaLife] binaryOptions skip:', e?.message || e); }

    res.json({ ok:true, pairs:[...result].sort() });
  } catch (e) {
    console.error('[IaLife] /open-pairs error:', e);
    res.status(500).json({ ok:false, error: e?.message || 'open_pairs_failed' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('IaLife backend running on port', PORT));

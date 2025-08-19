// server.mjs — IaLife backend (Express + Quadcode SDK)
// ENV necessários no Render:
// ALLOW_ORIGIN="https://italosantanatrader.com,https://www.italosantanatrader.com"
// ATRIUN_LOGIN, ATRIUN_PASSWORD
// (opcionais com default) WS_URL, PLATFORM_ID, HTTP_HOST

import express from 'express';
import dotenv from 'dotenv';
import { ClientSdk, LoginPasswordAuthMethod, SsidAuthMethod } from '@quadcode-tech/client-sdk-js';

dotenv.config();

const app = express();

/* ---------------------- CORS ROBUSTO ---------------------- */
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
/* ---------------------------------------------------------- */

app.use(express.json());

// ---- Config da Atriun / Quadcode ----
const WS_URL = process.env.WS_URL || 'wss://ws.trade.atriunbroker.finance/echo/websocket';
const PLATFORM_ID = Number(process.env.PLATFORM_ID || 499);
const HTTP_HOST = process.env.HTTP_HOST || 'https://trade.atriunbroker.finance';

let sdk = null;
let lastConnectError = null;

async function connectWithLogin(login, password) {
  lastConnectError = null;
  sdk = await ClientSdk.create(
    WS_URL,
    PLATFORM_ID,
    new LoginPasswordAuthMethod(HTTP_HOST, login, password),
    { host: HTTP_HOST }
  );
  return true;
}

async function connectWithSSID(ssid) {
  lastConnectError = null;
  sdk = await ClientSdk.create(
    WS_URL,
    PLATFORM_ID,
    new SsidAuthMethod(ssid),
    { host: HTTP_HOST }
  );
  return true;
}

// ---------- Rotas ----------
app.get('/', (_req, res) => res.json({ ok: true, message: 'IaLife backend up' }));

app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    connected: Boolean(sdk),
    lastError: lastConnectError ? String(lastConnectError) : null
  });
});

app.post('/connect', async (req, res) => {
  try {
    const { login, password, ssid } = req.body || {};
    if (ssid) {
      await connectWithSSID(ssid);
    } else {
      const user = login || process.env.ATRIUN_LOGIN;
      const pass = password || process.env.ATRIUN_PASSWORD;
      if (!user || !pass) {
        return res.status(400).json({ ok: false, error: 'missing_credentials' });
      }
      await connectWithLogin(user, pass);
    }
    return res.json({ ok: true });
  } catch (e) {
    lastConnectError = e?.message || e;
    console.error('[IaLife] connect error:', e);
    return res.status(500).json({
      ok: false,
      error: e?.message || 'connect_failed',
      // pode comentar a linha abaixo se não quiser detalhes no cliente:
      details: e?.stack || String(e)
    });
  }
});

app.get('/open-pairs', async (_req, res) => {
  if (!sdk) return res.status(400).json({ ok: false, error: 'not_connected' });
  try {
    const result = new Set();
    const now = sdk.currentTime ? sdk.currentTime() : Date.now();

    // Digital
    try {
      const digital = await sdk.digitalOptions();
      const under = digital.getUnderlyingsAvailableForTradingAt(now);
      under.forEach(u => result.add(u.ticker || u.symbol || `ID:${u.activeId}`));
    } catch {}

    // Blitz
    try {
      const blitz = await sdk.blitzOptions();
      blitz.getActives().forEach(a => {
        try { if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`); } catch {}
      });
    } catch {}

    // Binary
    try {
      const binary = await sdk.binaryOptions();
      binary.getActives().forEach(a => {
        try { if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`); } catch {}
      });
    } catch {}

    res.json({ ok: true, pairs: [...result].sort() });
  } catch (e) {
    console.error('[IaLife] /open-pairs error:', e);
    res.status(500).json({ ok: false, error: e?.message || 'open_pairs_failed' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('IaLife backend running on port', PORT));

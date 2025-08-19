// server.mjs — IaLife backend (Express + Quadcode SDK)

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

// ---- Config Atriun / Quadcode ----
const WS_URL = process.env.WS_URL || 'wss://ws.trade.atriunbroker.finance/echo/websocket';
const PLATFORM_ID = Number(process.env.PLATFORM_ID || 499);
const HTTP_HOST = process.env.HTTP_HOST || 'https://trade.atriunbroker.finance';

let sdk = null;
let lastConnectError = null;

function missing(list) {
  return list.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
}

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

// ---------- Rotas utilitárias ----------
app.get('/', (_req, res) => res.json({ ok: true, message: 'IaLife backend up' }));

app.get('/status', (_req, res) => {
  res.json({
    ok: true,
    connected: Boolean(sdk),
    lastError: lastConnectError ? String(lastConnectError) : null
  });
});

// mostra envs (sem senha)
app.get('/debug/env', (_req, res) => {
  res.json({
    ok: true,
    WS_URL,
    PLATFORM_ID,
    HTTP_HOST,
    ALLOW_ORIGIN: process.env.ALLOW_ORIGIN || null,
    ATRIUN_LOGIN: process.env.ATRIUN_LOGIN ? '(set)' : '(missing)',
    ATRIUN_PASSWORD: process.env.ATRIUN_PASSWORD ? '(set)' : '(missing)'
  });
});

// ---------- Conectar ----------
app.post('/connect', async (req, res) => {
  try {
    const { login, password, ssid } = req.body || {};

    // valida envs antes
    const miss = missing(['HTTP_HOST', 'WS_URL', 'PLATFORM_ID']);
    if (miss.length) {
      return res.status(500).json({ ok: false, error: 'missing_env', details: miss });
    }

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
    // captura máximo de detalhes possíveis
    lastConnectError = e?.message || e;
    const payload = {
      ok: false,
      error: e?.message || 'connect_failed',
      type: e?.constructor?.name || null,
      code: e?.code || null
    };
    try {
      if (e?.response) {
        payload.httpStatus = e.response.status;
        payload.httpStatusText = e.response.statusText;
      }
    } catch {}
    console.error('[IaLife] connect error:', e);
    return res.status(500).json(payload);
  }
});

// ---------- Pares abertos ----------
app.get('/open-pairs', async (_req, res) => {
  if (!sdk) return res.status(400).json({ ok: false, error: 'not_connected' });
  try {
    const result = new Set();
    const now = sdk.currentTime ? sdk.currentTime() : Date.now();

    try {
      const digital = await sdk.digitalOptions();
      const under = digital.getUnderlyingsAvailableForTradingAt(now);
      under.forEach(u => result.add(u.ticker || u.symbol || `ID:${u.activeId}`));
    } catch {}

    try {
      const blitz = await sdk.blitzOptions();
      blitz.getActives().forEach(a => {
        try { if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`); } catch {}
      });
    } catch {}

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

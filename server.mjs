import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ClientSdk, LoginPasswordAuthMethod, SsidAuthMethod } from '@quadcode-tech/client-sdk-js';

dotenv.config();

const app = express();
app.use(express.json());

const allow = process.env.ALLOW_ORIGIN ? process.env.ALLOW_ORIGIN.split(',') : ['*'];
app.use(cors({ origin: allow, credentials: true }));

const WS_URL = process.env.WS_URL || 'wss://ws.trade.atriunbroker.finance/echo/websocket';
const PLATFORM_ID = Number(process.env.PLATFORM_ID || 499);
const HTTP_HOST = process.env.HTTP_HOST || 'https://trade.atriunbroker.finance';

let sdk = null;

async function connectWithLogin(login, password) {
  sdk = await ClientSdk.create(WS_URL, PLATFORM_ID, new LoginPasswordAuthMethod(HTTP_HOST, login, password), { host: HTTP_HOST });
  return true;
}

async function connectWithSSID(ssid) {
  sdk = await ClientSdk.create(WS_URL, PLATFORM_ID, new SsidAuthMethod(ssid), { host: HTTP_HOST });
  return true;
}

app.get('/', (req,res)=> res.json({ ok:true, message:'Cronos backend up' }));

app.post('/connect', async (req, res) => {
  try {
    const { login, password, ssid } = req.body || {};
    if (ssid) await connectWithSSID(ssid);
    else await connectWithLogin(login || process.env.ATRIUN_LOGIN, password || process.env.ATRIUN_PASSWORD);
    res.json({ ok: true });
  } catch (e) {
    console.error('connect error', e);
    res.status(500).json({ ok:false, error: e?.message || 'connect_failed'});
  }
});

app.get('/open-pairs', async (req,res) => {
  if (!sdk) return res.status(400).json({ ok:false, error: 'not_connected'});
  try{
    const result = new Set();
    const now = sdk.currentTime ? sdk.currentTime() : Date.now();
    // digital
    try {
      const digital = await sdk.digitalOptions();
      const under = digital.getUnderlyingsAvailableForTradingAt(now);
      under.forEach(u => result.add(u.ticker || u.symbol || `ID:${u.activeId}`));
    } catch(e){}
    // blitz
    try {
      const blitz = await sdk.blitzOptions();
      blitz.getActives().forEach(a => { try{ if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`)} catch {} });
    } catch(e){}
    // binary
    try {
      const binary = await sdk.binaryOptions();
      binary.getActives().forEach(a => { try{ if (a.canBeBoughtAt(now)) result.add(a.ticker || a.name || `ID:${a.id}`)} catch {} });
    } catch(e){}
    res.json({ ok:true, pairs: [...result].sort() });
  } catch(e){
    console.error('open-pairs error', e);
    res.status(500).json({ok:false, error:e.message});
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Cronos backend running on port', PORT));

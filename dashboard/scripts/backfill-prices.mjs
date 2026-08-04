#!/usr/bin/env node
/**
 * backfill-prices.mjs (v3) — Reconstruye el histórico COMPLETO de ₸USD on-chain
 * (eventos Swap del pool V3 TUSD/WETH en Base) → velas diarias OHLC en Supabase.
 *
 * v3: GUARDA SEGÚN AVANZA (cada ~7 días completados) y es REANUDABLE:
 * si se corta (Ctrl+C, error, red), al relanzar continúa donde iba usando
 * el cursor `price_last_block` de scan_state y la última vela guardada.
 *
 * Uso (desde dashboard/):  node scripts/backfill-prices.mjs
 * Env: ANKR_RPC_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (.env.local)
 */

import { readFileSync, existsSync } from "node:fs";

/* ── env ───────────────────────────────────────────────────────────────── */
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const RPC = process.env.ANKR_RPC_URL;
const SB_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!RPC || !SB_URL || !SB_KEY || RPC.includes("SENSITIVE")) {
  console.error("Faltan env vars (o valen [SENSITIVE]): ANKR_RPC_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

/* ── constantes ────────────────────────────────────────────────────────── */
const POOL = "0xd013725b904e76394A3aB0334Da306C505D778F8"; // token0=TUSD, token1=WETH (18/18 dec)
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const POOL_CREATED_TS = 1751732117; // 2025-07-05
const BLOCK_TIME = 2;               // Base: 2 s fijos
const Q192 = 2n ** 192n;
const SCALE = 10n ** 18n;
const FLUSH_DAYS = 7;               // guarda cada N días completados

let rpcCalls = 0;

/* ── RPC ───────────────────────────────────────────────────────────────── */
async function rpc(method, params) {
  rpcCalls++;
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}
const hex = n => "0x" + n.toString(16);

function toPoint(l) {
  const sqrt = BigInt("0x" + l.data.slice(2 + 64 * 2, 2 + 64 * 2 + 64));
  const amount1 = BigInt.asIntN(256, BigInt("0x" + l.data.slice(2 + 32 * 2, 2 + 32 * 2 + 64)));
  const tusdPerWeth = Number((Q192 * SCALE) / (sqrt * sqrt)) / 1e18;
  return { b: parseInt(l.blockNumber, 16), p: tusdPerWeth, v: Math.abs(Number(amount1) / 1e18) };
}

/* ── fechas ────────────────────────────────────────────────────────────── */
const dayOfTs = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const nextDay = d => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);

/* ── main ──────────────────────────────────────────────────────────────── */
console.log("① Anclando bloques…");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
const latestBn = parseInt(latest.number, 16);
const latestTs = parseInt(latest.timestamp, 16);
let startBn = latestBn - Math.ceil((latestTs - POOL_CREATED_TS) / BLOCK_TIME) - 43200;
if (startBn < 1) startBn = 1;
const anchor = await rpc("eth_getBlockByNumber", [hex(startBn), false]);
const anchorBn = parseInt(anchor.number, 16);
const anchorTs = parseInt(anchor.timestamp, 16);
const tsOf = bn => anchorTs + (bn - anchorBn) * BLOCK_TIME;
const blockAtTs = ts => anchorBn + Math.floor((ts - anchorTs) / BLOCK_TIME);

console.log("② Estado previo (reanudación)…");
let cursor = 0, prevClose = null, lastSavedDay = null;
try {
  const r = await (await fetch(`${SB_URL}/rest/v1/scan_state?key=eq.price_last_block&select=block_number`, { headers: SB_HEADERS })).json();
  cursor = Number(r?.[0]?.block_number || 0);
  const c = await (await fetch(`${SB_URL}/rest/v1/price_history?select=day,close&order=day.desc&limit=1`, { headers: SB_HEADERS })).json();
  if (c?.[0]) { prevClose = Number(c[0].close); lastSavedDay = c[0].day; }
} catch (e) { console.error("   (no se pudo leer estado previo:", e.message, ")"); }
let from = Math.max(startBn, cursor + 1);
console.log(lastSavedDay
  ? `   Reanudando: última vela ${lastSavedDay}, bloque ${from}`
  : `   Desde cero: bloque ${from} (${dayOfTs(anchorTs)})`);

console.log("③ ETH/USD diario (0 RPC)…");
async function dailyEthUsd(fromMs) {
  const out = new Map();
  try {
    let start = fromMs;
    while (start < Date.now()) {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&startTime=${start}&limit=500`);
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) break;
      for (const k of arr) out.set(new Date(k[0]).toISOString().slice(0, 10), parseFloat(k[4]));
      start = arr[arr.length - 1][6] + 1;
      if (arr.length < 500) break;
    }
  } catch { /* fallback */ }
  if (!out.size) {
    let end = Math.floor(Date.now() / 1000);
    const fromS = Math.floor(fromMs / 1000);
    while (end > fromS) {
      const start = Math.max(fromS, end - 300 * 86400);
      const r = await fetch(`https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) break;
      for (const c of arr) out.set(new Date(c[0] * 1000).toISOString().slice(0, 10), c[4]);
      end = start - 1;
    }
  }
  return out;
}
const ethUsd = await dailyEthUsd((anchorTs - 86400) * 1000);
if (!ethUsd.size) { console.error("Sin datos ETH/USD (¿red?)"); process.exit(1); }
console.log(`   ${ethUsd.size} días de ETH/USD`);
const ethFor = day => {
  if (ethUsd.has(day)) return ethUsd.get(day);
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.parse(day) - i * 864e5).toISOString().slice(0, 10);
    if (ethUsd.has(d)) return ethUsd.get(d);
  }
  return null;
};

/* ── construcción + guardado incremental ───────────────────────────────── */
const byDay = new Map();   // day -> points de ese día (pendientes de guardar)
let candlesSaved = 0;

function buildCandle(day, pts) {
  const eth = ethFor(day);
  if (!eth) return null;
  const prices = pts.map(s => eth / s.p).filter(x => isFinite(x) && x > 0);
  if (!prices.length) {
    if (prevClose == null) return null; // antes del primer swap
    return { day, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume_usd: 0, swaps: 0, source: "onchain" };
  }
  const open = prevClose ?? prices[0];
  const close = prices[prices.length - 1];
  return {
    day, open,
    high: Math.max(open, ...prices),
    low: Math.min(open, ...prices),
    close,
    volume_usd: Math.round(pts.reduce((s, x) => s + x.v * eth, 0) * 100) / 100,
    swaps: prices.length,
    source: "onchain",
  };
}

async function saveCandles(candles, cursorBlock) {
  if (candles.length) {
    const res = await fetch(`${SB_URL}/rest/v1/price_history?on_conflict=day`, {
      method: "POST",
      headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(candles),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    candlesSaved += candles.length;
  }
  await fetch(`${SB_URL}/rest/v1/scan_state?key=eq.price_last_block`, {
    method: "PATCH", headers: SB_HEADERS,
    body: JSON.stringify({ block_number: cursorBlock, updated_at: new Date().toISOString() }),
  });
}

/** Guarda los días COMPLETOS anteriores a `currentDay` (o todos si final=true). */
async function flush(scannedUptoBn, final = false) {
  const currentDay = dayOfTs(tsOf(scannedUptoBn));
  let day = lastSavedDay ? nextDay(lastSavedDay)
    : (byDay.size ? [...byDay.keys()].sort()[0] : null);
  if (!day) return;
  const candles = [];
  while (final ? day <= currentDay : day < currentDay) {
    const c = buildCandle(day, byDay.get(day) || []);
    if (c) { candles.push(c); prevClose = c.close; }
    byDay.delete(day);
    if (day === currentDay) break;
    day = nextDay(day);
  }
  if (!candles.length) return;
  // cursor seguro: último bloque del último día completo guardado
  const lastDay = candles[candles.length - 1].day;
  const safeCursor = final ? scannedUptoBn
    : Math.min(scannedUptoBn, blockAtTs(Math.floor(Date.parse(nextDay(lastDay)) / 1000)) - 1);
  await saveCandles(candles, safeCursor);
  lastSavedDay = lastDay;
}

/* ── escaneo PARALELO (6 workers) con ensamblado en orden ──────────────── */
console.log("④ Escaneando swaps (6 conexiones en paralelo) y guardando sobre la marcha…");
const CONCURRENCY = 6;
let sharedWin = 50_000;
const t0 = Date.now();
let swapsTotal = 0;
let nextStart = from;              // siguiente rango a repartir
let frontier = from;               // procesado EN ORDEN hasta aquí-1
const ready = new Map();           // from -> { to, logs }
let daysSinceFlush = 0, lastFlushDay = null, lastPrint = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function printProgress() {
  const now = Date.now();
  if (now - lastPrint < 300) return;
  lastPrint = now;
  const done = (frontier - startBn) / (latestBn - startBn + 1);
  const eta = done > 0.003 ? Math.round(((now - t0) / 1000) * (1 - done) / done) : null;
  const etaTxt = eta == null ? "?" : eta > 90 ? Math.ceil(eta / 60) + "min" : eta + "s";
  process.stdout.write(
    `\r  📅 ${dayOfTs(tsOf(frontier))}  ${(done * 100).toFixed(1)}%  swaps ${swapsTotal}  velas ${candlesSaved}  reqs ${rpcCalls}  ETA ${etaTxt}      `);
}

let draining = false;
async function drainInOrder() {
  if (draining) return;          // mutex: un solo worker procesa/guarda a la vez
  draining = true;
  try {
  while (ready.has(frontier)) {
    const { to, logs } = ready.get(frontier);
    ready.delete(frontier);
    for (const l of logs) {
      const p = toPoint(l);
      const d = dayOfTs(tsOf(p.b));
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(p);
    }
    swapsTotal += logs.length;
    frontier = to + 1;
    const curDay = dayOfTs(tsOf(Math.min(frontier, latestBn)));
    if (lastFlushDay !== curDay) { daysSinceFlush++; lastFlushDay = curDay; }
    if (daysSinceFlush >= FLUSH_DAYS) {
      await flush(Math.min(frontier - 1, latestBn));
      daysSinceFlush = 0;
    }
  }
  } finally { draining = false; }
  printProgress();
}

async function worker() {
  while (nextStart <= latestBn) {
    const myFrom = nextStart;
    const myTo = Math.min(myFrom + sharedWin - 1, latestBn);
    nextStart = myTo + 1;
    let f = myFrom, t = myTo;
    while (true) {
      try {
        const logs = await rpc("eth_getLogs", [
          { address: POOL, topics: [SWAP_TOPIC], fromBlock: hex(f), toBlock: hex(t) },
        ]);
        ready.set(f, { to: t, logs });
        sharedWin = Math.min(Math.floor(sharedWin * 1.5), 3_000_000);
        await drainInOrder();
        if (t < myTo) { f = t + 1; t = myTo; continue; } // resto del rango original
        break;
      } catch (e) {
        const span = t - f + 1;
        if (span <= 1500) { await sleep(400); continue; } // rango mínimo: reintenta (rate limit)
        t = f + Math.max(Math.floor(span / 3), 1500) - 1;  // encoge y reintenta
        sharedWin = Math.max(Math.floor(sharedWin / 3), 1500);
        await sleep(120);
      }
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await drainInOrder();
await flush(latestBn, true); // incluye la vela de hoy (parcial)
console.log(`\n✅ Completo. ${candlesSaved} velas guardadas en esta ejecución · ${rpcCalls} peticiones RPC · última vela ${lastSavedDay}.`);
console.log("   Si se corta a medias, relanza y continúa solo desde donde iba.");

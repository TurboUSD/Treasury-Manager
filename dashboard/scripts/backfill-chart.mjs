#!/usr/bin/env node
/**
 * backfill-chart.mjs v3 — "una foto por día"
 *
 * Reconstruye el histórico del gráfico "Treasury Composition Over Time"
 * leyendo los BALANCES REALES de cada token en los 4 treasuries a cierre de
 * cada día (una sola petición RPC por día, vía Multicall3). Sin escaneo de
 * logs, sin rangos, sin errores de "block range too large".
 *
 * ~1 petición por día desde feb-2026 (~185 en total). SE EJECUTA UNA VEZ.
 * Después /api/treasury-data añade la foto del día en curso (1 petición/hora).
 *
 * Uso (desde dashboard/):  node scripts/backfill-chart.mjs
 * Env (.env.local): ANKR_RPC_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { readFileSync, existsSync } from "node:fs";

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
  console.error("Faltan env vars: ANKR_RPC_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const SB_HEADERS = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

/* ── contratos (idénticos a treasury-data/route.ts) ── */
const TREASURIES = [
  "0x3dbF93D110C677A1c063A600cb42940262f3BBd6", // v1
  "0xefd86aAd40Cb4340d4ace8B5d8bf7692ADdc02f8", // v2 oldest
  "0x65D240dD9Aa9280DcFb4a5648de8C0668a854E1b", // v2 old
  "0xAF8b3FEBA3411430FAc757968Ac1c9FB25b84107", // v2 activo
];
const TOKENS = [
  "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07", // TUSD
  "0x4200000000000000000000000000000000000006", // WETH
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (6 dec)
  "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b", // BNKR
  "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2", // DRB
  "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb", // Clanker
  "0x50D2280441372486BeecdD328c1854743EBaCb07", // KELLY
  "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07", // CLAWD
  "0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07", // JUNO
  "0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07", // FELIX
];
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const START_TS = 1769904000; // 2026-02-01 (la 1ª operación del treasury es del 18-mar-2026)
const BLOCK_TIME = 2;

const pad32 = a => a.toLowerCase().replace("0x", "").padStart(64, "0");
const hex = n => "0x" + n.toString(16);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let rpcCalls = 0;

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

/* ── Multicall3.aggregate((address,bytes)[]) — codificación ABI manual ── */
const BAL_SIG = "70a08231";
const w = v => BigInt(v).toString(16).padStart(64, "0");

function encodeAggregate(calls) {
  const n = calls.length;
  let s = w(0x20) + w(n);
  for (let i = 0; i < n; i++) s += w(n * 32 + i * 0xa0);
  for (const c of calls) {
    const data = c.data; // 36 bytes (selector + address) → 72 hex chars
    s += pad32(c.to);
    s += w(0x40);
    s += w(data.length / 2);
    s += data.padEnd(128, "0");
  }
  return "0x252dba42" + s;
}

function decodeAggregate(hexOut, n) {
  const buf = hexOut.replace("0x", "");
  const word = i => buf.slice(i * 64, i * 64 + 64);
  const arrBase = parseInt(word(1), 16) / 32; // índice de palabra de la longitud del array
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = parseInt(word(arrBase + 1 + i), 16);
    const li = arrBase + 1 + off / 32;
    const blen = parseInt(word(li), 16);
    out.push(blen === 0 ? 0n : BigInt("0x" + word(li + 1)));
  }
  return out;
}

console.log("① Anclando bloques…");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
const latestBn = parseInt(latest.number, 16);
const latestTs = parseInt(latest.timestamp, 16);
const bnOf = ts => latestBn - Math.round((latestTs - ts) / BLOCK_TIME);

/* cierres de día UTC desde START_TS hasta ahora */
const days = [];
for (let ts = START_TS + 86399; ; ts += 86400) {
  const t = Math.min(ts, latestTs);
  days.push(t);
  if (t === latestTs) break;
}
console.log(`   ${days.length} días (${new Date(START_TS * 1000).toISOString().slice(0, 10)} → hoy) · 1 petición por día`);

const calls = [];
for (const tr of TREASURIES) for (const tok of TOKENS) calls.push({ to: tok, data: BAL_SIG + pad32(tr) });
const callData = encodeAggregate(calls);

console.log("② Leyendo balances diarios (Multicall3)…");
const dailyMap = {};
let running = {};
const t0 = Date.now();

for (let d = 0; d < days.length; d++) {
  const ts = days[d];
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  let out;
  for (let attempt = 0; ; attempt++) {
    try {
      out = await rpc("eth_call", [{ to: MULTICALL3, data: callData }, hex(bnOf(ts))]);
      break;
    } catch (e) {
      if (attempt >= 4) throw new Error(`${date}: ${e.message}`);
      process.stdout.write(`\n  ⚠ ${date}: ${e.message} — reintentando…\n`);
      await sleep(1000 * (attempt + 1));
    }
  }
  const vals = decodeAggregate(out, calls.length);
  const bals = {};
  vals.forEach((v, i) => {
    const tok = TOKENS[i % TOKENS.length].toLowerCase();
    const num = Number(v) / 10 ** (tok === USDC ? 6 : 18);
    if (num > 0) bals[tok] = (bals[tok] || 0) + num;
  });
  if (Object.keys(bals).length > 0) {
    dailyMap[date] = bals;
    running = bals;
  }
  const prog = (d + 1) / days.length;
  const elapsed = (Date.now() - t0) / 1000;
  const eta = Math.round(elapsed / prog - elapsed);
  process.stdout.write(`\r  ${(prog * 100).toFixed(1)}%  ${date}  reqs ${rpcCalls}  ETA ${Math.floor(eta / 60)}m${eta % 60}s   `);
}
const dayKeys = Object.keys(dailyMap).sort();
console.log(`\n   ${dayKeys.length} días con balances (${dayKeys[0]} → ${dayKeys[dayKeys.length - 1]})`);

console.log("③ Guardando estado en Supabase (treasury_cache · chart_history)…");
const state = { lastBlock: latestBn, running, dailyMap, updatedAt: new Date().toISOString() };
const res = await fetch(`${SB_URL}/rest/v1/treasury_cache?on_conflict=key`, {
  method: "POST",
  headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify([{ key: "chart_history", data: state, updated_at: new Date().toISOString() }]),
});
if (!res.ok) { console.error("Supabase:", res.status, await res.text()); process.exit(1); }
console.log(`✅ Completo. ${days.length} días · ${rpcCalls} peticiones RPC.`);
console.log("   Ahora commit + push del route.ts para que Vercel use este estado.");

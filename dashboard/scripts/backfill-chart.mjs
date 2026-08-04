#!/usr/bin/env node
/**
 * backfill-chart.mjs — Reconstruye el estado histórico del gráfico
 * "Treasury Composition Over Time" (balances diarios por token de los 4
 * treasuries) escaneando TODOS los Transfer desde julio 2025, y lo guarda
 * en Supabase (treasury_cache, key='chart_history').
 *
 * SE EJECUTA UNA SOLA VEZ. Después /api/treasury-data solo escanea el delta
 * desde el último bloque — rápido y sin timeouts en Vercel.
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
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GENESIS = 32_400_000; // ~2025-07-04 en Base
const BLOCK_TIME = 2;

const pad32 = a => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");
const hex = n => "0x" + n.toString(16);
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

console.log("① Anclando bloques…");
const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
const latestBn = parseInt(latest.number, 16);
const latestTs = parseInt(latest.timestamp, 16);
const tsOf = bn => latestTs - (latestBn - bn) * BLOCK_TIME;
console.log(`   Rango: ${GENESIS} → ${latestBn}`);

console.log("② Escaneando transfers de los treasuries (adaptativo)…");
const treasuryTopics = TREASURIES.map(pad32);
const logsAll = [];

async function scan(dir) {
  /* dir: "in" (topic2 = treasury) | "out" (topic1 = treasury) */
  const topics = dir === "in"
    ? [TRANSFER_TOPIC, null, treasuryTopics]
    : [TRANSFER_TOPIC, treasuryTopics];
  let from = GENESIS;
  let win = 500_000;
  while (from <= latestBn) {
    const to = Math.min(from + win - 1, latestBn);
    try {
      const logs = await rpc("eth_getLogs", [{
        address: TOKENS, topics, fromBlock: hex(from), toBlock: hex(to),
      }]);
      for (const l of logs) logsAll.push({ ...l, __dir: dir });
      from = to + 1;
      win = Math.min(win * 2, 4_000_000);
      const done = (((dir === "in" ? 0 : 0.5) + ((from - GENESIS) / (latestBn - GENESIS + 1)) / 2) * 100);
      process.stdout.write(`\r  ${done.toFixed(1)}%  logs ${logsAll.length}  reqs ${rpcCalls}   `);
    } catch {
      win = Math.max(Math.floor(win / 3), 2000);
      if (win === 2000 && to - from < 2500) throw new Error("rango mínimo falló — revisa el RPC");
    }
  }
}
await scan("in");
await scan("out");
console.log(`\n   ${logsAll.length} transfers`);

console.log("③ Construyendo balances diarios…");
const treasurySet = new Set(TREASURIES.map(a => a.toLowerCase()));
const events = [];
for (const l of logsAll) {
  const token = l.address.toLowerCase();
  const fromA = "0x" + l.topics[1].slice(26);
  const toA = "0x" + l.topics[2].slice(26);
  const dec = token === USDC ? 6 : 18;
  const v = Number(BigInt(l.data)) / 10 ** dec;
  if (!(v > 0)) continue;
  const bn = parseInt(l.blockNumber, 16);
  /* un transfer treasury→treasury cuenta -1 y +1 (aparece en ambos scans) */
  if (l.__dir === "in" && treasurySet.has(toA)) events.push({ bn, token, v: +v, li: parseInt(l.logIndex, 16) });
  if (l.__dir === "out" && treasurySet.has(fromA)) events.push({ bn, token, v: -v, li: parseInt(l.logIndex, 16) });
}
events.sort((a, b) => a.bn - b.bn || a.li - b.li);

const running = {};
const dailyMap = {};
for (const e of events) {
  running[e.token] = (running[e.token] || 0) + e.v;
  const date = new Date(tsOf(e.bn) * 1000).toISOString().slice(0, 10);
  dailyMap[date] = { ...running };
}
const days = Object.keys(dailyMap).sort();
console.log(`   ${days.length} días con actividad (${days[0]} → ${days[days.length - 1]})`);

console.log("④ Guardando estado en Supabase (treasury_cache · chart_history)…");
const state = { lastBlock: latestBn, running, dailyMap, updatedAt: new Date().toISOString() };
const res = await fetch(`${SB_URL}/rest/v1/treasury_cache?on_conflict=key`, {
  method: "POST",
  headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify([{ key: "chart_history", data: state, updated_at: new Date().toISOString() }]),
});
if (!res.ok) { console.error("Supabase:", res.status, await res.text()); process.exit(1); }
console.log(`✅ Completo. ${events.length} movimientos · ${rpcCalls} peticiones RPC.`);
console.log("   Ahora despliega el route.ts actualizado: usará este estado y solo escaneará deltas.");

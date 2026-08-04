#!/usr/bin/env node
/**
 * backfill-stakes.mjs — Escanea TODOS los depósitos de ₸USD en los contratos
 * de staking (normal y liquid) desde el inicio y los guarda en `stake_events`.
 *
 * SE EJECUTA UNA SOLA VEZ (reanudable con el cursor `stake_last_block`).
 * Después, /api/widget-data mantiene la tabla al día automáticamente.
 *
 * Uso (desde dashboard/):  node scripts/backfill-stakes.mjs
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

const TUSD = "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07";
const STAKING = "0x2a70a42BC0524aBCA9Bff59a51E7aAdB575DC89A";
const LIQUID = "0x2958489b3132f0c9B04d499C21017a8289B021bc";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const START_TS = 1751645717; // 1 día antes de la creación del pool (jul 2025)
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
let startBn = latestBn - Math.ceil((latestTs - START_TS) / BLOCK_TIME);
if (startBn < 1) startBn = 1;
const tsOf = bn => latestTs - (latestBn - bn) * BLOCK_TIME;

// reanudación
let cursor = 0;
try {
  const r = await (await fetch(`${SB_URL}/rest/v1/scan_state?key=eq.stake_last_block&select=block_number`, { headers: SB_HEADERS })).json();
  cursor = Number(r?.[0]?.block_number || 0);
} catch { /* desde cero */ }
let from = Math.max(startBn, cursor + 1);
console.log(`   Rango: bloque ${from} → ${latestBn}`);

console.log("② Escaneando transfers de ₸USD hacia los contratos de staking…");
const events = [];
let win = 200_000;
const t0 = Date.now();
while (from <= latestBn) {
  const to = Math.min(from + win - 1, latestBn);
  try {
    const logs = await rpc("eth_getLogs", [{
      address: TUSD,
      topics: [TRANSFER_TOPIC, null, [pad32(STAKING), pad32(LIQUID)]],
      fromBlock: hex(from), toBlock: hex(to),
    }]);
    for (const l of logs) {
      const toAddr = "0x" + l.topics[2].slice(26);
      const fromAddr = "0x" + l.topics[1].slice(26);
      const amount = Number(BigInt(l.data)) / 1e18;
      if (!(amount > 0)) continue;
      events.push({
        tx_hash: l.transactionHash,
        log_index: parseInt(l.logIndex, 16),
        ts: new Date(tsOf(parseInt(l.blockNumber, 16)) * 1000).toISOString(),
        amount,
        staker: fromAddr,
        contract: toAddr.toLowerCase() === LIQUID.toLowerCase() ? "liquid" : "staking",
      });
    }
    from = to + 1;
    win = Math.min(win * 2, 4_000_000);
    const done = ((from - startBn) / (latestBn - startBn + 1)) * 100;
    process.stdout.write(`\r  ${done.toFixed(1)}%  stakes ${events.length}  reqs ${rpcCalls}   `);
  } catch {
    win = Math.max(Math.floor(win / 3), 2000);
    if (win === 2000 && to - from < 2500) throw new Error("rango mínimo falló");
  }
}
console.log(`\n   ${events.length} depósitos de staking encontrados`);

console.log("③ Guardando en Supabase…");
for (let i = 0; i < events.length; i += 500) {
  const res = await fetch(`${SB_URL}/rest/v1/stake_events?on_conflict=tx_hash,log_index`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(events.slice(i, i + 500)),
  });
  if (!res.ok) { console.error("Supabase:", res.status, await res.text()); process.exit(1); }
}
await fetch(`${SB_URL}/rest/v1/scan_state?key=eq.stake_last_block`, {
  method: "PATCH", headers: SB_HEADERS,
  body: JSON.stringify({ block_number: latestBn, updated_at: new Date().toISOString() }),
});
console.log(`✅ Completo. ${events.length} eventos guardados · ${rpcCalls} peticiones RPC. (${(Date.now() - t0) / 1000 | 0}s)`);

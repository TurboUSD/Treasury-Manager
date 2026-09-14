import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * /api/widget-data — public, CORS-enabled feed for the turbousd.com
 * WordPress widget and the dashboard's AMI ops chart.
 * Returns: operations + stats cache + full ₸USD daily candles (price_history).
 *
 * It also keeps price_history fresh: on each (edge-cached) invocation it
 * scans new pool Swap events since the last cursor and upserts the affected
 * daily candles — ~2 RPC calls per 5 minutes, nothing else to maintain.
 */

export const revalidate = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
};

/* ── incremental candle updater (swaps since cursor → daily OHLC) ── */
const POOL = "0xd013725b904e76394A3aB0334Da306C505D778F8"; // token0=TUSD, token1=WETH (18/18)
const SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const Q192 = 2n ** 192n;
const SCALE = 10n ** 18n;
const BLOCK_TIME = 2;

const RPC_URL = process.env.ANKR_RPC_URL || process.env.NEXT_PUBLIC_RPC_FALLBACK_URL || "";

/* staking: escaneo incremental de depósitos de ₸USD */
const TUSD_TOKEN = "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07";
const STAKING_CONTRACT = "0x2a70a42BC0524aBCA9Bff59a51E7aAdB575DC89A";
const LIQUID_STAKING = "0x2958489b3132f0c9B04d499C21017a8289B021bc";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TREASURIES = new Set([
  "0xaf8b3feba3411430fac757968ac1c9fb25b84107", // v2
  "0x65d240dd9aa9280dcfb4a5648de8c0668a854e1b", // v2 old
  "0xefd86aad40cb4340d4ace8b5d8bf7692addc02f8", // v2 oldest
  "0x3dbf93d110c677a1c063a600cb42940262f3bbd6", // v1
]);
const pad32 = (a: string) => "0x" + a.toLowerCase().replace("0x", "").padStart(64, "0");

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}
const PUBLIC_RPC = "https://mainnet.base.org";
const ETHERSCAN_KEY = process.env.ETHERSCAN_APIKEY || process.env.ETHERSCAN_API_KEY || process.env.BASESCAN_API_KEY || "";

async function rpcAt(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

type LogFilter = { address: string; topics: (string | string[] | null)[]; fromBlock: string; toBlock: string };

async function etherscanGetLogs(f: LogFilter): Promise<{ blockNumber: string; data: string; topics: string[]; transactionHash: string; logIndex: string }[]> {
  // Etherscan V2 covers Base (chainid 8453) on the free tier. It cannot OR
  // multiple values in one topic position, so expand them into one call each.
  const topic2 = f.topics[2];
  const topic2Values: (string | null)[] = Array.isArray(topic2) ? topic2 : [typeof topic2 === "string" ? topic2 : null];
  const out: { blockNumber: string; data: string; topics: string[]; transactionHash: string; logIndex: string }[] = [];
  for (const t2 of topic2Values) {
    const qs = new URLSearchParams({
      chainid: "8453", module: "logs", action: "getLogs",
      address: f.address,
      fromBlock: String(parseInt(f.fromBlock, 16)),
      toBlock: String(parseInt(f.toBlock, 16)),
      topic0: String(f.topics[0]),
      apikey: ETHERSCAN_KEY,
    });
    if (t2) { qs.set("topic2", t2); qs.set("topic0_2_opr", "and"); }
    const res = await fetch(`https://api.etherscan.io/v2/api?${qs}`);
    const j = await res.json();
    if (j.status === "0" && j.message !== "No records found") throw new Error(`etherscan: ${j.result || j.message}`);
    for (const l of j.result || []) {
      out.push({ blockNumber: l.blockNumber, data: l.data, topics: l.topics, transactionHash: l.transactionHash, logIndex: l.logIndex });
    }
  }
  return out;
}

/* getLogs with a fallback chain: primary RPC (Ankr) → public Base RPC →
   Etherscan API (free tier), so one dead/rate-limited provider never
   freezes the scanners again. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getLogsFallback(filter: LogFilter): Promise<any[]> {
  try {
    return await rpcAt(RPC_URL, "eth_getLogs", [filter]);
  } catch (e1) {
    console.warn("[Scanner] primary RPC getLogs failed, trying public RPC:", (e1 as Error).message);
  }
  try {
    return await rpcAt(PUBLIC_RPC, "eth_getLogs", [filter]);
  } catch (e2) {
    console.warn("[Scanner] public RPC getLogs failed:", (e2 as Error).message);
  }
  if (ETHERSCAN_KEY) {
    return await etherscanGetLogs(filter);
  }
  throw new Error("all getLogs providers failed");
}

const dayOfTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const nextDay = (d: string) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshCandles(sb: any, wethPriceUsd: number) {
  if (!RPC_URL || !wethPriceUsd) return;

  const { data: st } = await sb.from("scan_state").select("block_number, updated_at").eq("key", "price_last_block").single();
  const cursor = Number(st?.block_number || 0);
  if (!cursor) return; // backfill aún no ejecutado
  // Throttle: at most one scan per minute (the edge cache already limits
  // normal traffic; this belt just prevents RPC hammering).
  if (st?.updated_at && Date.now() - new Date(st.updated_at).getTime() < 60 * 1000) return;

  let latest;
  try {
    latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  } catch {
    latest = await rpcAt(PUBLIC_RPC, "eth_getBlockByNumber", ["latest", false]);
  }
  const latestBn = parseInt(latest.number, 16);
  const latestTs = parseInt(latest.timestamp, 16);
  if (latestBn <= cursor) return;
  const from = cursor + 1;
  const tsOf = (bn: number) => latestTs - (latestBn - bn) * BLOCK_TIME;

  // BUGFIX: public RPCs reject large eth_getLogs ranges. A single 1M-block
  // request meant that once the backlog grew past the RPC limit, EVERY call
  // failed, the error was swallowed and the cursor never advanced — the
  // price history froze (last stuck on 2026-09-04). Scan in small chunks and
  // advance the cursor to the last chunk that succeeded, so each invocation
  // makes progress and the backlog drains over a few calls.
  const CHUNK = 2_000;
  const MAX_CHUNKS = 40; // ≤ ~80k blocks of work per invocation
  let logs: { blockNumber: string; data: string }[] = [];
  let to = from - 1;
  for (let c = 0; c < MAX_CHUNKS; c++) {
    const cFrom = to + 1;
    if (cFrom > latestBn) break;
    const cTo = Math.min(latestBn, cFrom + CHUNK - 1);
    try {
      const chunkLogs = await getLogsFallback(
        { address: POOL, topics: [SWAP_TOPIC], fromBlock: "0x" + cFrom.toString(16), toBlock: "0x" + cTo.toString(16) },
      );
      logs = logs.concat(chunkLogs || []);
      to = cTo;
    } catch (e) {
      console.error(`[Scanner] price chunk ${cFrom}-${cTo} FAILED:`, e);
      break; // keep what we have; the cursor advances to the last good chunk
    }
  }
  if (to < from) {
    console.error(`[Scanner] price backfill made NO progress from block ${from} — check RPC_URL / getLogs limits`);
    return; // nothing scanned this round — retry next invocation
  }
  console.log(`[Scanner] price backfill advanced ${from}→${to} (${logs.length} swaps)`);

  // última vela guardada (para open/carry-forward)
  const { data: lastRows } = await sb.from("price_history").select("day, open, high, low, close, swaps").order("day", { ascending: false }).limit(1);
  const last = lastRows?.[0];
  if (!last) return;

  // puntos nuevos → precio USD usando el WETH/USD actual de la cache
  const pts = logs
    .map(l => {
      const sqrt = BigInt("0x" + l.data.slice(2 + 64 * 2, 2 + 64 * 2 + 64));
      const tusdPerWeth = Number((Q192 * SCALE) / (sqrt * sqrt)) / 1e18;
      return { day: dayOfTs(tsOf(parseInt(l.blockNumber, 16))), price: wethPriceUsd / tusdPerWeth };
    })
    .filter(p => isFinite(p.price) && p.price > 0);

  // construir/actualizar velas desde el día siguiente a la última guardada hasta hoy
  const todayScanned = dayOfTs(tsOf(to));
  const byDay = new Map<string, number[]>();
  for (const p of pts) {
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day)!.push(p.price);
  }
  const upserts: Record<string, unknown>[] = [];
  let prevClose = Number(last.close);
  // el último día guardado puede recibir swaps nuevos → merge con la vela existente
  let day = last.day as string;
  while (day <= todayScanned) {
    const prices = byDay.get(day) || [];
    const existing = day === last.day ? last : null;
    if (existing) {
      if (prices.length) {
        const close = prices[prices.length - 1];
        upserts.push({
          day,
          open: Number(existing.open),
          high: Math.max(Number(existing.high), ...prices),
          low: Math.min(Number(existing.low), ...prices),
          close,
          // BUGFIX: the merge branch never updated the swap counter, so days
          // created flat first showed swaps=0 forever even though their
          // prices kept updating.
          swaps: Number((existing as { swaps?: number }).swaps || 0) + prices.length,
          source: "onchain",
        });
        prevClose = close;
      }
    } else if (prices.length) {
      const close = prices[prices.length - 1];
      upserts.push({
        day, open: prevClose,
        high: Math.max(prevClose, ...prices),
        low: Math.min(prevClose, ...prices),
        close, swaps: prices.length, source: "onchain",
      });
      prevClose = close;
    } else {
      upserts.push({ day, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume_usd: 0, swaps: 0, source: "onchain" });
    }
    if (day === todayScanned) break;
    day = nextDay(day);
  }

  if (upserts.length) {
    // BUGFIX: supabase-js does NOT throw on error — an unchecked failing
    // upsert (e.g. a missing column) silently dropped every candle while the
    // cursor kept advancing. Surface the error and do NOT advance past
    // unsaved candles.
    const { error: upErr } = await sb.from("price_history").upsert(upserts, { onConflict: "day" });
    if (upErr) {
      console.error("[Scanner] price_history upsert FAILED:", upErr);
      return;
    }
    console.log(`[Scanner] price_history upserted ${upserts.length} candle(s) up to ${todayScanned}`);
  }
  await sb.from("scan_state").update({ block_number: to, updated_at: new Date().toISOString() }).eq("key", "price_last_block");

  /* stakes nuevos desde el cursor de staking (1 getLogs extra) */
  try {
    const { data: sst } = await sb.from("scan_state").select("block_number").eq("key", "stake_last_block").single();
    const sCursor = Number(sst?.block_number || 0);
    if (sCursor > 0 && latestBn > sCursor) {
      // BUGFIX: same disease as the price scanner — a single huge getLogs
      // fails with "Block range is too large" once the backlog grows, and
      // the cursor never advances. Scan in small chunks instead.
      const S_CHUNK = 2_000;
      const S_MAX_CHUNKS = 40;
      let sLogs: { transactionHash: string; logIndex: string; blockNumber: string; data: string; topics: string[] }[] = [];
      let sTo = sCursor;
      for (let c = 0; c < S_MAX_CHUNKS; c++) {
        const cFrom = sTo + 1;
        if (cFrom > latestBn) break;
        const cTo = Math.min(latestBn, cFrom + S_CHUNK - 1);
        try {
          const chunk = await getLogsFallback({
            address: TUSD_TOKEN,
            topics: [TRANSFER_TOPIC, null, [pad32(STAKING_CONTRACT), pad32(LIQUID_STAKING)]],
            fromBlock: "0x" + cFrom.toString(16),
            toBlock: "0x" + cTo.toString(16),
          });
          sLogs = sLogs.concat(chunk || []);
          sTo = cTo;
        } catch (e) {
          console.error(`[Scanner] stake chunk ${cFrom}-${cTo} FAILED:`, e);
          break;
        }
      }
      if (sTo <= sCursor) return;
      const rows = sLogs
        .map(l => {
          const amount = Number(BigInt(l.data)) / 1e18;
          const toAddr = ("0x" + l.topics[2].slice(26)).toLowerCase();
          return {
            tx_hash: l.transactionHash,
            log_index: parseInt(l.logIndex, 16),
            ts: new Date(tsOf(parseInt(l.blockNumber, 16)) * 1000).toISOString(),
            amount,
            staker: ("0x" + l.topics[1].slice(26)).toLowerCase(),
            contract: toAddr === LIQUID_STAKING.toLowerCase() ? "liquid" : "staking",
          };
        })
        .filter(r => r.amount > 0);
      if (rows.length) await sb.from("stake_events").upsert(rows, { onConflict: "tx_hash,log_index" });
      await sb.from("scan_state").update({ block_number: sTo, updated_at: new Date().toISOString() }).eq("key", "stake_last_block");
    }
  } catch (e) {
    console.error("stake scan:", e);
  }
}

/* ── Legacy TreasuryManager v1 ops (pre-date the operations table) ──
   These live hardcoded in the dashboard's Treasury Activity table
   (HISTORICAL_OPS_RAW) and are NOT in Supabase on purpose: the dashboard
   already accounts their totals separately, and inserting them into the
   table would double-count burns/buybacks and leak into the CoinTracking
   export. They are appended here so the CHARTS show them, with the v1
   author label. token_price_usd is filled from price_history at runtime. */
const LEGACY_V1_OPS = [
  {
    /* Burn gigante de Clanker (no lo hizo el treasury): 900.76M ₸USD a dead
       vía Gelato desde el LegacyFeeSource. Autor: Clanker. */
    type: "Spend",
    op_type: "Burn",
    buy_amount: null as number | null,
    buy_currency: null as string | null,
    sell_amount: 900671873.71,
    sell_currency: "TUSD2",
    exchange: "Clanker",
    weth_price_usd: null as number | null,
    token_price_usd: 0.00000526053, // $4,738.01 reales en el momento del burn
    tx_hash: "0xdf4ed80b30aa65beeda96899ca344a46e207f5f54c193da7447944660c7d21ab",
    date_utc: "2025-10-23T17:17:13Z",
  },
  {
    type: "Trade",
    op_type: "Buyback",
    buy_amount: 22024060,
    buy_currency: "TUSD2",
    sell_amount: 100,
    sell_currency: "USDC",
    exchange: "Treasury Manager v1",
    weth_price_usd: null as number | null,
    token_price_usd: null as number | null,
    tx_hash: "0x5c3aac4e5ff14e22313f485d01b19432fd1294acf1740055f3e77f0ce7c5362b",
    date_utc: "2026-03-18T12:00:00Z",
  },
  {
    type: "Spend",
    op_type: "Burn",
    buy_amount: null as number | null,
    buy_currency: null as string | null,
    sell_amount: 43147461,
    sell_currency: "TUSD2",
    exchange: "Treasury Manager v1",
    weth_price_usd: null as number | null,
    token_price_usd: null as number | null,
    tx_hash: "0xa590b565b381eea85b144cd39821d301fb7d23d4c13e4a147033d87491db161c",
    date_utc: "2026-03-18T12:00:01Z",
  },
  {
    type: "Spend",
    op_type: "BurnEngine",
    buy_amount: null as number | null,
    buy_currency: null as string | null,
    sell_amount: 1000,
    sell_currency: "TUSD2",
    exchange: "BurnEngine v1",
    weth_price_usd: null as number | null,
    token_price_usd: null as number | null,
    tx_hash: "0xe39ab49ffd9894e21ecfd8f7eec071ffef09587b19e57503680f1a51fc297c0b",
    date_utc: "2026-03-18T12:00:02Z",
  },
  {
    type: "Spend",
    op_type: "BurnEngine",
    buy_amount: null as number | null,
    buy_currency: null as string | null,
    sell_amount: 1000,
    sell_currency: "TUSD2",
    exchange: "BurnEngine v1",
    weth_price_usd: null as number | null,
    token_price_usd: null as number | null,
    tx_hash: "0xb8df47dcd3ff0e07efa98007360dba7d0ab74058bd283163c9db397d34913f96",
    date_utc: "2026-03-18T12:00:03Z",
  },
];

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const sb = getSupabaseAdmin();

    const [{ data: operations, error: opsErr }, { data: cacheRow, error: cacheErr }] = await Promise.all([
      sb
        .from("operations")
        .select(
          "type,op_type,buy_amount,buy_currency,sell_amount,sell_currency,exchange,weth_price_usd,token_price_usd,tx_hash,date_utc",
        )
        .order("date_utc", { ascending: true })
        .limit(5000),
      sb.from("treasury_cache").select("data, updated_at").eq("key", "current").single(),
    ]);

    if (opsErr) throw opsErr;

    const d = (cacheErr ? null : (cacheRow?.data as Record<string, unknown>)) || {};
    const cache = {
      data: {
        totalManagedUsd: d.totalManagedUsd ?? null,
        tusdBurnedNum: d.tusdBurnedNum ?? null,
        engineBurned: d.engineBurned ?? null,
        tusdPriceUsd: d.tusdPriceUsd ?? null,
        tusdSupplyNum: d.tusdSupplyNum ?? null,
        tusdStakedNum: d.tusdStakedNum ?? null,
        tusdLiquidStakedNum: d.tusdLiquidStakedNum ?? null,
        tusdBalNum: d.tusdBalNum ?? null,
      },
      updated_at: cacheErr ? null : (cacheRow?.updated_at ?? null),
    };

    // mantener las velas al día (barato: ~2 RPC como mucho, autolimitado a 1 vez/4min)
    try {
      await refreshCandles(sb, Number(d.wethPriceUsd || 0));
    } catch (e) {
      console.error("refreshCandles:", e);
    }

    // histórico completo de velas diarias (propio, on-chain)
    const { data: candles } = await sb
      .from("price_history")
      .select("day,open,high,low,close,volume_usd,swaps")
      .order("day", { ascending: true })
      .limit(3000);

    // Valorar las ops legacy v1 con el precio real de su día (de nuestras velas)
    const closeByDay = new Map<string, number>();
    for (const c of candles || []) closeByDay.set(String(c.day), Number(c.close));
    const dbTx = new Set((operations || []).map(o => o.tx_hash).filter(Boolean));
    const legacy = LEGACY_V1_OPS.filter(o => !dbTx.has(o.tx_hash)).map(o => ({
      ...o,
      token_price_usd: o.token_price_usd ?? closeByDay.get(o.date_utc.slice(0, 10)) ?? null,
    }));

    /* stakes on-chain (todos los stakers) → ops sintéticas para el gráfico.
       Los stakes que AMI ya registró en operations se saltan (dedup por tx). */
    const { data: stakeEvents } = await sb
      .from("stake_events")
      .select("tx_hash,log_index,ts,amount,staker,contract")
      .order("ts", { ascending: true })
      .limit(3000);
    const stakes = (stakeEvents || [])
      .filter(s => !dbTx.has(s.tx_hash))
      .map(s => ({
        type: "Stake",
        op_type: "Stake",
        buy_amount: null as number | null,
        buy_currency: null as string | null,
        sell_amount: Number(s.amount),
        sell_currency: "TUSD2",
        exchange:
          s.contract === "liquid"
            ? "Liquid staking"
            : TREASURIES.has((s.staker || "").toLowerCase())
              ? "Treasury Manager"
              : "Staking contract",
        weth_price_usd: null as number | null,
        token_price_usd: closeByDay.get(String(s.ts).slice(0, 10)) ?? null,
        tx_hash: s.tx_hash,
        date_utc: new Date(s.ts).toISOString(),
      }));

    const allOps = [...legacy, ...stakes, ...(operations || [])].sort(
      (a, b) => Date.parse(a.date_utc) - Date.parse(b.date_utc),
    );

    return NextResponse.json({ operations: allOps, cache, candles: candles || [] }, { headers: CORS_HEADERS });
  } catch (e) {
    console.error("widget-data failed:", e);
    return NextResponse.json({ error: "widget-data unavailable" }, { status: 500, headers: CORS_HEADERS });
  }
}

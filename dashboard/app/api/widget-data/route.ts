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
const dayOfTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
const nextDay = (d: string) => new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function refreshCandles(sb: any, wethPriceUsd: number) {
  if (!RPC_URL || !wethPriceUsd) return;

  const { data: st } = await sb.from("scan_state").select("block_number, updated_at").eq("key", "price_last_block").single();
  const cursor = Number(st?.block_number || 0);
  if (!cursor) return; // backfill aún no ejecutado
  // no escanear más de 1 vez cada 4 min (el edge-cache ya limita, esto es el cinturón)
  if (st?.updated_at && Date.now() - new Date(st.updated_at).getTime() < 4 * 60 * 1000) return;

  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const latestBn = parseInt(latest.number, 16);
  const latestTs = parseInt(latest.timestamp, 16);
  if (latestBn <= cursor) return;
  const from = cursor + 1;
  const to = Math.min(latestBn, from + 1_000_000); // backlog acotado; el resto en la siguiente llamada
  const tsOf = (bn: number) => latestTs - (latestBn - bn) * BLOCK_TIME;

  let logs: { blockNumber: string; data: string }[] = [];
  try {
    logs = await rpc("eth_getLogs", [
      { address: POOL, topics: [SWAP_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) },
    ]);
  } catch {
    return; // rango demasiado denso: se reintenta en la siguiente invocación
  }

  // última vela guardada (para open/carry-forward)
  const { data: lastRows } = await sb.from("price_history").select("day, open, high, low, close").order("day", { ascending: false }).limit(1);
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
    await sb.from("price_history").upsert(upserts, { onConflict: "day" });
  }
  await sb.from("scan_state").update({ block_number: to, updated_at: new Date().toISOString() }).eq("key", "price_last_block");
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
    const allOps = [...legacy, ...(operations || [])].sort(
      (a, b) => Date.parse(a.date_utc) - Date.parse(b.date_utc),
    );

    return NextResponse.json({ operations: allOps, cache, candles: candles || [] }, { headers: CORS_HEADERS });
  } catch (e) {
    console.error("widget-data failed:", e);
    return NextResponse.json({ error: "widget-data unavailable" }, { status: 500, headers: CORS_HEADERS });
  }
}

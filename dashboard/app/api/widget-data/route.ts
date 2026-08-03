import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * /api/widget-data — public, CORS-enabled feed for the turbousd.com
 * WordPress widget (AMI operations chart). Read-only: returns the
 * operations list plus the stats snapshot from treasury_cache.
 * No secrets are exposed — this is the same data the dashboard shows.
 */

export const revalidate = 0;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Cache at the edge for 5 min so widget traffic never hammers Supabase
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
};

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
          "type,op_type,buy_amount,buy_currency,sell_amount,sell_currency,weth_price_usd,token_price_usd,tx_hash,date_utc",
        )
        .order("date_utc", { ascending: true })
        .limit(5000),
      sb.from("treasury_cache").select("data, updated_at").eq("key", "current").single(),
    ]);

    if (opsErr) throw opsErr;

    // Only expose the cache fields the widget needs (keep payload small)
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

    return NextResponse.json({ operations: operations || [], cache }, { headers: CORS_HEADERS });
  } catch (e) {
    console.error("widget-data failed:", e);
    return NextResponse.json({ error: "widget-data unavailable" }, { status: 500, headers: CORS_HEADERS });
  }
}

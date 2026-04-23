import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * GET /api/export-operations-csv
 *
 * Exports operations from Supabase as a CoinTracking-compatible .csv file.
 * Matches the exact format of CoinTracking's "Trade Table" CSV export:
 * - All fields double-quoted
 * - Numeric amounts with 8 decimal places (period separator)
 * - TUSD2 amounts rounded to 2 decimals (ceiling on .5)
 * - Add Date = Date (same value)
 * - Empty fields as ""
 *
 * Query params:
 *   ?from=2026-04-06  — optional, filter from this date (inclusive)
 *   ?to=2026-12-31    — optional, filter to this date (inclusive)
 */
export async function GET(request: Request) {
  try {
    const sb = getSupabaseAdmin();
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    // Fetch all ops — filtering is done in JS after fetching
    let query = sb
      .from("operations")
      .select("*")
      .order("date_utc", { ascending: true });

    if (from) query = query.gte("date_utc", `${from}T00:00:00Z`);
    if (to) query = query.lte("date_utc", `${to}T23:59:59Z`);

    const { data: ops, error } = await query.limit(10000);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!ops || ops.length === 0) {
      return new Response("No operations found", { status: 404 });
    }

    // FeeClaim & Burn transactions: only export the "Other Fee" (gas) row,
    // and only if AMI wrote it (source !== "scanner"). All other rows
    // (Spend, FeeClaim rewards, Buyback, BurnEngine) are dashboard-only.
    const dashboardOnlyTxHashes = new Set(
      ops
        .filter(op => op.op_type === "FeeClaim" || op.op_type === "BurnEngine")
        .map(op => op.tx_hash)
        .filter(Boolean),
    );
    const filteredOps = ops.filter(op => {
      if (op.tx_hash && dashboardOnlyTxHashes.has(op.tx_hash)) {
        return op.type === "Other Fee" && op.source !== "scanner";
      }
      return true;
    });

    const headers = [
      "Type", "Buy", "Cur.", "Sell", "Cur.", "Fee", "Cur.",
      "Exchange", "Group", "Comment", "Trade ID", "Imported From",
      "Add Date", "Date", "From Address", "To Address",
      "Tx Hash", "Sell From Address", "Sell To Address",
    ];

    const rows: string[] = [];
    rows.push(headers.map(h => q(h)).join(","));

    for (const op of filteredOps) {
      const dateMadrid = op.date_madrid || "";

      let buyAmt = op.buy_amount != null ? Number(op.buy_amount) : null;
      let sellAmt = op.sell_amount != null ? Number(op.sell_amount) : null;

      // Round to 2 decimals (ceiling) for all tokens except ETH, WETH, USDC
      const keepFullDecimals = new Set(["ETH", "WETH", "USDC"]);
      if (buyAmt != null && !keepFullDecimals.has(op.buy_currency || "")) {
        buyAmt = roundCeil2(buyAmt);
      }
      if (sellAmt != null && !keepFullDecimals.has(op.sell_currency || "")) {
        sellAmt = roundCeil2(sellAmt);
      }

      rows.push([
        q(op.type || ""),                          // Type
        q(fmtNum(buyAmt, op.buy_currency)),        // Buy
        q(op.buy_currency || ""),                   // Cur.
        q(fmtNum(sellAmt, op.sell_currency)),       // Sell
        q(op.sell_currency || ""),                   // Cur.
        q(""),                                      // Fee
        q(""),                                      // Cur.
        q(op.exchange || "Treasury Manager"),        // Exchange
        q(op.group_name || ""),                      // Group
        q(op.comment || ""),                         // Comment
        q(op.trade_id || ""),                        // Trade ID
        q(""),                                       // Imported From
        q(dateMadrid),                               // Add Date = Date
        q(dateMadrid),                               // Date
        q(""),                                       // From Address
        q(""),                                       // To Address
        q(""),                                       // Tx Hash
        q(""),                                       // Sell From Address
        q(""),                                       // Sell To Address
      ].join(","));
    }

    const csv = rows.join("\n");
    const filename = `CoinTracking_Trade_Table_${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("CSV export error:", error);
    return NextResponse.json(
      { error: "Failed to export operations CSV", details: String(error) },
      { status: 500 },
    );
  }
}

/** Double-quote a CSV field, escaping inner quotes */
function q(val: string): string {
  return `"${val.replace(/"/g, '""')}"`;
}

/** Format number: 8 decimals for ETH/WETH/USDC, 2 decimals for everything else */
function fmtNum(n: number | null, currency?: string | null): string {
  if (n == null) return "";
  const keepFull = new Set(["ETH", "WETH", "USDC"]);
  if (keepFull.has(currency || "")) return n.toFixed(8);
  return n.toFixed(2);
}

/** Round to 2 decimals, half-up (standard rounding: 3rd decimal >= 5 rounds up) */
function roundCeil2(n: number): number {
  return Math.round(n * 100) / 100;
}

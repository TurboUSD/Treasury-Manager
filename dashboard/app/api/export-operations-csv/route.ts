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

    let query = sb
      .from("operations")
      .select("*")
      .not("op_type", "in", "(BurnEngine,FeeClaim)")
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

    const headers = [
      "Type", "Buy", "Cur.", "Sell", "Cur.", "Fee", "Cur.",
      "Exchange", "Group", "Comment", "Trade ID", "Imported From",
      "Add Date", "Date", "From Address", "To Address",
      "Tx Hash", "Sell From Address", "Sell To Address",
    ];

    const rows: string[] = [];
    rows.push(headers.map(h => q(h)).join(","));

    for (const op of ops) {
      const dateMadrid = op.date_madrid || "";

      let buyAmt = op.buy_amount != null ? Number(op.buy_amount) : null;
      let sellAmt = op.sell_amount != null ? Number(op.sell_amount) : null;

      if (op.buy_currency === "TUSD2" && buyAmt != null) {
        buyAmt = roundTusd(buyAmt);
      }
      if (op.sell_currency === "TUSD2" && sellAmt != null) {
        sellAmt = roundTusd(sellAmt);
      }

      rows.push([
        q(op.type || ""),                          // Type
        q(fmtNum(buyAmt)),                         // Buy
        q(op.buy_currency || ""),                   // Cur.
        q(fmtNum(sellAmt)),                         // Sell
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

/** Format number with 8 decimal places, or empty string if null */
function fmtNum(n: number | null): string {
  if (n == null) return "";
  return n.toFixed(8);
}

/** Round TUSD2 amounts to 2 decimals, ceiling on .5 */
function roundTusd(n: number): number {
  return Math.ceil(n * 100 - 0.0000001) / 100;
}

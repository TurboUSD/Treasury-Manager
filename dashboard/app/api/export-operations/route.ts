import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * GET /api/export-operations
 *
 * Exports all operations from Supabase as a CoinTracking-compatible CSV (semicolon-delimited).
 * CoinTracking accepts .csv with semicolons when you choose "CoinTracking CSV" import.
 *
 * Columns match CoinTracking's expected format:
 *   "Type","Buy Amount","Buy Currency","Sell Amount","Sell Currency",
 *   "Fee","Fee Currency","Exchange","Group","Comment","Date","Trade-ID","Add. Date"
 *
 * Query params:
 *   ?from=2026-04-06  — optional, filter from this date (inclusive)
 *   ?to=2026-12-31    — optional, filter to this date (inclusive)
 *
 * Protected: only owner/operator can access (check done client-side;
 * the route itself is accessible but operations data is public-read anyway).
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

    // Build CSV rows
    // CoinTracking CSV header
    const header = [
      "Type",
      "Buy Amount",
      "Buy Currency",
      "Sell Amount",
      "Sell Currency",
      "Fee",
      "Fee Currency",
      "Exchange",
      "Group",
      "Comment",
      "Date",
      "Trade-ID",
      "Add. Date",
    ];

    const rows: string[][] = [];

    for (const op of ops) {
      // Use pre-formatted Madrid date from the DB
      const dateMadrid = op.date_madrid || "";

      // For CoinTracking: TUSD2 amounts rounded to 2 decimals (ceiling on .5)
      let buyAmt = op.buy_amount != null ? String(op.buy_amount) : "";
      let sellAmt = op.sell_amount != null ? String(op.sell_amount) : "";

      if (op.buy_currency === "TUSD2" && buyAmt) {
        buyAmt = roundTusd(Number(buyAmt));
      }
      if (op.sell_currency === "TUSD2" && sellAmt) {
        sellAmt = roundTusd(Number(sellAmt));
      }

      rows.push([
        op.type || "",
        buyAmt,
        op.buy_currency || "",
        sellAmt,
        op.sell_currency || "",
        "", // Fee — empty (gas is separate "Other Fee" row)
        "", // Fee Currency
        op.exchange || "Treasury Manager",
        op.group_name || "Treasury Manager",
        op.comment || "",
        dateMadrid,
        op.trade_id || "",
        op.add_date || "",
      ]);
    }

    // Build CSV string (semicolon-delimited for CoinTracking)
    const csvHeader = header.map(h => `"${h}"`).join(";");
    const csvRows = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(";"));
    const csvContent = [csvHeader, ...csvRows].join("\n");

    // Return as downloadable CSV file
    const filename = `TurboUSD_Operations_${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("Export error:", error);
    return NextResponse.json(
      { error: "Failed to export operations", details: String(error) },
      { status: 500 },
    );
  }
}

/** Round TUSD2 amounts to 2 decimals, ceiling on .5 */
function roundTusd(n: number): string {
  return (Math.ceil(n * 100 - 0.0000001) / 100).toFixed(2);
}

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * GET /api/export-operations
 *
 * Exports operations from Supabase as a CoinTracking-compatible .xlsx file.
 * ExcelJS is loaded dynamically at runtime to avoid webpack bundling it
 * (which causes 20+ minute builds on Vercel).
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

    // Dynamic import — keeps exceljs out of the webpack bundle
    const ExcelJS = (await import("exceljs")).default;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");

    // Row 1: Merged title
    ws.mergeCells("A1:S1");
    const titleCell = ws.getCell("A1");
    titleCell.value = "CoinTracking \u00b7 Trade Table";
    titleCell.font = { bold: true, size: 14 };

    // Row 2: Headers
    const headers = [
      "Type", "Buy", "Cur.", "Sell", "Cur.", "Fee", "Cur.",
      "Exchange", "Group", "Comment", "Trade ID", "Imported From",
      "Add Date", "Date", "From Address", "To Address",
      "Tx Hash", "Sell From Address", "Sell To Address",
    ];
    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };

    // Data rows
    const keepFull = new Set(["ETH", "WETH", "USDC"]);
    for (const op of ops) {
      const dateMadrid = op.date_madrid || "";

      let buyAmt: number | null = op.buy_amount != null ? Number(op.buy_amount) : null;
      let sellAmt: number | null = op.sell_amount != null ? Number(op.sell_amount) : null;

      if (buyAmt != null && !keepFull.has(op.buy_currency || "")) {
        buyAmt = roundHalfUp2(buyAmt);
      }
      if (sellAmt != null && !keepFull.has(op.sell_currency || "")) {
        sellAmt = roundHalfUp2(sellAmt);
      }

      ws.addRow([
        op.type || "",
        buyAmt,
        op.buy_currency || null,
        sellAmt,
        op.sell_currency || null,
        null,
        null,
        op.exchange || "Treasury Manager",
        op.group_name || "",
        op.comment || "",
        op.trade_id || null,
        "Supabase",
        dateMadrid,
        dateMadrid,
        null, null, null, null, null,
      ]);
    }

    // Auto-fit column widths
    ws.columns.forEach(col => {
      let maxLen = 8;
      if (col.eachCell) {
        col.eachCell({ includeEmpty: false }, cell => {
          const len = cell.value ? String(cell.value).length : 0;
          if (len > maxLen) maxLen = len;
        });
      }
      col.width = Math.min(maxLen + 2, 50);
    });

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `TurboUSD_Operations_${new Date().toISOString().slice(0, 10)}.xlsx`;

    return new Response(buffer as ArrayBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

/** Round to 2 decimals, half-up */
function roundHalfUp2(n: number): number {
  return Math.round(n * 100) / 100;
}

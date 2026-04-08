import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * GET /api/export-operations
 *
 * Exports operations from Supabase as a CoinTracking-compatible .xlsx file.
 * Format matches exactly the CoinTracking Trade Table export layout:
 *
 * Row 1: Merged title "CoinTracking · Trade Table" (A1:S1)
 * Row 2: Headers —
 *   Type | Buy | Cur. | Sell | Cur. | Fee | Cur. | Exchange | Group | Comment |
 *   Trade ID | Imported From | Add Date | Date | From Address | To Address |
 *   Tx Hash | Sell From Address | Sell To Address
 *
 * Numeric amounts use COMMA as decimal separator (European format).
 * TUSD2 amounts rounded to 2 decimals (ceiling on .5).
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
      .not("op_type", "in", "(BurnEngine,FeeClaim)")  // Scanner-written passive events excluded from CoinTracking
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

    // ── Build Excel workbook matching CoinTracking format ─────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");

    // Row 1: Merged title
    ws.mergeCells("A1:S1");
    const titleCell = ws.getCell("A1");
    titleCell.value = "CoinTracking · Trade Table";
    titleCell.font = { bold: true, size: 14 };

    // Row 2: Headers (exact CoinTracking column names)
    const headers = [
      "Type",           // A
      "Buy",            // B
      "Cur.",           // C
      "Sell",           // D
      "Cur.",           // E
      "Fee",            // F
      "Cur.",           // G
      "Exchange",       // H
      "Group",          // I
      "Comment",        // J
      "Trade ID",       // K
      "Imported From",  // L
      "Add Date",       // M
      "Date",           // N
      "From Address",   // O
      "To Address",     // P
      "Tx Hash",        // Q
      "Sell From Address", // R
      "Sell To Address",   // S
    ];
    const headerRow = ws.addRow(headers);
    headerRow.font = { bold: true };

    // Data rows
    for (const op of ops) {
      const dateMadrid = op.date_madrid || "";

      // TUSD2 rounding (ceiling on .5)
      let buyAmt: number | null = op.buy_amount != null ? Number(op.buy_amount) : null;
      let sellAmt: number | null = op.sell_amount != null ? Number(op.sell_amount) : null;

      if (op.buy_currency === "TUSD2" && buyAmt != null) {
        buyAmt = roundTusdNum(buyAmt);
      }
      if (op.sell_currency === "TUSD2" && sellAmt != null) {
        sellAmt = roundTusdNum(sellAmt);
      }

      ws.addRow([
        op.type || "",                          // A: Type
        buyAmt,                                 // B: Buy (number or null)
        op.buy_currency || null,                // C: Cur.
        sellAmt,                                // D: Sell (number or null)
        op.sell_currency || null,               // E: Cur.
        null,                                   // F: Fee (empty — gas is separate row)
        null,                                   // G: Cur.
        op.exchange || "Treasury Manager",      // H: Exchange
        op.group_name || "",                    // I: Group
        op.comment || "",                       // J: Comment (basescan link)
        op.trade_id || null,                    // K: Trade ID
        "Supabase",                             // L: Imported From
        op.add_date || null,                    // M: Add Date
        dateMadrid,                             // N: Date (Madrid timezone)
        null,                                   // O: From Address
        null,                                   // P: To Address
        null,                                   // Q: Tx Hash
        null,                                   // R: Sell From Address
        null,                                   // S: Sell To Address
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

    // Generate buffer
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

/** Round TUSD2 amounts to 2 decimals, ceiling on .5. Returns number. */
function roundTusdNum(n: number): number {
  return Math.ceil(n * 100 - 0.0000001) / 100;
}

import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "~~/utils/supabase";

/**
 * POST /api/vercel-budget — where Vercel's Spend Management sends its budget alerts (Settings → Billing →
 * Spend Management → Webhook). Vercel posts `{ budgetAmount, currentSpend, teamId, thresholdPercent }` when the
 * team's on-demand spend reaches 50%, 75% and 100% of the budget. The alert is kept in treasury_cache (key
 * "vercel_budget"), where AMI 9000 reads it every few minutes and tells the owner on Telegram.
 *
 * Only the TurboUSD team's alerts are kept. With VERCEL_BUDGET_WEBHOOK_KEY set, the URL must also carry it
 * (?key=…), so nobody else can file an alert.
 */
export const dynamic = "force-dynamic";

const TEAM_ID = "team_bcekfnQP7lZAlwD975kaLEQO";

type BudgetAlert = { budgetAmount: number; currentSpend: number; teamId: string; thresholdPercent: number };

const isAlert = (b: unknown): b is BudgetAlert =>
  !!b &&
  typeof b === "object" &&
  typeof (b as BudgetAlert).teamId === "string" &&
  typeof (b as BudgetAlert).thresholdPercent === "number" &&
  typeof (b as BudgetAlert).budgetAmount === "number" &&
  typeof (b as BudgetAlert).currentSpend === "number";

export async function POST(req: Request) {
  const key = process.env.VERCEL_BUDGET_WEBHOOK_KEY;
  if (key && new URL(req.url).searchParams.get("key") !== key) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!isAlert(body)) return NextResponse.json({ error: "not a budget alert" }, { status: 400 });
  if (body.teamId !== TEAM_ID) return NextResponse.json({ error: "unknown team" }, { status: 403 });

  const alert = {
    budgetAmount: body.budgetAmount,
    currentSpend: body.currentSpend,
    thresholdPercent: body.thresholdPercent,
    teamId: body.teamId,
    receivedAt: new Date().toISOString(),
  };
  const sb = getSupabaseAdmin();
  const { error } = await sb
    .from("treasury_cache")
    .upsert({ key: "vercel_budget", data: alert, updated_at: alert.receivedAt }, { onConflict: "key" });
  if (error) {
    console.error("vercel-budget: could not keep the alert:", error.message);
    return NextResponse.json({ error: "store failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

/** Vercel's dialog may probe the URL: answer so it is accepted */
export async function GET() {
  return NextResponse.json({ ok: true, accepts: "POST from Vercel Spend Management" });
}

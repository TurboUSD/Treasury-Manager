const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

const compact1 = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const intFmt = new Intl.NumberFormat("en-US");

/** 1.05B, 75.7M, 28.6K */
export function fmtCompact(n: number, digits: 1 | 2 = 2): string {
  if (!Number.isFinite(n)) return "—";
  return (digits === 1 ? compact1 : compact).format(n);
}

/** $14,424 */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return usdFmt.format(n);
}

/** $5.3K */
export function fmtUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1000) return usdFmt.format(n);
  return "$" + compact1.format(n);
}

/** 246,890 */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return intFmt.format(Math.round(n));
}

/** Full integer with thousands separators and no rounding surprises for counters. */
export function fmtCounter(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return intFmt.format(Math.floor(n));
}

/** Small token prices: $0.00000505 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1) return "$" + n.toFixed(2);
  const digits = Math.min(10, Math.max(2, -Math.floor(Math.log10(n)) + 3));
  return "$" + n.toFixed(digits);
}

/**
 * DexScreener-style compact price for tiny numbers: 0.000005066 → { lead: "$0.0", zeros: 5, digits: "5066" }.
 * Returns null when the plain format is short enough.
 */
export function fmtPriceSub(n: number, sig = 4): { lead: string; zeros: number; digits: string } | null {
  if (!Number.isFinite(n) || n <= 0 || n >= 0.001) return null;
  const zeros = -Math.floor(Math.log10(n)) - 1; // zeros after "0."
  const digits = Math.round(n * Math.pow(10, zeros + sig)).toString().slice(0, sig);
  return { lead: "$0.0", zeros, digits };
}

export function fmtPct(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(digits) + "%";
  return n > 0 ? "+" + s : s;
}

export function shortHash(h: string, n = 6): string {
  if (!h) return "";
  return `${h.slice(0, n)}…${h.slice(-4)}`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

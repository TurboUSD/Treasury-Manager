"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Candle, Operation } from "./types";
import { fmtCompact, fmtUsdCompact, shortHash } from "./format";
import { Price, SvgPrice, priceChars } from "./PriceSub";
import { useWidgetData } from "./useWidgetData";
const MAX_SUPPLY = 100_000_000_000;
import InfoTip from "./InfoTip";

type Range = "7D" | "30D" | "90D" | "MAX";
type Kind = "Buyback" | "StrategicBuy" | "Burn" | "FeeClaim" | "Stake";
type Source = "ALL" | "AMI";
type Style = "line" | "candles";
type Unit = "PRICE" | "MCAP";
type Domain = { t0: number; t1: number };
type YDomain = { lo: number; hi: number };

const KINDS: Record<Kind, { label: string; color: string }> = {
  Buyback: { label: "Buyback", color: "#9ce0ff" },
  StrategicBuy: { label: "Strategic buy", color: "#d63384" },
  Burn: { label: "Burn", color: "#ff5a5a" },
  FeeClaim: { label: "Fee claim", color: "#f5d76e" },
  Stake: { label: "Stake", color: "#a78bfa" },
};
/** Stakes are not treasury operations, so they are not offered as a layer here. */
const LEGEND_KINDS = (Object.keys(KINDS) as Kind[]).filter((k) => k !== "Stake");
const RANGES: Range[] = ["7D", "30D", "90D", "MAX"];
const DAYS: Record<Range, number> = { "7D": 7, "30D": 30, "90D": 90, MAX: 100000 };
const DAY = 86400000;

// chart geometry (viewBox units): a wide box on desktop, a squarer and coarser one on phones so labels stay legible
type Geo = { W: number; H: number; PAD: { l: number; r: number; t: number; b: number }; PLOT_W: number; PLOT_H: number; font: number };
const geo = (W: number, H: number, PAD: Geo["PAD"], font: number): Geo => ({ W, H, PAD, PLOT_W: W - PAD.l - PAD.r, PLOT_H: H - PAD.t - PAD.b, font });
const WIDE = geo(1000, 400, { l: 104, r: 24, t: 20, b: 40 }, 12);
const NARROW = geo(430, 360, { l: 98, r: 14, t: 18, b: 36 }, 12.5);
const narrowQuery = () => window.matchMedia("(max-width: 639px)");
const subscribeNarrow = (cb: () => void) => {
  const mq = narrowQuery();
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

function kindOf(o: Operation): Kind | null {
  switch (o.op_type) {
    case "Buyback":
      return "Buyback";
    case "StrategicBuy":
      return "StrategicBuy";
    case "Burn":
    case "BurnEngine":
      return "Burn";
    case "FeeClaim":
      return "FeeClaim";
    case "Stake":
      return "Stake";
    default:
      return null;
  }
}

const isAmi = (o: Operation) => /Treasury Manager|AMI/i.test(o.exchange);

function usdSize(o: Operation): number {
  const amt = o.sell_amount ?? o.buy_amount ?? 0;
  const cur = o.sell_amount ? o.sell_currency : o.buy_currency;
  if (cur === "TUSD2") return amt * (o.token_price_usd ?? 0);
  if (cur === "WETH" || cur === "ETH") return amt * (o.weth_price_usd ?? 0);
  if (cur === "USDC") return amt;
  return amt * (o.token_price_usd ?? 0);
}

const sym = (c?: string | null) => (c === "TUSD2" ? "₸USD" : (c ?? ""));

function describe(o: Operation): string {
  if (o.sell_amount && o.buy_amount) return `${fmtCompact(o.sell_amount)} ${sym(o.sell_currency)} → ${fmtCompact(o.buy_amount)} ${sym(o.buy_currency)}`;
  const amt = o.sell_amount ?? o.buy_amount ?? 0;
  return `${fmtCompact(amt)} ${sym(o.sell_amount ? o.sell_currency : o.buy_currency)}`;
}

/** Only operations with a ₸USD leg carry a ₸USD price; the rest (strategic buys of other tokens…) sit on the day's close. */
const tusdPriced = (o: Operation) => o.sell_currency === "TUSD2" || o.buy_currency === "TUSD2";

/**
 * The treasury feed bills the gas of every operation as its own row, tagged with the op_type it paid
 * for ("Other Fee" + "Burn", a few millionths of an ETH). Left in, each one draws a phantom marker
 * reading "0 ETH · $0" on top of the real operation it belongs to.
 */
const isGasFee = (o: Operation) => o.type === "Other Fee";

/** The treasury feed repeats identical rows for multi-step transactions; keep one of each. */
function dedupe(ops: Operation[]): Operation[] {
  const seen = new Set<string>();
  return ops.filter((o) => {
    if (isGasFee(o)) return false;
    const key = `${o.tx_hash}|${o.op_type}|${o.sell_amount ?? ""}|${o.sell_currency ?? ""}|${o.buy_amount ?? ""}|${o.buy_currency ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface Mark {
  o: Operation;
  kind: Kind;
  t: number;
  usd: number;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Every operation AMI executes onchain, plotted on the ₸USD price (or market cap) line.
 * Marker size = USD size of the operation. Overlapping markers fan out on hover.
 * Zoom with the wheel (or pinch), drag to pan, wheel over an axis to rescale it, double-click to reset.
 */
export default function OpsChart() {
  const data = useWidgetData();
  // the live figures come from this dashboard's own feed: last cached price and burned supply
  const cached = data?.cache?.data;
  const lastClose = data?.candles?.length ? data.candles[data.candles.length - 1].close : 0;
  const priceUsd = cached?.tusdPriceUsd || lastClose;
  const burned = cached?.tusdBurnedNum ?? 0;
  const live = { priceUsd, marketCapUsd: priceUsd * (MAX_SUPPLY - burned), supply: { burned } };
  const [range, setRange] = useState<Range>("90D");
  const [source, setSource] = useState<Source>("ALL");
  const [style, setStyle] = useState<Style>("line");
  const [unit, setUnit] = useState<Unit>("PRICE");
  const [rangeOpen, setRangeOpen] = useState(false);
  const [hidden, setHidden] = useState<Set<Kind>>(new Set(["Stake"]));
  const [showAvg, setShowAvg] = useState(true);
  const [hover, setHover] = useState<{ m: Mark; x: number; y: number } | null>(null);
  const [exploded, setExploded] = useState<string | null>(null);
  const [view, setView] = useState<Domain | null>(null); // null → follow the selected range
  const [yView, setYView] = useState<YDomain | null>(null); // null → fit the visible candles
  const [dragging, setDragging] = useState(false);
  const markersRef = useRef<SVGGElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const narrow = useSyncExternalStore(subscribeNarrow, () => narrowQuery().matches, () => false);
  const G = narrow ? NARROW : WIDE;
  const { W, H, PAD, PLOT_W, PLOT_H } = G;
  const geoRef = useRef(G);
  useEffect(() => {
    geoRef.current = G;
  }, [G]);

  const mult = unit === "MCAP" ? MAX_SUPPLY - live.supply.burned : 1;
  // prices are drawn DexScreener-style ($0.0₅5254): narrower, and the zero count reads at a glance
  const fmtY = (v: number, size = G.font) => (unit === "MCAP" ? fmtUsdCompact(v) : <SvgPrice v={v} size={size} />);

  const ready = Boolean(data); // the svg (and its listeners) only exists once the feed has loaded
  const allCandles = useMemo<Candle[]>(() => data?.candles ?? [], [data]);
  const ops = useMemo(() => dedupe(data?.operations ?? []), [data]);

  // base time domain for the selected range
  const base = useMemo<Domain>(() => {
    if (!allCandles.length) return { t0: 0, t1: 1 };
    const t1 = new Date(allCandles[allCandles.length - 1].day).getTime() + DAY;
    const first = new Date(allCandles[0].day).getTime();
    const t0 = range === "MAX" ? first : Math.max(first, t1 - DAYS[range] * DAY);
    return { t0, t1 };
  }, [allCandles, range]);
  const dom = view ?? base;
  const { t0, t1 } = dom;

  const candles = useMemo(() => allCandles.filter((c) => new Date(c.day).getTime() + DAY >= t0 && new Date(c.day).getTime() <= t1), [allCandles, t0, t1]);

  const marks = useMemo<Mark[]>(
    () =>
      ops
        .map((o) => ({ o, kind: kindOf(o) as Kind, t: new Date(o.date_utc).getTime(), usd: usdSize(o) }))
        .filter((m) => m.kind && !hidden.has(m.kind) && m.t >= t0 && m.t <= t1 && (!tusdPriced(m.o) || (m.o.token_price_usd ?? 0) > 0))
        .filter((m) => source === "ALL" || isAmi(m.o))
        // stakes are not treasury operations and crowded the chart; they live in the staking section
        .filter((m) => m.kind !== "Stake"),
    [ops, t0, t1, hidden, source],
  );

  const fit = useMemo<YDomain>(() => {
    if (!candles.length) return { lo: 0, hi: 1 };
    const lows = candles.map((c) => (style === "candles" ? c.low : c.close));
    const highs = candles.map((c) => (style === "candles" ? c.high : c.close));
    return { lo: Math.min(...lows) * 0.92, hi: Math.max(...highs) * 1.08 };
  }, [candles, style]);
  const { lo, hi } = yView ?? fit;

  const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * PLOT_W;
  const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * PLOT_H;

  // refs mirroring the domains for the non-React wheel / pointer handlers
  const domRef = useRef({ t0, t1, lo, hi, fitLo: fit.lo, fitHi: fit.hi, baseT0: base.t0, baseT1: base.t1, allT0: 0, allT1: 1 });
  useEffect(() => {
    domRef.current = {
      t0,
      t1,
      lo,
      hi,
      fitLo: fit.lo,
      fitHi: fit.hi,
      baseT0: base.t0,
      baseT1: base.t1,
      allT0: allCandles.length ? new Date(allCandles[0].day).getTime() : 0,
      allT1: allCandles.length ? new Date(allCandles[allCandles.length - 1].day).getTime() + DAY : 1,
    };
  }, [t0, t1, lo, hi, fit, base, allCandles]);

  // wheel: zoom the time axis around the cursor (plot / x-axis) or the price axis (over the y-axis labels)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const g = geoRef.current;
      const px = ((e.clientX - rect.left) / rect.width) * g.W;
      const py = ((e.clientY - rect.top) / rect.height) * g.H;
      const d = domRef.current;
      const factor = Math.exp(clamp(e.deltaY, -60, 60) * 0.0025); // >1 zooms out
      if (px < g.PAD.l) {
        // price axis
        const f = clamp((py - g.PAD.t) / g.PLOT_H, 0, 1);
        const at = d.hi - f * (d.hi - d.lo);
        setYView({ lo: at - (at - d.lo) * factor, hi: at + (d.hi - at) * factor });
        return;
      }
      const f = clamp((px - g.PAD.l) / g.PLOT_W, 0, 1);
      const at = d.t0 + f * (d.t1 - d.t0);
      let n0 = at - (at - d.t0) * factor;
      let n1 = at + (d.t1 - at) * factor;
      const minSpan = 2 * DAY;
      const maxSpan = (d.allT1 - d.allT0) * 1.1;
      if (n1 - n0 < minSpan || n1 - n0 > maxSpan) return;
      // keep the view inside the data (with a little slack on the right)
      const shift = Math.max(0, d.allT0 - n0) - Math.max(0, n1 - (d.allT1 + 3 * DAY));
      n0 += shift;
      n1 += shift;
      setView({ t0: n0, t1: n1 });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [ready]);

  // drag to pan, pinch to zoom (pointer events cover mouse, pen and touch)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let start: { t0: number; t1: number; lo: number; hi: number; px: number; py: number; yManual: boolean; span?: number; dist?: number; mid?: number } | null = null;
    let moved = false;
    const pos = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const g = geoRef.current;
      return { x: ((e.clientX - rect.left) / rect.width) * g.W, y: ((e.clientY - rect.top) / rect.height) * g.H };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const target = e.target as Element;
      if (target.closest("a")) return; // marker links keep their click
      pointers.set(e.pointerId, pos(e));
      svg.setPointerCapture(e.pointerId);
      const d = domRef.current;
      const p = pos(e);
      moved = false;
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        start = { t0: d.t0, t1: d.t1, lo: d.lo, hi: d.hi, px: p.x, py: p.y, yManual: true, span: d.t1 - d.t0, dist: Math.abs(a.x - b.x), mid: (a.x + b.x) / 2 };
      } else {
        start = { t0: d.t0, t1: d.t1, lo: d.lo, hi: d.hi, px: p.x, py: p.y, yManual: d.lo !== d.fitLo || d.hi !== d.fitHi };
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId) || !start) return;
      pointers.set(e.pointerId, pos(e));
      const d = domRef.current;
      const g = geoRef.current;
      if (pointers.size >= 2 && start.dist) {
        const [a, b] = Array.from(pointers.values());
        const dist = Math.max(10, Math.abs(a.x - b.x));
        const mid = (a.x + b.x) / 2;
        const span = (start.span as number) * (start.dist / dist);
        const minSpan = 2 * DAY;
        const maxSpan = (d.allT1 - d.allT0) * 1.1;
        const s = clamp(span, minSpan, maxSpan);
        // keep the time under the pinch midpoint fixed
        const fMid = ((start.mid as number) - g.PAD.l) / g.PLOT_W;
        const tMid = start.t0 + fMid * (start.span as number);
        const fNow = (mid - g.PAD.l) / g.PLOT_W;
        const n0 = tMid - fNow * s;
        setView({ t0: n0, t1: n0 + s });
        moved = true;
        return;
      }
      const p = pos(e);
      const dx = p.x - start.px;
      const dy = p.y - start.py;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      setDragging(true);
      const dt = (dx / g.PLOT_W) * (start.t1 - start.t0);
      let n0 = start.t0 - dt;
      let n1 = start.t1 - dt;
      const shift = Math.max(0, d.allT0 - 10 * DAY - n0) - Math.max(0, n1 - (d.allT1 + 10 * DAY));
      n0 += shift;
      n1 += shift;
      setView({ t0: n0, t1: n1 });
      if (start.yManual) {
        const dp = (dy / g.PLOT_H) * (start.hi - start.lo);
        setYView({ lo: start.lo + dp, hi: start.hi + dp });
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      if (!pointers.size) {
        start = null;
        setDragging(false);
      } else {
        // pinch ended with one finger still down: restart a pan from here
        const d = domRef.current;
        const p = Array.from(pointers.values())[0];
        start = { t0: d.t0, t1: d.t1, lo: d.lo, hi: d.hi, px: p.x, py: p.y, yManual: true };
      }
    };
    const dbl = () => {
      setView(null);
      setYView(null);
    };
    svg.addEventListener("pointerdown", down);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
    svg.addEventListener("pointercancel", up);
    svg.addEventListener("dblclick", dbl);
    return () => {
      svg.removeEventListener("pointerdown", down);
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
      svg.removeEventListener("pointercancel", up);
      svg.removeEventListener("dblclick", dbl);
    };
  }, [ready]);

  const linePath = candles.map((c, i) => `${i ? "L" : "M"}${x(new Date(c.day).getTime() + DAY / 2).toFixed(1)} ${y(c.close).toFixed(1)}`).join(" ");
  const candleW = Math.max(1.5, (PLOT_W / Math.max((t1 - t0) / DAY, 1)) * 0.6);

  const avgBuyback = useMemo(() => {
    const buys = ops.filter((o) => o.op_type === "Buyback" && o.buy_currency === "TUSD2" && o.buy_amount);
    const tusd = buys.reduce((s, o) => s + (o.buy_amount ?? 0), 0);
    const usd = buys.reduce((s, o) => s + (o.buy_amount ?? 0) * (o.token_price_usd ?? 0), 0);
    return tusd ? usd / tusd : 0;
  }, [ops]);

  const maxUsd = Math.max(1, ...marks.map((m) => m.usd));
  const radius = useMemo(() => (usd: number) => 3 + Math.sqrt(usd / maxUsd) * 14, [maxUsd]);

  // ₸USD close of the day an operation happened (for the ones not priced in ₸USD)
  const closeAt = useMemo(() => {
    const byDay = new Map(allCandles.map((c) => [c.day, c.close]));
    return (t: number) => {
      const day = new Date(t).toISOString().slice(0, 10);
      if (byDay.has(day)) return byDay.get(day) as number;
      let best = allCandles[0];
      for (const c of allCandles) if (Math.abs(new Date(c.day).getTime() - t) < Math.abs(new Date(best.day).getTime() - t)) best = c;
      return best?.close ?? 0;
    };
  }, [allCandles]);

  // Group markers that land on (almost) the same pixel so they can fan out on hover. Operations without a ₸USD
  // price (strategic buys of other tokens) sit on the day's close and, when several share a day, stack vertically.
  const clusters = useMemo(() => {
    const out: Array<{ id: string; cx: number; cy: number; items: Mark[] }> = [];
    const xx = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * PLOT_W;
    const yy = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * PLOT_H;
    const stacks = new Map<string, number>(); // day → markers already stacked there
    for (const m of marks) {
      const cx = xx(m.t);
      let cy: number;
      if (tusdPriced(m.o)) cy = yy(m.o.token_price_usd as number);
      else {
        const day = new Date(m.t).toISOString().slice(0, 10);
        const n = stacks.get(day) ?? 0;
        stacks.set(day, n + 1);
        const step = radius(m.usd) * 2 + 4;
        // 0 on the line, then alternately above and below it
        const k = n === 0 ? 0 : (n % 2 ? -1 : 1) * Math.ceil(n / 2);
        cy = yy(closeAt(m.t)) + k * step;
        out.push({ id: `${m.o.tx_hash}-${out.length}`, cx, cy, items: [m] });
        continue;
      }
      const c = out.find((k) => k.items.length && tusdPriced(k.items[0].o) && Math.hypot(k.cx - cx, k.cy - cy) < 10);
      if (c) c.items.push(m);
      else out.push({ id: `${m.o.tx_hash}-${out.length}`, cx, cy, items: [m] });
    }
    return out;
  }, [marks, t0, t1, lo, hi, closeAt, radius, PAD, PLOT_W, PLOT_H]);

  const zoomed = view !== null || yView !== null;


  const toggle = (k: Kind) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const pickRange = (r: Range) => {
    setRange(r);
    setView(null);
    setYView(null);
    setRangeOpen(false);
  };

  const yTicks = useMemo(() => Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4), [lo, hi]);
  const xTicks = useMemo(() => {
    const span = t1 - t0;
    const n = narrow ? 3 : 5;
    return Array.from({ length: n }, (_, i) => {
      const t = t0 + (span * i) / (n - 1);
      return { t, label: new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: span > 200 * DAY ? "2-digit" : undefined }) };
    });
  }, [t0, t1, narrow]);

  const seg = (on: boolean) => `mono px-2 py-1 text-[11px] transition sm:px-2.5 ${on ? "bg-white/10 text-ink" : "text-muted hover:text-ink"}`;

  return (
    <div className="ops-web panel relative overflow-hidden">
      <div className="flex flex-col gap-2.5 border-b border-line px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2">
        {/* one strip, never wrapped: on a phone it scrolls, and the last chip peeking in says so */}
        <div className="no-scrollbar -mx-1 flex flex-nowrap items-center gap-3 overflow-x-auto px-1 sm:mx-0 sm:flex-wrap sm:gap-4 sm:overflow-visible sm:px-0">
          {LEGEND_KINDS.map((k) => (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px] transition sm:text-[11.5px] ${hidden.has(k) ? "opacity-35" : ""}`}
              aria-pressed={!hidden.has(k)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: KINDS[k].color }} />
              <span className="text-ink-2">{KINDS[k].label}</span>
            </button>
          ))}
          <button
            onClick={() => setShowAvg((v) => !v)}
            aria-pressed={showAvg}
            title={showAvg ? "Hide AMI's average buyback price" : "Show AMI's average buyback price"}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10.5px] text-ink-2 transition sm:text-[11.5px] ${showAvg ? "" : "opacity-35"}`}
          >
            <span className="h-px w-4 shrink-0 border-t border-dashed border-ink-2" /> Avg buyback
          </button>
        </div>

        <div className="flex w-full flex-nowrap items-center gap-1.5 sm:ml-auto sm:w-auto sm:flex-wrap sm:gap-2">
          <span className="mono hidden items-center gap-1.5 text-[11px] text-turbo-2 xl:flex">
            <span className="live-dot" /> LIVE <span className="data"><Price v={live.priceUsd} /></span> · MCAP <span className="data">{fmtUsdCompact(live.marketCapUsd)}</span>
          </span>
          <div className="flex overflow-hidden rounded-lg border border-line">
            {(["ALL", "AMI"] as Source[]).map((s) => (
              <button key={s} onClick={() => setSource(s)} className={seg(source === s)} title={s === "AMI" ? "Only operations executed by AMI's treasury" : "Every onchain operation"}>
                {s}
              </button>
            ))}
          </div>
          <div className="flex overflow-hidden rounded-lg border border-line">
            <button onClick={() => setStyle("line")} className={seg(style === "line")} title="Line" aria-label="Line chart">
              <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
                <path d="M1 9l4-4 3 2 4-5 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            <button onClick={() => setStyle("candles")} className={seg(style === "candles")} title="Candles" aria-label="Candlestick chart">
              <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
                <path d="M4 1v10M12 1v10" stroke="currentColor" strokeWidth="1" />
                <rect x="2" y="3" width="4" height="5" fill="currentColor" />
                <rect x="10" y="4" width="4" height="4" fill="currentColor" />
              </svg>
            </button>
          </div>
          <div className="flex overflow-hidden rounded-lg border border-line">
            {(["PRICE", "MCAP"] as Unit[]).map((u) => (
              <button key={u} onClick={() => setUnit(u)} className={seg(unit === u)}>
                {u}
              </button>
            ))}
          </div>
          <div className="relative ml-auto sm:ml-0">
            <button onClick={() => setRangeOpen((o) => !o)} className="mono flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[11px] text-ink sm:px-2.5" aria-expanded={rangeOpen}>
              {zoomed ? "ZOOM" : range} <span className="text-muted">▾</span>
            </button>
            {rangeOpen && (
              <div className="panel absolute right-0 top-8 z-20 w-28 p-1">
                {zoomed && (
                  <button onClick={() => pickRange(range)} className="mono block w-full rounded-md px-2 py-1.5 text-left text-[11px] text-turbo-2 hover:bg-turbo-dim">
                    ↺ Reset zoom
                  </button>
                )}
                {RANGES.map((r) => (
                  <button key={r} onClick={() => pickRange(r)} className={`mono block w-full rounded-md px-2 py-1.5 text-left text-[11px] ${range === r && !zoomed ? "bg-white/10 text-ink" : "text-muted hover:text-ink"}`}>
                    {r}
                  </button>
                ))}
              </div>
            )}
          </div>
          {zoomed && (
            <button onClick={() => pickRange(range)} className="mono rounded-lg border border-turbo/60 px-2.5 py-1 text-[11px] text-turbo-2 transition hover:bg-turbo-dim max-sm:hidden" title="Reset zoom (double-click the chart)">
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="relative" onMouseLeave={() => setExploded(null)} data-lenis-prevent>
        {!data ? (
          <div className="flex w-full items-center justify-center" style={{ aspectRatio: `${W} / ${H}` }}>
            <span className="mono cursor text-[11px] text-muted">Loading AMI receipts</span>
          </div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className={`block h-auto w-full touch-pan-y select-none ${dragging ? "cursor-grabbing" : "cursor-crosshair"}`}
            role="img"
            aria-label="₸USD price with AMI operations"
          >
            <defs>
              <linearGradient id="opsFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00ca6a" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#00ca6a" stopOpacity="0" />
              </linearGradient>
              <clipPath id="opsClip">
                <rect x={PAD.l} y={0} width={PLOT_W} height={H - PAD.b + 2} />
              </clipPath>
            </defs>
            {/* axis hit areas (wheel over them rescales that axis) */}
            <rect x="0" y="0" width={PAD.l} height={H} fill="transparent" className="cursor-ns-resize" />
            {yTicks.map((p) => (
              <g key={p}>
                <line x1={PAD.l} x2={W - PAD.r} y1={y(p)} y2={y(p)} stroke="rgba(255,255,255,0.06)" />
                <text x={PAD.l - 8} y={y(p) + 4} textAnchor="end" fontSize={G.font} fill="#8a8a8a" fontFamily="var(--font-jetbrains), monospace">
                  {fmtY(p * mult)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t.t} x={clamp(x(t.t), PAD.l + 30, W - PAD.r - 30)} y={H - 12} textAnchor="middle" fontSize={G.font} fill="#8a8a8a" fontFamily="var(--font-jetbrains), monospace">
                {t.label.toUpperCase()}
              </text>
            ))}
            <g clipPath="url(#opsClip)">
              {style === "line" ? (
                <>
                  <path d={`${linePath} L${x(t1).toFixed(1)} ${y(lo)} L${x(t0).toFixed(1)} ${y(lo)} Z`} fill="url(#opsFill)" />
                  <path d={linePath} fill="none" stroke="#d9d9d9" strokeWidth="1.6" strokeLinejoin="round" />
                </>
              ) : (
                candles.map((c) => {
                  const cx = x(new Date(c.day).getTime() + DAY / 2);
                  const up = c.close >= c.open;
                  const col = up ? "#43e397" : "#ff5a5a";
                  const top = y(Math.max(c.open, c.close));
                  const bot = y(Math.min(c.open, c.close));
                  return (
                    <g key={c.day}>
                      <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1" />
                      <rect x={cx - candleW / 2} y={top} width={candleW} height={Math.max(1, bot - top)} fill={col} opacity="0.85" />
                    </g>
                  );
                })
              )}
              {showAvg && avgBuyback > lo && avgBuyback < hi && (
                <g>
                  <line x1={PAD.l} x2={W - PAD.r} y1={y(avgBuyback)} y2={y(avgBuyback)} stroke="rgba(255,255,255,0.5)" strokeDasharray="5 6" />
                  {/* the value sits in the corner, where nothing else competes with it, and carries
                      the same dashed sample as the legend so it is clear which line it names */}
                  {(() => {
                    const size = G.font - 1.5;
                    const value = avgBuyback * mult;
                    const chars = "avg buyback ".length + (unit === "MCAP" ? fmtUsdCompact(value).length : priceChars(value));
                    const right = W - PAD.r - 4;
                    const dashEnd = right - chars * size * 0.6 - 5;
                    return (
                      <g>
                        <line x1={dashEnd - 13} x2={dashEnd} y1={PAD.t + 8} y2={PAD.t + 8} stroke="rgba(255,255,255,0.55)" strokeDasharray="4 3" />
                        <text x={right} y={PAD.t + 12} textAnchor="end" fontSize={size} fill="#c2c2c2" fontFamily="var(--font-jetbrains), monospace">
                          avg buyback {fmtY(value, size)}
                        </text>
                      </g>
                    );
                  })()}
                </g>
              )}
              <g ref={markersRef}>
                {clusters.map((c) => {
                  const open = exploded === c.id && c.items.length > 1;
                  const n = c.items.length;
                  return (
                    <g key={c.id} className="cluster" onMouseEnter={() => n > 1 && setExploded(c.id)}>
                      {n > 1 && !open && <circle cx={c.cx} cy={c.cy} r={radius(Math.max(...c.items.map((m) => m.usd))) + 5} fill="none" stroke="rgba(255,255,255,0.35)" strokeDasharray="2 3" />}
                      {c.items.map((m, i) => {
                        const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
                        const spread = open ? 12 + radius(m.usd) + 8 : 0;
                        const mx = c.cx + Math.cos(ang) * spread;
                        const my = c.cy + Math.sin(ang) * spread;
                        return (
                          <a key={`${m.o.tx_hash}-${m.o.op_type}-${i}`} href={`https://basescan.org/tx/${m.o.tx_hash}`} target="_blank" rel="noreferrer" onMouseEnter={() => setHover({ m, x: mx, y: my })} onMouseLeave={() => setHover(null)}>
                            <circle cx={mx} cy={my} r={radius(m.usd)} fill={KINDS[m.kind].color} fillOpacity="0.4" stroke={KINDS[m.kind].color} strokeWidth="1.5" className="cursor-pointer transition-[cx,cy] duration-300 hover:fill-opacity-90" />
                          </a>
                        );
                      })}
                      {n > 1 && !open && (
                        <text x={c.cx} y={c.cy + 3.5} textAnchor="middle" fontSize="9" fontWeight="700" fill="#000" fontFamily="var(--font-jetbrains), monospace" style={{ pointerEvents: "none" }}>
                          {n}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
        )}
        {hover && !dragging && (
          <div
            className="pointer-events-none absolute z-10 w-56 rounded-lg border border-line bg-black/95 p-3 text-xs shadow-xl"
            style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%`, transform: `translate(${hover.x > W * 0.6 ? "-105%" : "12px"}, -50%)` }}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold" style={{ color: KINDS[hover.m.kind].color }}>
                {KINDS[hover.m.kind].label}
              </span>
              <span className="data text-[10px] text-muted">{new Date(hover.m.o.date_utc).toLocaleDateString("en-US")}</span>
            </div>
            <div className="mt-1.5 text-ink">{describe(hover.m.o)}</div>
            <div className="data mt-1 text-[10px] text-muted">
              {fmtUsdCompact(usdSize(hover.m.o))}
              {tusdPriced(hover.m.o) && <> · @ <Price v={hover.m.o.token_price_usd ?? 0} /></>}
            </div>
            <div className="data mt-1 text-[10px] text-muted">
              {hover.m.o.exchange.replace("Treasury Manager", "Treasury")} · {shortHash(hover.m.o.tx_hash)} {"\u2197\uFE0E"}
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2">
        <p className="mono min-w-0 flex-1 truncate text-[10.5px] text-muted">
          Wheel or pinch to zoom · drag to pan · wheel over an axis to rescale it · double-click to reset · hover a marker for the receipt, click to open it
        </p>
        <InfoTip side="top">
          <strong className="text-ink">Reading the chart.</strong> The line is the daily ₸USD close (or market cap). Each marker is one onchain operation,
          sized by its USD value; a numbered marker groups several operations at the same spot and fans out on hover. The dashed line is AMI&apos;s average
          buyback price. Data: treasury.turbousd.com, GeckoTerminal.
        </InfoTip>
      </div>
    </div>
  );
}

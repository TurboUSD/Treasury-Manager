"use client";

/**
 * AMI Operations Chart — ₸USD price/mcap chart with every AMI on-chain
 * operation plotted as a marker (whitewolf.fun-style).
 *
 * Data:
 *  - 90D (default) & MAX: our own daily OHLC candles (price_history via /api/widget-data)
 *  - 7D / 30D: GeckoTerminal hourly candles
 *  - Operations: passed in via props (already fetched by the page)
 *
 * Interaction (TradingView-style):
 *  - Mouse wheel over plot → zoom X (anchored at cursor)
 *  - Mouse wheel over the Y-axis gutter → zoom Y
 *  - Drag on the X/Y axis → zoom that axis; drag on plot → pan
 *  - Pinch on mobile (per axis); double click/tap → reset
 */
import { useEffect, useMemo, useRef, useState } from "react";

const TUSD_ADDR = "0x3d5e487b21e0569048c4d1a60e98c36e1b09db07";
const TUSD_POOL = "0xd013725b904e76394A3aB0334Da306C505D778F8";
const GT_BASE = "https://api.geckoterminal.com/api/v2/networks/base";

const SURFACE = "#141414";
const GRID = "#242424";
const LINE = "#d9d9d9";
const ACCENT = "#43e397";
const TEXT_2 = "#a8a8a8";
const TEXT_3 = "#6f6f6f";
const GREEN_C = "#22a04a";
const RED_C = "#ef4444";

type Shape = "circle" | "ring" | "diamond" | "square" | "triangle";

const OP_STYLE: Record<string, { color: string; shape: Shape; label: string }> = {
  Buyback: { color: "#22a04a", shape: "circle", label: "Buyback" },
  StrategicBuy: { color: "#3987e5", shape: "circle", label: "Strategic buy" },
  Burn: { color: "#ef4444", shape: "diamond", label: "Burn" },
  BurnEngine: { color: "#ef4444", shape: "diamond", label: "Burn" },
  FeeClaim: { color: "#0aa2c0", shape: "ring", label: "Fee claim" },
  Rebalance: { color: "#c98500", shape: "square", label: "Rebalance" },
  Stake: { color: "#9085e9", shape: "triangle", label: "Stake" },
};

const LEGEND: { key: string; types: string[] }[] = [
  { key: "Buyback", types: ["Buyback"] },
  { key: "StrategicBuy", types: ["StrategicBuy"] },
  { key: "Burn", types: ["Burn", "BurnEngine"] },
  { key: "FeeClaim", types: ["FeeClaim"] },
  { key: "Rebalance", types: ["Rebalance"] },
  { key: "Stake", types: ["Stake"] },
];

const RANGES = [
  { key: "7D", days: 7 as number | null, tf: "hour", agg: 1, limit: 190 },
  { key: "30D", days: 30, tf: "hour", agg: 4, limit: 190 },
  { key: "90D", days: 90, tf: "day", agg: 1, limit: 100 },
  { key: "MAX", days: null, tf: "day", agg: 1, limit: 1000 },
];

export type AmiOpRow = {
  type: string;
  op_type: string;
  buy_amount: number | null;
  buy_currency: string | null;
  sell_amount: number | null;
  sell_currency: string | null;
  weth_price_usd: number | null;
  token_price_usd: number | null;
  tx_hash: string | null;
  date_utc: string;
  exchange?: string | null;
};

type Marker = {
  t: number;
  type: string;
  usd: number;
  main: string;
  sub: string;
  price: number | null;
  tx: string;
  ex: string;
};

type Pt = { t: number; o: number; h: number; l: number; c: number; p: number };

/* ── formatting ── */
function fmtPrice(p: number): string {
  if (!isFinite(p)) return "—";
  if (p >= 1000) return "$" + p.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (p >= 1) return "$" + p.toFixed(2);
  if (p >= 0.01) return "$" + p.toFixed(4);
  let s = Number(p.toPrecision(3)).toString();
  if (s.indexOf("e") !== -1) s = p.toFixed(12).replace(/0+$/, "");
  return "$" + s;
}
function fmtUsd(v: number): string {
  if (!isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
  return "$" + v.toFixed(v < 10 ? 2 : 0);
}
function fmtAmt(v: number): string {
  if (!isFinite(v)) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return v.toPrecision(3);
}
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function fmtDate(t: number, withTime = false): string {
  const d = new Date(t);
  let s = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (withTime)
    s += ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  return s;
}

/* ── data helpers ── */
function interp(prices: Pt[], t: number): number | null {
  if (!prices.length) return null;
  if (t <= prices[0].t) return prices[0].p;
  if (t >= prices[prices.length - 1].t) return prices[prices.length - 1].p;
  let lo = 0,
    hi = prices.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (prices[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = prices[lo],
    b = prices[hi];
  return a.p + (b.p - a.p) * ((t - a.t) / (b.t - a.t || 1));
}
function niceTicks(min: number, max: number, n: number): number[] {
  const span = max - min || max || 1;
  let step = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step;
  step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.01; v += step) ticks.push(v);
  return ticks;
}

type OpStats = {
  burned: number; burns: number; clankerBurned: number; clankerBurns: number;
  bought: number; buys: number;
  stakedAmi: number; stakesAmi: number; stakesAll: number;
};

function processOps(rows: AmiOpRow[]): {
  markers: Marker[];
  avgCost: number | null;
  burnEvents: { t: number; amt: number }[];
  stats: OpStats;
} {
  const groups: Record<string, AmiOpRow[]> = {};
  const order: string[] = [];
  for (const op of rows) {
    const t = op.op_type;
    if (!OP_STYLE[t]) continue;
    if (op.type === "Other Fee" && op.sell_currency === "ETH") continue;
    const key =
      (op.tx_hash || op.date_utc || "") + "|" + t + (t === "FeeClaim" ? "|" + (op.buy_currency || "") : "");
    if (!groups[key]) {
      groups[key] = [];
      order.push(key);
    }
    groups[key].push(op);
  }

  const markers: Marker[] = [];
  const burnEvents: { t: number; amt: number }[] = [];
  const stats: OpStats = {
    burned: 0, burns: 0, clankerBurned: 0, clankerBurns: 0,
    bought: 0, buys: 0, stakedAmi: 0, stakesAmi: 0, stakesAll: 0,
  };
  let bbUsd = 0,
    bbTusd = 0;
  for (const key of order) {
    const rws = groups[key];
    const op = rws[0];
    const t = op.op_type;
    const ts = Date.parse(op.date_utc);
    if (!isFinite(ts)) continue;
    let usd = 0,
      main = "",
      sub = "",
      opPrice: number | null = null;

    if (t === "Buyback") {
      const tr = rws.find(r => r.type === "Trade") || op;
      const tusd = tr.buy_amount || 0;
      const spent =
        tr.sell_currency === "USDC" ? tr.sell_amount || 0 : (tr.sell_amount || 0) * (tr.weth_price_usd || 0);
      usd = spent;
      if (tusd > 0 && spent > 0) opPrice = spent / tusd;
      main = `${fmtAmt(tr.sell_amount || 0)} ${tr.sell_currency || "WETH"} → ${fmtAmt(tusd)} ₸USD`;
      sub = (opPrice ? `at ${fmtPrice(opPrice)} · ` : "") + fmtUsd(usd);
      if (op.exchange && op.exchange.includes("v1")) sub += ` · ${op.exchange}`;
      bbUsd += spent;
      bbTusd += tusd;
      stats.bought += tusd;
      stats.buys++;
    } else if (t === "StrategicBuy") {
      const tr = rws.find(r => r.type === "Trade") || op;
      usd = (tr.sell_amount || 0) * (tr.weth_price_usd || 0);
      main = `${fmtAmt(tr.sell_amount || 0)} WETH → ${fmtAmt(tr.buy_amount || 0)} ${tr.buy_currency || ""}`;
      sub = fmtUsd(usd);
    } else if (t === "Burn" || t === "BurnEngine") {
      const br = rws.find(r => r.type === "Spend") || op;
      const burned = br.sell_amount || 0;
      usd = burned * (br.token_price_usd || 0);
      main = `${fmtAmt(burned)} ₸USD burned 🔥`;
      const author =
        op.exchange && (op.exchange === "Clanker" || op.exchange.includes("v1"))
          ? op.exchange
          : t === "BurnEngine"
            ? "BurnEngine"
            : "Treasury";
      sub = `${author} · ${fmtUsd(usd)}`;
      stats.burned += burned;
      stats.burns++;
      if (op.exchange === "Clanker") {
        stats.clankerBurned += burned;
        stats.clankerBurns++;
      }
      burnEvents.push({ t: ts, amt: burned });
    } else if (t === "Stake") {
      const sr = rws.find(r => r.sell_currency === "TUSD2") || op;
      const staked = sr.sell_amount || 0;
      usd = staked * (sr.token_price_usd || 0);
      main = `${fmtAmt(staked)} ₸USD staked`;
      const sAuthor =
        op.exchange === "Liquid staking"
          ? "Liquid staking"
          : op.exchange === "Staking contract"
            ? "Staking contract"
            : op.exchange && op.exchange.includes("v1")
              ? op.exchange
              : "Treasury";
      sub = `${sAuthor} · ${fmtUsd(usd)}`;
      stats.stakesAll++;
      if (sAuthor === "Treasury" || sAuthor.includes("v1")) {
        stats.stakedAmi += staked;
        stats.stakesAmi++;
      }
    } else if (t === "FeeClaim") {
      const cur = op.buy_currency || "";
      const amt = op.buy_amount || 0;
      usd = amt * (op.token_price_usd || (cur === "WETH" ? op.weth_price_usd || 0 : 0));
      main = `+${fmtAmt(amt)} ${cur === "TUSD2" ? "₸USD" : cur} fees claimed`;
      sub = fmtUsd(usd);
    } else if (t === "Rebalance") {
      let usdc = 0,
        weth = 0,
        sold = 0,
        ticker = "";
      for (const r of rws) {
        if (r.type !== "Trade") continue;
        if (r.buy_currency === "USDC") {
          usdc += r.buy_amount || 0;
          sold += r.sell_amount || 0;
          ticker = r.sell_currency || ticker;
        }
        if (r.buy_currency === "WETH") {
          weth += r.buy_amount || 0;
          sold += r.sell_amount || 0;
          ticker = r.sell_currency || ticker;
        }
      }
      usd = usdc + weth * (op.weth_price_usd || 0);
      main = `${fmtAmt(sold)} ${ticker} → USDC + WETH`;
      sub = `Rebalance · ${fmtUsd(usd)}`;
    }

    markers.push({ t: ts, type: t, usd, main, sub, price: opPrice, tx: op.tx_hash || "", ex: op.exchange || "" });
  }

  burnEvents.sort((a, b) => a.t - b.t);
  return { markers, avgCost: bbTusd > 0 ? bbUsd / bbTusd : null, burnEvents, stats };
}

/* ── marker shape ── */
function MarkerShape({ shape, x, y, r, color }: { shape: Shape; x: number; y: number; r: number; color: string }) {
  if (shape === "circle") return <circle cx={x} cy={y} r={r} fill={color} stroke={SURFACE} strokeWidth={2} />;
  if (shape === "ring")
    return (
      <g>
        <circle cx={x} cy={y} r={r + 1.5} fill="none" stroke={SURFACE} strokeWidth={1.5} />
        <circle cx={x} cy={y} r={r} fill="none" stroke={color} strokeWidth={2.5} />
      </g>
    );
  if (shape === "diamond")
    return (
      <path
        d={`M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`}
        fill={color}
        stroke={SURFACE}
        strokeWidth={2}
      />
    );
  if (shape === "square") {
    const q = r * 0.9;
    return <rect x={x - q} y={y - q} width={q * 2} height={q * 2} rx={2} fill={color} stroke={SURFACE} strokeWidth={2} />;
  }
  return (
    <path
      d={`M ${x} ${y - r} L ${x + r} ${y + r * 0.8} L ${x - r} ${y + r * 0.8} Z`}
      fill={color}
      stroke={SURFACE}
      strokeWidth={2}
    />
  );
}

/* ── component ── */
export function AmiOpsChart({ operations }: { operations: AmiOpRow[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  const [range, setRange] = useState("90D");
  const [metric, setMetric] = useState<"price" | "mcap">("price");
  const [opAuthor, setOpAuthor] = useState<"all" | "ami">("ami"); // el treasury muestra AMI por defecto
  const [ctype, setCtype] = useState<"line" | "candles">("line");
  const [supplyNow, setSupplyNow] = useState<number | null>(null);
  const [burnedNow, setBurnedNow] = useState<number>(0);
  const [cacheD, setCacheD] = useState<Record<string, number> | null>(null);
  const [cacheAge, setCacheAge] = useState<number | null>(null);
  const [prices, setPrices] = useState<Pt[]>([]);
  const [candles, setCandles] = useState<Pt[]>([]);
  const [apiOps, setApiOps] = useState<AmiOpRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ x0: number; x1: number } | null>(null);
  const [yman, setYman] = useState<{ min: number; max: number } | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    lines: { cls: string; text: string }[];
    tx?: string;
  } | null>(null);
  const dragRef = useRef<Record<string, unknown> | null>(null);
  const pointersRef = useRef<Record<number, { sx: number; sy: number }>>({});
  const suppressClickRef = useRef(false);

  /* container resize */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => setWidth(node.clientWidth || 800));
    ro.observe(node);
    setWidth(node.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  /* own daily candles + supply */
  useEffect(() => {
    let cancelled = false;
    fetch("/api/widget-data", { headers: { accept: "application/json" } })
      .then(res => (res.ok ? res.json() : null))
      .then(j => {
        if (cancelled || !j) return;
        if (j.candles) {
          setCandles(
            (j.candles as { day: string; open: number; high: number; low: number; close: number }[])
              .map(c => ({
                t: Date.parse(c.day),
                o: Number(c.open),
                h: Number(c.high),
                l: Number(c.low),
                c: Number(c.close),
                p: Number(c.close),
              }))
              .filter(x => isFinite(x.p) && x.p > 0),
          );
        }
        const s = Number(j.cache?.data?.tusdSupplyNum || 0);
        if (s > 0) setSupplyNow(s);
        if (Array.isArray(j.operations) && j.operations.length) setApiOps(j.operations as AmiOpRow[]);
        const bn = Number(j.cache?.data?.tusdBurnedNum || 0);
        if (bn > 0) setBurnedNow(bn);
        if (j.cache?.data) setCacheD(j.cache.data as Record<string, number>);
        if (j.cache?.updated_at) setCacheAge(Math.max(0, Math.round((Date.now() - Date.parse(j.cache.updated_at)) / 60000)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* price series — 90D/MAX from own candles; 7D/30D from GeckoTerminal */
  useEffect(() => {
    let cancelled = false;
    setView(null);
    setYman(null);
    if ((range === "MAX" || range === "90D") && candles.length) {
      setPrices(range === "90D" ? candles.slice(-90) : candles);
      setFailed(false);
      setLoading(false);
      return;
    }
    const r = RANGES.find(x => x.key === range) || RANGES[3];
    setLoading(true);
    fetch(
      `${GT_BASE}/pools/${TUSD_POOL}/ohlcv/${r.tf}?aggregate=${r.agg}&limit=${r.limit}&currency=usd&token=${TUSD_ADDR}`,
      { headers: { accept: "application/json" } },
    )
      .then(res => {
        if (!res.ok) throw new Error(`GT ${res.status}`);
        return res.json();
      })
      .then(j => {
        if (cancelled) return;
        let pts: Pt[] = ((j?.data?.attributes?.ohlcv_list as number[][]) || [])
          .map(c => ({ t: c[0] * 1000, o: c[1], h: c[2], l: c[3], c: c[4], p: c[4] }))
          .filter(x => isFinite(x.p) && x.p > 0)
          .sort((a, b) => a.t - b.t);
        if (r.days) {
          const cut = Date.now() - r.days * 864e5;
          pts = pts.filter(x => x.t >= cut);
        }
        setPrices(pts);
        setFailed(pts.length === 0);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range, candles]);

  /* preferimos las ops del API (incluyen las legacy de Treasury Manager v1) */
  const { markers, avgCost, burnEvents, stats } = useMemo(
    () => processOps(apiOps.length ? apiOps : operations || []),
    [apiOps, operations],
  );

  /* supply(t) = supplyNow + burned after t */
  const supplyAt = useMemo(() => {
    const ts = burnEvents.map(e => e.t);
    const suffix = new Array<number>(burnEvents.length + 1);
    suffix[burnEvents.length] = 0;
    for (let i = burnEvents.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + burnEvents[i].amt;
    return (t: number): number | null => {
      if (!supplyNow) return null;
      /* supplyNow es el total BRUTO (burns a dead no reducen totalSupply):
         circulante hoy = bruto − quemado total; supply(t) = eso + quemado después de t */
      const baseNet = supplyNow - burnedNow;
      let lo = 0,
        hi = ts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      return baseNet + suffix[lo];
    };
  }, [burnEvents, supplyNow, burnedNow]);

  const F = useMemo(() => (metric === "mcap" ? (t: number) => supplyAt(t) || 1 : () => 1), [metric, supplyAt]);
  const fmtVal = metric === "mcap" ? fmtUsd : fmtPrice;

  /* full transformed series */
  const viewAll = useMemo<Pt[]>(
    () =>
      prices.map(x => {
        const f = F(x.t) || 1;
        return { t: x.t, o: x.o * f, h: x.h * f, l: x.l * f, c: x.c * f, p: x.p * f };
      }),
    [prices, F],
  );

  /* geometry */
  const H = Math.max(300, Math.min(420, Math.round(width * 0.42)));
  const PAD = { l: 8, r: 58, t: 18, b: 26 };

  const geom = useMemo(() => {
    if (!viewAll.length) return null;
    const f0 = viewAll[0].t,
      f1 = viewAll[viewAll.length - 1].t;
    const t0 = view ? view.x0 : f0;
    const t1 = view ? view.x1 : f1;

    const pts: Pt[] = [];
    for (let i = 0; i < viewAll.length; i++) {
      const tt = viewAll[i].t;
      if (tt >= t0 && tt <= t1) pts.push(viewAll[i]);
      else if (tt < t0 && i + 1 < viewAll.length && viewAll[i + 1].t >= t0) pts.push(viewAll[i]);
      else if (tt > t1 && i > 0 && viewAll[i - 1].t <= t1) pts.push(viewAll[i]);
    }
    const usable = pts.length ? pts : viewAll.slice(-2);

    let pmin: number, pmax: number;
    if (yman) {
      pmin = yman.min;
      pmax = yman.max;
    } else {
      pmin = Infinity;
      pmax = -Infinity;
      for (const x of usable) {
        const lo = ctype === "candles" ? x.l : x.p;
        const hi = ctype === "candles" ? x.h : x.p;
        if (lo < pmin) pmin = lo;
        if (hi > pmax) pmax = hi;
      }
      if (metric === "price" && avgCost && !view) {
        pmin = Math.min(pmin, avgCost);
        pmax = Math.max(pmax, avgCost);
      }
      const padY = (pmax - pmin) * 0.12 || pmax * 0.1 || 1;
      pmin = Math.max(0, pmin - padY);
      pmax += padY;
    }

    const X = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (width - PAD.l - PAD.r);
    const Y = (p: number) => PAD.t + (1 - (p - pmin) / (pmax - pmin || 1)) * (H - PAD.t - PAD.b);

    const visible = markers.filter(m => {
      if (m.t < t0 || m.t > t1) return false;
      if (opAuthor === "ami") {
        if (m.ex === "Clanker") return false;
        if (m.type === "Stake" && (m.ex === "Liquid staking" || m.ex === "Staking contract")) return false;
      }
      const lg = LEGEND.find(l => l.types.indexOf(m.type) !== -1);
      return !(lg && hidden.has(lg.key));
    });
    let maxUsd = 0;
    for (const m of visible) if (m.usd > maxUsd) maxUsd = m.usd;
    const placed = visible
      .map(m => {
        let yv = interp(viewAll, m.t);
        if (m.price && m.type === "Buyback") yv = m.price * F(m.t);
        if (yv == null) return null;
        const y = Math.max(PAD.t + 4, Math.min(H - PAD.b - 4, Y(yv)));
        let r = maxUsd > 0 ? 6 + 14 * Math.sqrt((m.usd || 0) / maxUsd) : 8;
        r = Math.max(6, Math.min(22, r));
        return { m, x: X(m.t), y, r };
      })
      .filter(Boolean) as { m: Marker; x: number; y: number; r: number }[];

    /* colisiones: si dos marcadores se solapan, apilar el siguiente HACIA
       ARRIBA con un pequeño hueco para que se vea que hay varios */
    for (let pi = 0; pi < placed.length; pi++) {
      const p = placed[pi];
      let guard = 0;
      let collided = true;
      while (collided && guard++ < 24) {
        collided = false;
        for (let qi = 0; qi < pi; qi++) {
          const q = placed[qi];
          if (Math.hypot(p.x - q.x, p.y - q.y) < p.r + q.r + 2) {
            p.y = q.y - (q.r + p.r + 5); // justo encima del que choca
            collided = true;
          }
        }
      }
      p.y = Math.max(PAD.t + p.r + 2, p.y);
    }

    let dLine = "";
    usable.forEach((pt, i) => {
      dLine += (i ? " L " : "M ") + X(pt.t).toFixed(1) + " " + Y(pt.p).toFixed(1);
    });
    const yBase = (H - PAD.b).toFixed(1);
    const dArea = `${dLine} L ${X(usable[usable.length - 1].t).toFixed(1)} ${yBase} L ${X(usable[0].t).toFixed(1)} ${yBase} Z`;

    const barW = Math.max(1.5, Math.min(14, ((width - PAD.l - PAD.r) / Math.max(1, usable.length)) * 0.7));

    return { t0, t1, f0, f1, pmin, pmax, X, Y, placed, pts: usable, dLine, dArea, barW, ticks: niceTicks(pmin, pmax, 4) };
  }, [viewAll, view, yman, ctype, metric, F, markers, hidden, opAuthor, width, H, avgCost, PAD.l, PAD.r, PAD.t, PAD.b]);

  /* ── zoom helpers ── */
  const clampView = (x0: number, x1: number) => {
    if (!viewAll.length) return;
    const f0 = viewAll[0].t,
      f1 = viewAll[viewAll.length - 1].t;
    const minSpan = Math.max((f1 - f0) / 300, 30 * 60 * 1000);
    if (x1 - x0 < minSpan) {
      const c = (x0 + x1) / 2;
      x0 = c - minSpan / 2;
      x1 = c + minSpan / 2;
    }
    if (x0 < f0) {
      x1 = Math.min(f1, x1 + (f0 - x0));
      x0 = f0;
    }
    if (x1 > f1) {
      x0 = Math.max(f0, x0 - (x1 - f1));
      x1 = f1;
    }
    setView(x0 <= f0 + 1 && x1 >= f1 - 1 ? null : { x0, x1 });
  };

  const coords = (clientX: number, clientY: number) => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width || 1;
    return { sx: (clientX - rect.left) * scale, sy: (clientY - rect.top) * scale, scale };
  };
  const zoneOf = (sx: number, sy: number) => {
    if (sx > width - PAD.r) return "yaxis";
    if (sy > H - PAD.b) return "xaxis";
    return "plot";
  };
  const tAt = (sx: number) => (geom ? geom.t0 + ((sx - PAD.l) / (width - PAD.l - PAD.r)) * (geom.t1 - geom.t0) : 0);
  const vAt = (sy: number) =>
    geom ? geom.pmin + (1 - (sy - PAD.t) / (H - PAD.t - PAD.b)) * (geom.pmax - geom.pmin) : 0;

  /* wheel needs a non-passive listener to preventDefault */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      if (!geom) return;
      e.preventDefault();
      const { sx, sy } = coords(e.clientX, e.clientY);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (zoneOf(sx, sy) === "yaxis") {
        const a = vAt(sy);
        setYman({ min: a - (a - geom.pmin) * factor, max: a + (geom.pmax - a) * factor });
      } else {
        const a = tAt(Math.max(PAD.l, Math.min(sx, width - PAD.r)));
        clampView(a - (a - geom.t0) * factor, a + (geom.t1 - a) * factor);
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geom, width, H]);

  /* pointer: pan / axis-drag / pinch / hover */
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    const { sx, sy } = coords(e.clientX, e.clientY);
    pointersRef.current[e.pointerId] = { sx, sy };
    const ids = Object.keys(pointersRef.current);
    if (ids.length === 2) {
      const a = pointersRef.current[Number(ids[0])];
      const b = pointersRef.current[Number(ids[1])];
      const overY = zoneOf(a.sx, a.sy) === "yaxis" && zoneOf(b.sx, b.sy) === "yaxis";
      dragRef.current = {
        mode: overY ? "pinchY" : "pinchX",
        d0: overY ? Math.abs(a.sy - b.sy) || 1 : Math.abs(a.sx - b.sx) || 1,
        anchorT: tAt((a.sx + b.sx) / 2),
        anchorV: vAt((a.sy + b.sy) / 2),
        x00: geom.t0,
        x10: geom.t1,
        y00: geom.pmin,
        y10: geom.pmax,
      };
      setHover(null);
      return;
    }
    const zn = zoneOf(sx, sy);
    dragRef.current = {
      mode: zn === "yaxis" ? "axisY" : zn === "xaxis" ? "axisX" : "pan",
      sx0: sx,
      sy0: sy,
      moved: false,
      x00: geom.t0,
      x10: geom.t1,
      y00: geom.pmin,
      y10: geom.pmax,
      hadYman: !!yman,
    };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom) return;
    const { sx, sy, scale } = coords(e.clientX, e.clientY);
    if (pointersRef.current[e.pointerId]) pointersRef.current[e.pointerId] = { sx, sy };
    const drag = dragRef.current as Record<string, number | string | boolean> | null;

    if (drag && (drag.mode === "pinchX" || drag.mode === "pinchY")) {
      const ids = Object.keys(pointersRef.current);
      if (ids.length < 2) return;
      const a = pointersRef.current[Number(ids[0])];
      const b = pointersRef.current[Number(ids[1])];
      if (drag.mode === "pinchX") {
        const d = Math.abs(a.sx - b.sx) || 1;
        const f = (drag.d0 as number) / d;
        const aT = drag.anchorT as number;
        clampView(aT - (aT - (drag.x00 as number)) * f, aT + ((drag.x10 as number) - aT) * f);
      } else {
        const dv = Math.abs(a.sy - b.sy) || 1;
        const fy = (drag.d0 as number) / dv;
        const aV = drag.anchorV as number;
        setYman({ min: aV - (aV - (drag.y00 as number)) * fy, max: aV + ((drag.y10 as number) - aV) * fy });
      }
      return;
    }

    if (drag && e.buttons) {
      const dx = sx - (drag.sx0 as number);
      const dy = sy - (drag.sy0 as number);
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      suppressClickRef.current = true;
      setHover(null);
      if (drag.mode === "pan") {
        const span = (drag.x10 as number) - (drag.x00 as number);
        const dt = (-dx / (width - PAD.l - PAD.r)) * span;
        clampView((drag.x00 as number) + dt, (drag.x10 as number) + dt);
        if (drag.hadYman) {
          const vs = (drag.y10 as number) - (drag.y00 as number);
          const dvv = (dy / (H - PAD.t - PAD.b)) * vs;
          setYman({ min: (drag.y00 as number) + dvv, max: (drag.y10 as number) + dvv });
        }
      } else if (drag.mode === "axisX") {
        const fx = Math.exp(-dx / 200);
        const cT = ((drag.x00 as number) + (drag.x10 as number)) / 2;
        clampView(cT - (cT - (drag.x00 as number)) * fx, cT + ((drag.x10 as number) - cT) * fx);
      } else if (drag.mode === "axisY") {
        const fy2 = Math.exp(dy / 200);
        const cV = ((drag.y00 as number) + (drag.y10 as number)) / 2;
        setYman({ min: cV - (cV - (drag.y00 as number)) * fy2, max: cV + ((drag.y10 as number) - cV) * fy2 });
      }
      return;
    }

    /* hover */
    const zn = zoneOf(sx, sy);
    if (zn !== "plot") {
      setHover(null);
      return;
    }
    let best: { m: Marker; x: number; y: number; r: number } | null = null;
    let bestD = Infinity;
    for (const h of geom.placed) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d < Math.max(24, h.r + 6) && d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best) {
      const st = OP_STYLE[best.m.type];
      setHover({
        x: best.x / scale,
        y: best.y / scale,
        tx: best.m.tx || undefined,
        lines: [
          { cls: "date", text: `${fmtDate(best.m.t, true)} · ${st.label.toUpperCase()}` },
          { cls: "main", text: best.m.main },
          { cls: "sub", text: best.m.sub + (best.m.tx ? "  ·  view tx ↗" : "") },
        ],
      });
      return;
    }
    if (sx < PAD.l || sx > width - PAD.r) {
      setHover(null);
      return;
    }
    const t = tAt(sx);
    const p = interp(viewAll, t);
    if (p == null) {
      setHover(null);
      return;
    }
    setHover({
      x: sx / scale,
      y: geom.Y(p) / scale,
      lines: [
        { cls: "date", text: fmtDate(t, true) },
        { cls: "main", text: fmtVal(p) },
      ],
    });
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    delete pointersRef.current[e.pointerId];
    dragRef.current = null;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 50);
  };

  const nx = Math.max(3, Math.min(6, Math.floor(width / 160)));
  const live = prices.length ? prices[prices.length - 1].p : null;

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: SURFACE, border: "1px solid #262626", fontFamily: "ui-monospace, SF Mono, Menlo, monospace" }}
    >
      {/* stats row */}
      {(() => {
        const px = Number(cacheD?.tusdPriceUsd || 0);
        const ami = opAuthor === "ami";
        const burnedAll = Number(cacheD?.tusdBurnedNum || 0) || stats.burned;
        const burnedShown = ami ? Math.max(0, burnedAll - stats.clankerBurned) : burnedAll;
        const burnCount = ami ? Math.max(0, stats.burns - stats.clankerBurns) : stats.burns;
        const stakedAll =
          Number(cacheD?.tusdStakedNum || 0) + Number(cacheD?.tusdBalNum || 0) + Number(cacheD?.tusdLiquidStakedNum || 0);
        const stakedShown = ami ? stats.stakedAmi : stakedAll;
        const supplyNet = Number(cacheD?.tusdSupplyNum || 0) - Number(cacheD?.tusdBurnedNum || 0);
        const pct = supplyNet > 0 && stakedShown > 0 ? ((stakedShown / supplyNet) * 100).toFixed(2) + "% of supply" : `${ami ? stats.stakesAmi : stats.stakesAll} stakes`;
        const managed = Number(cacheD?.totalManagedUsd || 0);
        const tile = (label: string, value: string, sub: string, key: string) => (
          <div key={key} className="px-3 py-2.5 min-w-0 border-l first:border-l-0" style={{ borderColor: "#262626" }}>
            <div className="text-[9px] uppercase tracking-widest mb-0.5" style={{ color: TEXT_3 }}>{label}</div>
            <div className="text-[15px] font-bold truncate" style={{ color: "#f5f5f5" }}>{value}</div>
            <div className="text-[9px] mt-0.5 truncate" style={{ color: TEXT_3 }}>{sub}</div>
          </div>
        );
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 rounded-lg overflow-hidden mb-3" style={{ border: "1px solid #262626" }}>
            {tile("₸USD burned", fmtAmt(burnedShown) + (px > 0 ? ` · ${fmtUsd(burnedShown * px)}` : ""), `${burnCount} burn${burnCount === 1 ? "" : "s"}`, "b")}
            {tile("₸USD bought", fmtAmt(stats.bought) + (px > 0 ? ` · ${fmtUsd(stats.bought * px)}` : ""), `${stats.buys} buy${stats.buys === 1 ? "" : "s"}`, "c")}
            {tile("₸USD staked", fmtAmt(stakedShown) + (px > 0 ? ` · ${fmtUsd(stakedShown * px)}` : ""), pct, "s")}
            {tile("Managed funds", managed > 0 ? "$" + managed.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—", cacheAge != null ? `updated ${cacheAge}m ago` : "on-chain treasury", "m")}
          </div>
        );
      })()}

      {/* header: legend + live */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div className="flex flex-wrap gap-3 items-center">
          {LEGEND.map(item => {
            const st = OP_STYLE[item.types[0]];
            const off = hidden.has(item.key);
            return (
              <button
                key={item.key}
                type="button"
                onClick={() =>
                  setHidden(prev => {
                    const next = new Set(prev);
                    if (next.has(item.key)) next.delete(item.key);
                    else next.add(item.key);
                    return next;
                  })
                }
                className="flex items-center gap-1.5 text-[11px] transition-opacity"
                style={{ color: TEXT_2, opacity: off ? 0.35 : 1, textDecoration: off ? "line-through" : "none" }}
              >
                <svg width={14} height={14} viewBox="0 0 14 14">
                  <MarkerShape shape={st.shape} x={7} y={7} r={5} color={st.color} />
                </svg>
                {st.label}
              </button>
            );
          })}
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: TEXT_2 }}>
            <svg width={18} height={6}>
              <line x1={0} y1={3} x2={18} y2={3} stroke={TEXT_2} strokeWidth={2} strokeDasharray="4 3" />
            </svg>
            Avg buyback
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] whitespace-nowrap" style={{ color: TEXT_2 }}>
          <span
            className="inline-block w-[7px] h-[7px] rounded-full animate-pulse"
            style={{ background: ACCENT, boxShadow: `0 0 6px ${ACCENT}` }}
          />
          {live && metric === "price" ? `LIVE ${fmtPrice(live)}` : live ? `LIVE MCAP ${fmtUsd(live * (F(Date.now()) || 1))}` : "LIVE"}
        </div>
      </div>

      {/* author + chart type + metric toggle + range buttons */}
      <div className="flex gap-1 justify-end mb-1 items-center flex-wrap">
        <div className="flex rounded-md overflow-hidden mr-1" style={{ border: "1px solid #2a2a2a" }}>
          {(["all", "ami"] as const).map(a => (
            <button
              key={a}
              type="button"
              onClick={() => setOpAuthor(a)}
              className="text-[10px] px-2 py-0.5"
              style={{ color: opAuthor === a ? "#fff" : TEXT_3, background: opAuthor === a ? "#ffffff14" : "transparent" }}
            >
              {a === "all" ? "ALL" : "AMI"}
            </button>
          ))}
        </div>
        <div className="flex rounded-md overflow-hidden mr-1" style={{ border: "1px solid #2a2a2a" }}>
          {(["line", "candles"] as const).map(c => (
            <button
              key={c}
              type="button"
              aria-label={c === "line" ? "Line chart" : "Candlestick chart"}
              onClick={() => setCtype(c)}
              className="px-2 py-1 flex items-center"
              style={{ color: ctype === c ? "#fff" : TEXT_3, background: ctype === c ? "#ffffff14" : "transparent" }}
            >
              {c === "line" ? (
                <svg width={14} height={12} viewBox="0 0 14 12">
                  <path
                    d="M1 9 L4.5 5 L7.5 7 L13 1.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg width={14} height={12} viewBox="0 0 14 12">
                  <g stroke="currentColor" strokeWidth={1.2}>
                    <line x1={3.5} y1={0.5} x2={3.5} y2={11.5} />
                    <rect x={1.5} y={3} width={4} height={5} fill="currentColor" stroke="none" />
                    <line x1={10.5} y1={0.5} x2={10.5} y2={11.5} />
                    <rect x={8.5} y={2} width={4} height={4.5} fill="none" />
                  </g>
                </svg>
              )}
            </button>
          ))}
        </div>
        <div className="flex rounded-md overflow-hidden mr-2" style={{ border: "1px solid #2a2a2a" }}>
          {(["price", "mcap"] as const).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMetric(m);
                setYman(null);
              }}
              className="text-[10px] px-2 py-0.5"
              style={{ color: metric === m ? "#fff" : TEXT_3, background: metric === m ? "#ffffff14" : "transparent" }}
            >
              {m === "price" ? "PRICE" : "MCAP"}
            </button>
          ))}
        </div>
        {RANGES.map(r => (
          <button
            key={r.key}
            type="button"
            onClick={() => setRange(r.key)}
            className="text-[10px] px-2 py-0.5 rounded-md"
            style={{
              color: range === r.key ? "#fff" : TEXT_3,
              background: range === r.key ? "#ffffff10" : "transparent",
              border: `1px solid ${range === r.key ? "#2a2a2a" : "transparent"}`,
            }}
          >
            {r.key}
          </button>
        ))}
      </div>

      {/* chart */}
      <div ref={wrapRef} className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${H}`}
          width="100%"
          role="img"
          aria-label="TurboUSD price with AMI treasury operations"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={() => {
            setView(null);
            setYman(null);
          }}
          onClick={() => {
            if (suppressClickRef.current) return;
            if (hover?.tx) window.open(`https://basescan.org/tx/${encodeURIComponent(hover.tx)}`, "_blank", "noopener");
          }}
          style={{ display: "block", cursor: hover?.tx ? "pointer" : "default", touchAction: "none", userSelect: "none" }}
        >
          {/* watermark */}
          <text
            x={width / 2}
            y={H / 2 + 10}
            textAnchor="middle"
            fontSize={Math.min(150, width / 6)}
            fontWeight={700}
            fill="#ffffff"
            opacity={0.045}
          >
            ₸USD
          </text>

          {geom && (
            <>
              {geom.ticks.map(
                v =>
                  v >= geom.pmin &&
                  v <= geom.pmax && (
                    <g key={v}>
                      <line x1={PAD.l} y1={geom.Y(v)} x2={width - PAD.r} y2={geom.Y(v)} stroke={GRID} strokeWidth={1} />
                      <text x={width - PAD.r + 6} y={geom.Y(v) + 3} fontSize={10} fill={TEXT_3}>
                        {fmtVal(v)}
                      </text>
                    </g>
                  ),
              )}
              {Array.from({ length: nx + 1 }, (_, i) => {
                const tt = geom.t0 + (geom.t1 - geom.t0) * (i / nx);
                return (
                  <text
                    key={i}
                    x={geom.X(tt)}
                    y={H - 8}
                    fontSize={10}
                    fill={TEXT_3}
                    textAnchor={i === 0 ? "start" : i === nx ? "end" : "middle"}
                  >
                    {fmtDate(tt)}
                  </text>
                );
              })}
              <defs>
                <linearGradient id="ami-ops-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={ACCENT} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
                <clipPath id="ami-ops-clip">
                  <rect x={PAD.l} y={PAD.t} width={width - PAD.l - PAD.r} height={H - PAD.t - PAD.b} />
                </clipPath>
              </defs>
              <g clipPath="url(#ami-ops-clip)">
                {ctype === "candles" ? (
                  geom.pts.map((x, i) => {
                    const cx = geom.X(x.t);
                    const up = x.c >= x.o;
                    const col = up ? GREEN_C : RED_C;
                    const byTop = geom.Y(Math.max(x.o, x.c));
                    const byBot = geom.Y(Math.min(x.o, x.c));
                    return (
                      <g key={i}>
                        <line x1={cx} y1={geom.Y(x.l)} x2={cx} y2={geom.Y(x.h)} stroke={col} strokeWidth={1} />
                        <rect
                          x={cx - geom.barW / 2}
                          y={byTop}
                          width={geom.barW}
                          height={Math.max(1, byBot - byTop)}
                          fill={col}
                        />
                      </g>
                    );
                  })
                ) : (
                  <>
                    <path d={geom.dArea} fill="url(#ami-ops-grad)" />
                    <path
                      d={geom.dLine}
                      fill="none"
                      stroke={LINE}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </>
                )}
                {metric === "price" && avgCost && avgCost > geom.pmin && avgCost < geom.pmax && (
                  <g>
                    <line
                      x1={PAD.l}
                      y1={geom.Y(avgCost)}
                      x2={width - PAD.r}
                      y2={geom.Y(avgCost)}
                      stroke={TEXT_2}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                    />
                    <text x={width - PAD.r - 4} y={geom.Y(avgCost) - 5} fontSize={10} fill={TEXT_2} textAnchor="end">
                      avg buyback {fmtPrice(avgCost)}
                    </text>
                  </g>
                )}
                <g>
                  {geom.placed.map((h, i) => {
                    const st = OP_STYLE[h.m.type];
                    return <MarkerShape key={i} shape={st.shape} x={h.x} y={h.y} r={h.r} color={st.color} />;
                  })}
                </g>
              </g>
              {(view || yman) && (
                <text x={PAD.l + 6} y={PAD.t + 12} fontSize={9} fill={TEXT_3}>
                  double-click para resetear zoom
                </text>
              )}
              {hover && (
                <line
                  x1={hover.x * (width / (wrapRef.current?.clientWidth || width))}
                  y1={PAD.t}
                  x2={hover.x * (width / (wrapRef.current?.clientWidth || width))}
                  y2={H - PAD.b}
                  stroke="#555"
                  strokeWidth={1}
                  opacity={0.5}
                />
              )}
            </>
          )}
        </svg>

        {(loading || failed) && (
          <div
            className="absolute inset-0 flex items-center justify-center text-xs pointer-events-none"
            style={{ color: TEXT_3 }}
          >
            {loading ? "Loading on-chain data…" : "No price data available."}
          </div>
        )}

        {hover && (
          <div
            className="absolute z-10 pointer-events-none rounded-lg px-2.5 py-2 text-[11px] leading-relaxed whitespace-nowrap"
            style={{
              background: "#1b1b1b",
              border: "1px solid #333",
              boxShadow: "0 8px 24px rgba(0,0,0,.5)",
              left: Math.max(2, Math.min(hover.x + 14, (wrapRef.current?.clientWidth || width) - 240)),
              top: Math.max(2, hover.y - 70),
            }}
          >
            {hover.lines.map((l, i) => (
              <div
                key={i}
                style={{
                  color: l.cls === "main" ? "#f5f5f5" : l.cls === "date" ? TEXT_3 : TEXT_2,
                  fontWeight: l.cls === "main" ? 700 : 400,
                  fontSize: l.cls === "main" ? 12 : 11,
                  letterSpacing: l.cls === "date" ? ".08em" : undefined,
                }}
              >
                {l.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-2 text-[10px] leading-relaxed" style={{ color: TEXT_3 }}>
        Every operation AMI executes on-chain is plotted on the ₸USD price line — marker size is the USD size of the
        operation. The dashed line is AMI&apos;s average buyback price. Scroll or drag the axes to zoom; double-click to
        reset. Hover any marker for the receipt; click to open it on Basescan.
      </p>
    </div>
  );
}

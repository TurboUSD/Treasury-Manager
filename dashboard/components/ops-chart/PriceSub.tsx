import { fmtPrice, fmtPriceSub } from "./format";

/** DexScreener-style price for HTML: $0.0₅5254 — the run of zeros becomes a small count. */
export function Price({ v }: { v: number }) {
  const sub = fmtPriceSub(v);
  if (!sub) return <>{fmtPrice(v)}</>;
  return (
    <>
      {sub.lead}
      <sub className="text-[0.7em]">{sub.zeros}</sub>
      {sub.digits}
    </>
  );
}

/** The same format inside an SVG <text>: tspans, with the zero count dropped a little and shrunk. */
export function SvgPrice({ v, size }: { v: number; size: number }) {
  const sub = fmtPriceSub(v);
  if (!sub) return <>{fmtPrice(v)}</>;
  const drop = size * 0.28;
  return (
    <>
      <tspan>{sub.lead}</tspan>
      <tspan fontSize={size * 0.7} dy={drop}>
        {sub.zeros}
      </tspan>
      <tspan dy={-drop}>{sub.digits}</tspan>
    </>
  );
}

/** Rough character count of a price as drawn, for laying out labels next to it. */
export const priceChars = (v: number) => {
  const sub = fmtPriceSub(v);
  return sub ? sub.lead.length + String(sub.zeros).length * 0.7 + sub.digits.length : fmtPrice(v).length;
};

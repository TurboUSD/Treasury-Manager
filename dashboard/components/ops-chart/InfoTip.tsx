"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/** Small "i" that reveals an explanation on hover or tap (a light version of turbousd.com's InfoTip). */
export default function InfoTip({ children, side = "top" }: { children: ReactNode; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  return (
    <span
      ref={host}
      className="relative inline-flex cursor-help"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen(o => !o)}
    >
      <span
        role="img"
        aria-label="More information"
        className="flex h-6 w-6 items-center justify-center rounded-full border border-line-2 font-mono text-[11px] text-muted transition hover:border-turbo hover:text-turbo-2"
      >
        i
      </span>
      {open ? (
        <span
          className={`absolute right-0 z-30 w-[17rem] rounded-lg border border-line bg-black/95 p-3 text-left text-[12px] leading-relaxed text-ink-2 shadow-xl sm:w-80 ${side === "top" ? "bottom-8" : "top-8"}`}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { WidgetData } from "./types";

let cache: Promise<WidgetData | null> | null = null;

function load() {
  if (!cache) {
    cache = fetch("/api/widget-data")
      .then(r => (r.ok ? (r.json() as Promise<WidgetData>) : null))
      .catch(() => null);
  }
  return cache;
}

/** Operations + daily candles from this dashboard's own /api/widget-data, fetched once. */
export function useWidgetData() {
  const [data, setData] = useState<WidgetData | null>(null);
  useEffect(() => {
    let alive = true;
    load().then(d => alive && setData(d));
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

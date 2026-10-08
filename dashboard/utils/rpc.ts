/**
 * Base RPC with every fallback we have, for the server routes.
 *
 * Why this exists: the routes used `BASE_RPC_URL || ANKR_RPC_URL || alchemy`.
 * `||` only checks that a variable is SET, not that the endpoint WORKS, so
 * when the Ankr key was disabled every request went to a 401 and the
 * dashboard (and AMI's /claim, which reads it) went down while a working
 * Alchemy key sat unused in the same line.
 *
 * Now every configured endpoint is tried in order, per request:
 *
 *   1. BASE_RPC_URL                 (env, primary)
 *   2. ANKR_RPC_URL                 (env)
 *   3. ALCHEMY_RPC_URL              (env, full URL)
 *   4. NEXT_PUBLIC_ALCHEMY_API_KEY  (env, key only -> Alchemy Base URL)
 *   5. BASE_RPC_FALLBACK_URLS       (env, comma separated, any extra)
 *   6. Alchemy free key bundled with Scaffold-ETH
 *   7. Public Base RPCs: publicnode, blockpi, tenderly, base.org, 1rpc, drpc
 *   8. Etherscan V2 proxy API       (only with ETHERSCAN_API_KEY; see below)
 *
 * An endpoint that is DOWN (auth refused, 5xx, timeout, network) is benched
 * for a few minutes, so a dead primary costs one failed request per warm
 * instance instead of one per call. An endpoint that only refuses one
 * request (a getLogs range too wide for a public node) is skipped for that
 * request and stays in the rotation. A contract revert is an ANSWER, not an
 * outage: it is thrown at once, never retried elsewhere.
 *
 * Etherscan: its free plan does not cover Base -- the API answers "Free API
 * access is not supported for this chain" (checked 2026-10). It is wired in
 * last so that a paid key works the day there is one; on a free key it is
 * benched like any other dead endpoint and costs nothing after that.
 */
import { custom, http } from "viem";
import { base } from "viem/chains";

type Request = (args: { method: string; params?: unknown }) => Promise<unknown>;

interface Endpoint {
  name: string;
  request: Request;
  benchedUntil: number;
}

const BENCH_DOWN_MS = 5 * 60_000; // auth refused, 5xx, timeout
const BENCH_LIMITED_MS = 30_000; // 429: rate limited, back soon
const TIMEOUT_MS = 8_000;

const PUBLIC_RPCS: [string, string][] = [
  ["publicnode", "https://base-rpc.publicnode.com"],
  ["blockpi", "https://base.public.blockpi.network/v1/rpc/public"],
  ["tenderly", "https://base.gateway.tenderly.co"],
  ["base.org", "https://mainnet.base.org"],
  ["1rpc", "https://1rpc.io/base"],
  ["drpc", "https://base.drpc.org"],
];

/** Free Alchemy key that ships with Scaffold-ETH (scaffold.config.ts). */
const SCAFFOLD_ALCHEMY_KEY = "8GVG8WjDs-sGFRr6Rm839";

const alchemyUrl = (key: string) =>
  `https://base-mainnet.g.alchemy.com/v2/${key}`;

/** Every endpoint, in order, deduplicated. Pure apart from reading env. */
export function rpcUrls(
  env: Record<string, string | undefined> = process.env,
): [string, string][] {
  const out: [string, string][] = [];
  const add = (name: string, url?: string) => {
    const u = (url || "").trim();
    if (u && /^https?:\/\//.test(u) && !out.some(([, x]) => x === u))
      out.push([name, u]);
  };
  add("BASE_RPC_URL", env.BASE_RPC_URL);
  add("ANKR_RPC_URL", env.ANKR_RPC_URL);
  add("ALCHEMY_RPC_URL", env.ALCHEMY_RPC_URL);
  if (env.NEXT_PUBLIC_ALCHEMY_API_KEY)
    add(
      "alchemy (env key)",
      alchemyUrl(env.NEXT_PUBLIC_ALCHEMY_API_KEY.trim()),
    );
  for (const [i, u] of (env.BASE_RPC_FALLBACK_URLS || "").split(",").entries())
    add(`fallback #${i + 1}`, u);
  add("alchemy (scaffold key)", alchemyUrl(SCAFFOLD_ALCHEMY_KEY));
  for (const [name, url] of PUBLIC_RPCS) add(name, url);
  return out;
}

/* ── errors ─────────────────────────────────────────────────────────────── */

const REVERT_RE = /execution reverted|revert/i;

/** A revert / invalid input is the chain's answer: do not try elsewhere. */
export function isAnswer(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  if (code === 3) return true; // execution reverted
  const msg = `${err?.details ?? ""} ${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  return (
    REVERT_RE.test(msg) && !/rate|limit|unauthor|forbidden|api key/i.test(msg)
  );
}

/** How long to bench the endpoint that produced `err` (0 = only skip it now). */
export function benchFor(err: any): number {
  const status = err?.status ?? err?.cause?.status;
  if (status === 429) return BENCH_LIMITED_MS;
  if (
    typeof status === "number" &&
    (status === 401 || status === 403 || status >= 500)
  )
    return BENCH_DOWN_MS;
  const name = err?.name ?? "";
  if (name === "TimeoutError" || name === "HttpRequestError")
    return BENCH_DOWN_MS; // network / no status
  const msg = `${err?.details ?? ""} ${err?.message ?? ""}`;
  if (
    /api key|unauthori[sz]ed|forbidden|disabled|not supported for this chain|upgrade your api plan/i.test(
      msg,
    )
  )
    return BENCH_DOWN_MS;
  if (/rate.?limit|too many requests|max calls per sec/i.test(msg))
    return BENCH_LIMITED_MS;
  return 0; // e.g. "block range too large": fine for other calls
}

/* ── Etherscan V2 proxy as an EIP-1193 request function ─────────────────── */

export function etherscanRequest(
  apiKey: string,
  chainId = base.id,
  fetchFn: typeof fetch = fetch,
): Request {
  const api = "https://api.etherscan.io/v2/api";
  const get = async (q: Record<string, string>) => {
    const url = `${api}?${new URLSearchParams({ chainid: String(chainId), ...q, apikey: apiKey })}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok)
      throw Object.assign(new Error(`etherscan HTTP ${res.status}`), {
        status: res.status,
      });
    const j: any = await res.json();
    if (j?.error)
      throw Object.assign(new Error(j.error.message || "etherscan rpc error"), {
        code: j.error.code,
      });
    // module=proxy answers {jsonrpc,result}; other modules answer {status,message,result}
    if (j?.status === "0" && j?.message !== "No records found")
      throw new Error(
        `etherscan: ${typeof j.result === "string" ? j.result : j.message}`,
      );
    return j?.status === "0" ? [] : j.result;
  };
  const tag = (b: unknown) => (typeof b === "string" ? b : "latest");
  return async ({ method, params }) => {
    const p = (Array.isArray(params) ? params : []) as any[];
    switch (method) {
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "eth_blockNumber":
        return get({ module: "proxy", action: "eth_blockNumber" });
      case "eth_getBlockByNumber":
        return get({
          module: "proxy",
          action: "eth_getBlockByNumber",
          tag: tag(p[0]),
          boolean: String(!!p[1]),
        });
      case "eth_getTransactionByHash":
        return get({
          module: "proxy",
          action: "eth_getTransactionByHash",
          txhash: p[0],
        });
      case "eth_getTransactionReceipt":
        return get({
          module: "proxy",
          action: "eth_getTransactionReceipt",
          txhash: p[0],
        });
      case "eth_getCode":
        return get({
          module: "proxy",
          action: "eth_getCode",
          address: p[0],
          tag: tag(p[1]),
        });
      case "eth_gasPrice":
        return get({ module: "proxy", action: "eth_gasPrice" });
      case "eth_call":
        return get({
          module: "proxy",
          action: "eth_call",
          to: p[0]?.to,
          data: p[0]?.data ?? p[0]?.input ?? "0x",
          tag: tag(p[1]),
        });
      case "eth_getBalance": {
        const wei = await get({
          module: "account",
          action: "balance",
          address: p[0],
          tag: "latest",
        });
        return `0x${BigInt(wei).toString(16)}`;
      }
      case "eth_getLogs": {
        const f = p[0] || {};
        // Etherscan cannot OR values in one topic position or query several
        // addresses at once. Answering with the first value would return the
        // WRONG logs, so such a filter is refused and the next endpoint
        // (or the caller's own Etherscan expansion) takes it.
        if (
          (Array.isArray(f.address) && f.address.length > 1) ||
          (f.topics || []).some((t: unknown) => Array.isArray(t))
        )
          throw Object.assign(
            new Error("etherscan: filter needs topic OR / several addresses"),
            { code: -32601 },
          );
        const q: Record<string, string> = { module: "logs", action: "getLogs" };
        if (f.fromBlock) q.fromBlock = String(parseInt(f.fromBlock, 16) || 0);
        if (f.toBlock)
          q.toBlock =
            f.toBlock === "latest" ? "latest" : String(parseInt(f.toBlock, 16));
        if (f.address)
          q.address = Array.isArray(f.address) ? f.address[0] : f.address;
        (f.topics || []).forEach((t: any, i: number) => {
          if (typeof t === "string") q[`topic${i}`] = t;
        });
        const logs: any[] = await get(q);
        // Etherscan returns "0x" for a zero logIndex/transactionIndex; viem wants a number
        return logs.map((l) => ({
          ...l,
          logIndex: l.logIndex === "0x" ? "0x0" : l.logIndex,
          transactionIndex:
            l.transactionIndex === "0x" ? "0x0" : l.transactionIndex,
          removed: false,
        }));
      }
      default:
        throw Object.assign(new Error(`etherscan: ${method} not mapped`), {
          code: -32601,
        });
    }
  };
}

/* ── the transport ──────────────────────────────────────────────────────── */

export function buildEndpoints(
  env: Record<string, string | undefined> = process.env,
): Endpoint[] {
  const list: Endpoint[] = rpcUrls(env).map(([name, url]) => ({
    name,
    request: http(url, { retryCount: 0, timeout: TIMEOUT_MS })({ chain: base })
      .request as Request,
    benchedUntil: 0,
  }));
  const ek = (
    env.ETHERSCAN_APIKEY ||
    env.ETHERSCAN_API_KEY ||
    env.BASESCAN_API_KEY ||
    ""
  ).trim();
  if (ek)
    list.push({
      name: "etherscan",
      request: etherscanRequest(ek),
      benchedUntil: 0,
    });
  return list;
}

/** One request through the endpoints: live ones in order, then benched ones
 *  as a last resort (a bench is a guess; trying is cheaper than failing). */
export async function resilientRequest(
  endpoints: Endpoint[],
  args: { method: string; params?: unknown },
  now: () => number = Date.now,
): Promise<unknown> {
  const t = now();
  const order = [
    ...endpoints.filter((e) => e.benchedUntil <= t),
    ...endpoints.filter((e) => e.benchedUntil > t),
  ];
  let lastErr: unknown;
  for (const e of order) {
    try {
      return await e.request(args);
    } catch (err: any) {
      if (isAnswer(err)) throw err;
      lastErr = err;
      const ms = benchFor(err);
      if (ms > 0) {
        if (e.benchedUntil <= t)
          console.warn(
            `[rpc] ${e.name} benched ${ms / 1000}s: ${(err?.shortMessage || err?.message || err).toString().split("\n")[0]}`,
          );
        e.benchedUntil = now() + ms;
      }
    }
  }
  throw lastErr ?? new Error("no RPC endpoint configured");
}

let shared: Endpoint[] | null = null;

/** The transport for createPublicClient. One endpoint table per warm instance. */
export function baseTransport() {
  shared ??= buildEndpoints();
  const endpoints = shared;
  return custom(
    { request: (args: any) => resilientRequest(endpoints, args) },
    { retryCount: 0 },
  );
}

/** Raw JSON-RPC for code that does not use viem (widget-data). Same endpoints. */
export async function baseRpc(
  method: string,
  params: unknown[] = [],
): Promise<any> {
  shared ??= buildEndpoints();
  return resilientRequest(shared, { method, params });
}

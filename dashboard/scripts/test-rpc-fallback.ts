import { createPublicClient, parseAbiItem } from "viem";
import { base } from "viem/chains";
import * as R from "../utils/rpc";

let fails = 0;
const check = (name: string, ok: boolean, d: unknown = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + JSON.stringify(d)}`); if (!ok) fails++; };
const DEAD_ANKR = "https://rpc.ankr.com/base/03a23b243fd5d81414dde3d7f86c7e34bc61ec28f43153419b54a162f489e65b";
const TUSD = "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07" as const;
const erc20 = [{ type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
               { type: "function", name: "nope", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

console.log("\n── the endpoint list ──");
const env = { BASE_RPC_URL: DEAD_ANKR, ANKR_RPC_URL: DEAD_ANKR, NEXT_PUBLIC_ALCHEMY_API_KEY: "8GVG8WjDs-sGFRr6Rm839",
              BASE_RPC_FALLBACK_URLS: " https://example.invalid/rpc , ,notaurl" };
const urls = R.rpcUrls(env);
check("both env vars kept, deduplicated (same URL once)", urls[0][0] === "BASE_RPC_URL" && urls.filter(([, u]) => u === DEAD_ANKR).length === 1, urls);
check("the env Alchemy key and the scaffold key are the same URL -> once", urls.filter(([, u]) => u.includes("8GVG8")).length === 1);
check("extra fallbacks from env, junk ignored", urls.some(([n]) => n === "fallback #1") && !urls.some(([, u]) => u === "notaurl"));
check("public RPCs at the end", urls.slice(-6).map(([n]) => n).join(",") === "publicnode,blockpi,tenderly,base.org,1rpc,drpc", urls.slice(-6));
check("no env at all still has endpoints", R.rpcUrls({}).length === 7);

console.log("\n── against the real network, with the dead Ankr key first ──");
const calls: Record<string, number> = {};
const eps = R.buildEndpoints(env).map(e => ({ ...e, request: async (a: any) => { calls[e.name] = (calls[e.name] || 0) + 1; return e.request(a); } }));
const client = createPublicClient({ chain: base, transport: (await import("viem")).custom({ request: (a: any) => R.resilientRequest(eps as any, a) }, { retryCount: 0 }) });
const b = await client.getBlockNumber();
check("block number answered", b > 50_000_000n, String(b));
check("the dead one was tried once and benched", calls["BASE_RPC_URL"] === 1 && eps[0].benchedUntil > Date.now());
await client.getBlockNumber({ cacheTime: 0 });
check("…and not tried again on the next call", calls["BASE_RPC_URL"] === 1, calls);
const ts = await client.readContract({ address: TUSD, abi: erc20, functionName: "totalSupply" });
check("eth_call works", ts > 0n);
const mc = await client.multicall({ contracts: [{ address: TUSD, abi: erc20, functionName: "totalSupply" }], allowFailure: false });
check("multicall works", mc[0] === ts);
const logs = await client.getLogs({ address: TUSD, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), fromBlock: b - 5000n, toBlock: b });
check("getLogs works", Array.isArray(logs));
const before = JSON.stringify(calls);
let revertErr: any = null;
try { await client.readContract({ address: TUSD, abi: erc20, functionName: "nope" }); } catch (e) { revertErr = e; }
const after = calls;
const extra = Object.values(after).reduce((a, n) => a + n, 0) - Object.values(JSON.parse(before) as Record<string, number>).reduce((a, n) => a + n, 0);
check("a revert is thrown, not retried on every endpoint", revertErr && extra === 1, { extra, err: revertErr?.shortMessage });

console.log("\n── classification ──");
check("401 benches 5 min", R.benchFor({ name: "HttpRequestError", status: 401 }) === 300_000);
check("429 benches 30 s", R.benchFor({ status: 429 }) === 30_000);
check("'block range too large' only skips", R.benchFor({ name: "InvalidInputRpcError", details: "block range is too large" }) === 0);
check("etherscan's free-tier refusal benches", R.benchFor(new Error("etherscan: Free API access is not supported for this chain. Please upgrade your api plan")) === 300_000);
check("revert is an answer", R.isAnswer({ code: 3 }) && R.isAnswer({ details: "execution reverted" }));
check("rate limit is not", !R.isAnswer({ details: "rate limit exceeded" }));

console.log("\n── Etherscan mapping (stubbed fetch) ──");
const seen: string[] = [];
const fakeFetch: any = async (url: string) => { seen.push(url); const u = new URL(url);
  const a = u.searchParams.get("action");
  const body = a === "getLogs" ? { status: "1", message: "OK", result: [{ address: TUSD, logIndex: "0x", transactionIndex: "0x", topics: [], data: "0x" }] }
            : a === "balance" ? { status: "1", message: "OK", result: "1000" }
            : { jsonrpc: "2.0", id: 1, result: "0x10" };
  return { ok: true, json: async () => body }; };
const es = R.etherscanRequest("KEY", 8453, fakeFetch);
check("blockNumber -> proxy", (await es({ method: "eth_blockNumber" })) === "0x10" && seen[0].includes("module=proxy") && seen[0].includes("chainid=8453"));
await es({ method: "eth_call", params: [{ to: TUSD, data: "0x18160ddd" }, "latest"] });
check("eth_call -> to/data/tag", seen[1].includes("action=eth_call") && seen[1].includes("data=0x18160ddd"));
check("balance -> hex", (await es({ method: "eth_getBalance", params: [TUSD, "latest"] })) === "0x3e8");
const l: any = await es({ method: "eth_getLogs", params: [{ address: TUSD, fromBlock: "0x10", toBlock: "latest", topics: ["0xabc"] }] });
check("getLogs -> logs module, decimal blocks, topic0, '0x' indexes fixed", seen[3].includes("module=logs") && seen[3].includes("fromBlock=16") && seen[3].includes("topic0=0xabc") && l[0].logIndex === "0x0");
let orErr: any = null;
try { await es({ method: "eth_getLogs", params: [{ address: TUSD, topics: ["0xabc", null, ["0x1", "0x2"]] }] }); } catch (e) { orErr = e; }
check("a topic-OR filter is refused, never answered wrong", orErr && R.benchFor(orErr) === 0 && !R.isAnswer(orErr), orErr?.message);
check("chainId answered locally", (await es({ method: "eth_chainId" })) === "0x2105");
const refuse: any = async () => ({ ok: true, json: async () => ({ status: "0", message: "NOTOK", result: "Free API access is not supported for this chain. Please upgrade your api plan" }) });
let er: any = null; try { await R.etherscanRequest("K", 8453, refuse)({ method: "eth_blockNumber" }); } catch (e) { er = e; }
check("the free-tier refusal surfaces as an error that benches", er && R.benchFor(er) === 300_000, er?.message);

console.log(fails ? `\nFAILED: ${fails}` : "\nAll rpc fallback tests passed.");
process.exit(fails ? 1 : 0);

import { NextResponse } from "next/server";
import { createPublicClient, formatEther, formatUnits, http, parseAbiItem } from "viem";
import { base } from "viem/chains";
import { getSupabaseAdmin } from "~~/utils/supabase";

// ── Contract addresses ─────────────────────────────────────────────────────
const TREASURY_V1 = "0x3dbF93D110C677A1c063A600cb42940262f3BBd6";
const TREASURY_V2 = "0xAF8b3FEBA3411430FAc757968Ac1c9FB25b84107";
const TREASURY_V2_OLD = "0x65D240dD9Aa9280DcFb4a5648de8C0668a854E1b";
const TREASURY_V2_OLDEST = "0xefd86aAd40Cb4340d4ace8B5d8bf7692ADdc02f8";
const ACTIVE_TREASURY = TREASURY_V2;

const TUSD = "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07";
const WETH_ADDR = "0x4200000000000000000000000000000000000006";
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const TUSD_POOL = "0xd013725b904e76394A3aB0334Da306C505D778F8";
const USDC_WETH_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
const STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";
const BURN_ENGINE = "0x022688aDcDc24c648F4efBa76e42CD16BD0863AB";
const LEGACY_FEE_SOURCE = "0x1eaf444ebDf6495C57aD52A04C61521bBf564ace";
const LP_FEE_SOURCE = "0x33e2Eda238edcF470309b8c6D228986A1204c8f9";
const STAKING_CONTRACT = "0x2a70a42BC0524aBCA9Bff59a51E7aAdB575DC89A";

// ── Strategic tokens ───────────────────────────────────────────────────────
type StratToken = {
  ticker: string;
  ctTicker: string; // CoinTracking ticker
  address: string;
  isV4: boolean;
  v3Pool: string;
  v4PoolId: string;
};

const STRATEGIC_TOKENS: StratToken[] = [
  { ticker: "BNKR", ctTicker: "BNKR2", address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b", isV4: false, v3Pool: "0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703", v4PoolId: "" },
  { ticker: "DRB", ctTicker: "DRB2", address: "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2", isV4: false, v3Pool: "0x5116773e18A9C7bB03EBB961b38678E45E238923", v4PoolId: "" },
  { ticker: "Clanker", ctTicker: "CLANKER", address: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb", isV4: false, v3Pool: "0xC1a6FBeDAe68E1472DbB91FE29B51F7a0Bd44F97", v4PoolId: "" },
  { ticker: "KELLY", ctTicker: "KELLYCA", address: "0x50D2280441372486BeecdD328c1854743EBaCb07", isV4: true, v3Pool: "", v4PoolId: "0x7EAC33D5641697366EAEC3234147FD98BA25F01ACCA66A51A48BD129FC532145" },
  { ticker: "CLAWD", ctTicker: "CLAWD", address: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07", isV4: true, v3Pool: "", v4PoolId: "0x9FD58E73D8047CB14AC540ACD141D3FC1A41FB6252D674B730FAF62FE24AA8CE" },
  { ticker: "JUNO", ctTicker: "JUNO", address: "0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07", isV4: true, v3Pool: "", v4PoolId: "0x1635213E2B19E459A4132DF40011638B65AE7510A35D6A88C47EBF94912C7F2E" },
  { ticker: "FELIX", ctTicker: "FELIX", address: "0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07", isV4: true, v3Pool: "", v4PoolId: "0x6E19027912DB90892200A2B08C514921917BC55D7291EC878AA382C193B50084" },
];

// CoinTracking ticker map
const CT_TICKER: Record<string, string> = {
  "₸USD": "TUSD2",
  TUSD: "TUSD2",
  WETH: "WETH",
  USDC: "USDC",
};
for (const t of STRATEGIC_TOKENS) {
  CT_TICKER[t.ticker] = t.ctTicker;
}

// ── ABIs (minimal for server-side reads) ───────────────────────────────────
const erc20BalanceOf = parseAbiItem("function balanceOf(address) view returns (uint256)");
const erc20TotalSupply = parseAbiItem("function totalSupply() view returns (uint256)");
const slot0Abi = parseAbiItem("function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)");
const stateViewGetSlot0 = parseAbiItem("function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)");
const burnEngineGetStatus = parseAbiItem("function getStatus() view returns (uint256 totalBurned, uint256 lastCycleTime, uint256 totalCycles)");
const ownerAbi = parseAbiItem("function owner() view returns (address)");
const operatorAbi = parseAbiItem("function authorizedOperator() view returns (address)");

const strategicBuyEvent = parseAbiItem("event StrategicBuyExecuted(address indexed token, uint256 wethSpent, uint256 tokenReceived)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// ── Price math ─────────────────────────────────────────────────────────────
const Q192 = 2n ** 192n;

function calcWethPriceUsd(sqrtPriceX96: bigint): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return 0;
  const scale = 10n ** 18n;
  const priceScaled = (sqrtPriceX96 * sqrtPriceX96 * scale) / Q192;
  return (Number(priceScaled) / 1e18) * 1e12;
}

function calcTusdPerWeth(sqrtPriceX96: bigint): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n) return 0;
  const scale = 10n ** 18n;
  const priceScaled = (Q192 * scale) / (sqrtPriceX96 * sqrtPriceX96);
  return Number(priceScaled) / 1e18;
}

function calcTusdPriceUsd(tusdPoolSqrt: bigint, wethPriceUsd: number): number {
  if (!tusdPoolSqrt || tusdPoolSqrt === 0n || wethPriceUsd === 0) return 0;
  const tusdPerWeth = calcTusdPerWeth(tusdPoolSqrt);
  if (tusdPerWeth === 0) return 0;
  return wethPriceUsd / tusdPerWeth;
}

function calcV4TokenPriceUsd(sqrtPriceX96: bigint, wethPriceUsd: number): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n || wethPriceUsd === 0) return 0;
  const scale = 10n ** 18n;
  const tokenPerWeth = (sqrtPriceX96 * sqrtPriceX96 * scale) / Q192;
  const tokenPerWethNum = Number(tokenPerWeth) / 1e18;
  if (tokenPerWethNum === 0) return 0;
  return wethPriceUsd / tokenPerWethNum;
}

function calcV3TokenPriceUsd(sqrtPriceX96: bigint, wethPriceUsd: number): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n || wethPriceUsd === 0) return 0;
  const scale = 10n ** 18n;
  const priceScaled = (sqrtPriceX96 * sqrtPriceX96 * scale) / Q192;
  return (Number(priceScaled) / 1e18) * wethPriceUsd;
}

// ── Viem client ────────────────────────────────────────────────────────────
const rpcUrl = process.env.BASE_RPC_URL || `https://base-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY || "8GVG8WjDs-sGFRr6Rm839"}`;

const client = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

// ── Cache TTL (5 minutes) ──────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Madrid timezone date formatting ────────────────────────────────────────
function toMadridDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" }); // YYYY-MM-DD
}

/** Returns ISO timestamp string for Supabase TIMESTAMPTZ (absolute moment, UTC) */
function toIsoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/** Returns CoinTracking-compatible date string: "DD.MM.YYYY HH:MM:SS" in Europe/Madrid timezone */
function toMadridCT(ts: number): string {
  const d = new Date(ts * 1000);
  // Build parts using Intl.DateTimeFormat for reliable timezone conversion
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const p = (type: string) => parts.find(x => x.type === type)?.value || "00";
  // "DD.MM.YYYY HH:MM:SS"
  return `${p("day")}.${p("month")}.${p("year")} ${p("hour")}:${p("minute")}:${p("second")}`;
}

// ── Main GET handler ───────────────────────────────────────────────────────
export async function GET() {
  try {
    const sb = getSupabaseAdmin();

    // 1. Check cache freshness
    const { data: cacheRow } = await sb
      .from("treasury_cache")
      .select("data, updated_at")
      .eq("key", "current")
      .single();

    const cacheAge = cacheRow?.updated_at ? Date.now() - new Date(cacheRow.updated_at).getTime() : Infinity;
    const isFresh = cacheAge < CACHE_TTL_MS;

    // If cache is fresh, return it immediately (+ operations from DB)
    if (isFresh && cacheRow?.data && Object.keys(cacheRow.data).length > 0) {
      const { data: ops } = await sb
        .from("operations")
        .select("*")
        .order("date_utc", { ascending: false })
        .limit(200);

      return NextResponse.json({
        ...cacheRow.data,
        operations: ops || [],
        cached: true,
        cacheAge: Math.round(cacheAge / 1000),
      });
    }

    // 2. Fetch all live data from RPC (multicall for efficiency)
    const currentBlock = await client.getBlockNumber();
    const now = Math.floor(Date.now() / 1000);

    // Multicall: balances, prices, supply, burns, etc.
    // We use individual calls grouped into a single multicall for efficiency.
    // Type assertion needed because viem multicall expects homogeneous ABI types.
    const contracts = [
      // 0: TUSD balance of treasury
      { address: TUSD as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [ACTIVE_TREASURY as `0x${string}`] },
      // 1: WETH balance of treasury
      { address: WETH_ADDR as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [ACTIVE_TREASURY as `0x${string}`] },
      // 2: USDC balance of treasury
      { address: USDC_ADDR as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [ACTIVE_TREASURY as `0x${string}`] },
      // 3: TUSD total supply
      { address: TUSD as `0x${string}`, abi: [erc20TotalSupply], functionName: "totalSupply" },
      // 4: TUSD burned (dead address)
      { address: TUSD as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [DEAD as `0x${string}`] },
      // 5: USDC/WETH pool slot0
      { address: USDC_WETH_POOL as `0x${string}`, abi: [slot0Abi], functionName: "slot0" },
      // 6: TUSD pool slot0
      { address: TUSD_POOL as `0x${string}`, abi: [slot0Abi], functionName: "slot0" },
      // 7: BurnEngine status
      { address: BURN_ENGINE as `0x${string}`, abi: [burnEngineGetStatus], functionName: "getStatus" },
      // 8: Owner
      { address: ACTIVE_TREASURY as `0x${string}`, abi: [ownerAbi], functionName: "owner" },
      // 9: Operator
      { address: ACTIVE_TREASURY as `0x${string}`, abi: [operatorAbi], functionName: "authorizedOperator" },
      // 10: TUSD staked
      { address: TUSD as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [STAKING_CONTRACT as `0x${string}`] },
      // 11: Legacy fee TUSD pending
      { address: TUSD as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [LEGACY_FEE_SOURCE as `0x${string}`] },
      // 12: LP fee TUSD pending
      { address: TUSD as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [LP_FEE_SOURCE as `0x${string}`] },
      // 13: LP fee WETH pending
      { address: WETH_ADDR as `0x${string}`, abi: [erc20BalanceOf], functionName: "balanceOf", args: [LP_FEE_SOURCE as `0x${string}`] },
      // 14-20: Strategic token balances
      ...STRATEGIC_TOKENS.map(t => ({
        address: t.address as `0x${string}`,
        abi: [erc20BalanceOf] as const,
        functionName: "balanceOf" as const,
        args: [ACTIVE_TREASURY as `0x${string}`],
      })),
      // 21-23: V3 pool slot0 (BNKR, DRB, Clanker)
      ...STRATEGIC_TOKENS.filter(t => !t.isV4).map(t => ({
        address: t.v3Pool as `0x${string}`,
        abi: [slot0Abi] as const,
        functionName: "slot0" as const,
      })),
      // 24-27: V4 pool slot0 via StateView
      ...STRATEGIC_TOKENS.filter(t => t.isV4).map(t => ({
        address: STATE_VIEW as `0x${string}`,
        abi: [stateViewGetSlot0] as const,
        functionName: "getSlot0" as const,
        args: [t.v4PoolId as `0x${string}`],
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const results = await client.multicall({ contracts });

    // Extract results
    const val = (i: number) => (results[i]?.status === "success" ? results[i].result : null);

    const tusdBal = val(0) as bigint | null;
    const wethBal = val(1) as bigint | null;
    const usdcBal = val(2) as bigint | null;
    const tusdSupply = val(3) as bigint | null;
    const tusdBurned = val(4) as bigint | null;
    const usdcWethSlot0 = val(5) as readonly [bigint, number, number, number, number, number, boolean] | null;
    const tusdPoolSlot0 = val(6) as readonly [bigint, number, number, number, number, number, boolean] | null;
    const burnStatus = val(7) as readonly [bigint, bigint, bigint] | null;
    const ownerAddr = val(8) as string | null;
    const operatorAddr = val(9) as string | null;
    const tusdStakedBal = val(10) as bigint | null;
    const legacyTusdPending = val(11) as bigint | null;
    const lpTusdPending = val(12) as bigint | null;
    const lpWethPending = val(13) as bigint | null;

    // Strategic balances (indices 14-20)
    const stratBalances: Record<string, number> = {};
    STRATEGIC_TOKENS.forEach((t, i) => {
      const b = val(14 + i) as bigint | null;
      stratBalances[t.ticker] = b ? Number(formatEther(b)) : 0;
    });

    // Prices
    const wethPriceUsd = usdcWethSlot0 ? calcWethPriceUsd(usdcWethSlot0[0]) : 0;
    const tusdPriceUsd = tusdPoolSlot0 ? calcTusdPriceUsd(tusdPoolSlot0[0], wethPriceUsd) : 0;

    // V3 prices (indices 21-23)
    const v3Tokens = STRATEGIC_TOKENS.filter(t => !t.isV4);
    const stratPrices: Record<string, number> = {};
    v3Tokens.forEach((t, i) => {
      const s0 = val(21 + i) as readonly [bigint, ...unknown[]] | null;
      stratPrices[t.ticker] = s0 ? calcV3TokenPriceUsd(s0[0], wethPriceUsd) : 0;
    });

    // V4 prices (indices 24-27)
    const v4Tokens = STRATEGIC_TOKENS.filter(t => t.isV4);
    v4Tokens.forEach((t, i) => {
      const s0 = val(24 + i) as readonly [bigint, ...unknown[]] | null;
      stratPrices[t.ticker] = s0 ? calcV4TokenPriceUsd(s0[0], wethPriceUsd) : 0;
    });

    // Computed values
    const tusdBalNum = tusdBal ? Number(formatEther(tusdBal)) : 0;
    const wethBalNum = wethBal ? Number(formatEther(wethBal)) : 0;
    const usdcBalNum = usdcBal ? Number(formatUnits(usdcBal, 6)) : 0;
    const tusdSupplyNum = tusdSupply ? Number(formatEther(tusdSupply)) : 0;
    const tusdBurnedNum = tusdBurned ? Number(formatEther(tusdBurned)) : 0;
    const tusdStakedNum = tusdStakedBal ? Number(formatEther(tusdStakedBal)) : 0;
    const pendingTusd = (legacyTusdPending ? Number(formatEther(legacyTusdPending)) : 0) + (lpTusdPending ? Number(formatEther(lpTusdPending)) : 0);
    const pendingWeth = lpWethPending ? Number(formatEther(lpWethPending)) : 0;

    const engineBurned = burnStatus ? Number(formatEther(burnStatus[0])) : 0;
    const engineCycles = burnStatus ? Number(burnStatus[2]) : 0;
    const engineLastCycleTs = burnStatus && burnStatus[1] > 0n ? Number(burnStatus[1]) : null;

    // Strategic computed rows
    const strategicRows = STRATEGIC_TOKENS.map(t => {
      const balance = stratBalances[t.ticker];
      const price = stratPrices[t.ticker] || 0;
      return {
        ticker: t.ticker,
        address: t.address,
        isV4: t.isV4,
        balance,
        currentPrice: price,
        valueUsd: balance * price,
      };
    }).filter(r => r.balance > 0);

    const strategicTotalUsd = strategicRows.reduce((s, r) => s + r.valueUsd, 0);
    const baseManagedUsd = tusdBalNum * tusdPriceUsd + wethBalNum * wethPriceUsd + usdcBalNum;
    const totalManagedUsd = baseManagedUsd + strategicTotalUsd;

    // 3. Incremental event scanning — find new StrategicBuy events
    const { data: scanRow } = await sb.from("scan_state").select("block_number").eq("key", "last_block").single();
    let lastScannedBlock = BigInt(scanRow?.block_number || 0);

    // On first run, start from ~100 days ago
    if (lastScannedBlock === 0n) {
      lastScannedBlock = currentBlock > 4_320_000n ? currentBlock - 4_320_000n : 0n;
    }

    const fromBlock = lastScannedBlock + 1n;
    let newOpsInserted = 0;

    if (fromBlock <= currentBlock) {
      try {
        // Scan StrategicBuy events
        const buyLogs = await client.getLogs({
          address: ACTIVE_TREASURY as `0x${string}`,
          event: strategicBuyEvent,
          fromBlock,
          toBlock: currentBlock,
        });

        for (const log of buyLogs) {
          const tokenAddr = (log.args as { token: string }).token.toLowerCase();
          const wethSpent = Number(formatEther((log.args as { wethSpent: bigint }).wethSpent));
          const tokenReceived = Number(formatEther((log.args as { tokenReceived: bigint }).tokenReceived));

          // Check if already in DB (by tx_hash)
          const { data: existing } = await sb
            .from("operations")
            .select("id")
            .eq("tx_hash", log.transactionHash)
            .eq("op_type", "StrategicBuy")
            .limit(1);

          if (existing && existing.length > 0) continue;

          // Find token info
          const strat = STRATEGIC_TOKENS.find(t => t.address.toLowerCase() === tokenAddr);
          const ticker = strat?.ticker || tokenAddr.slice(0, 10);
          const ctTickerToken = strat?.ctTicker || ticker;

          // Estimate timestamp from block (~2s per block on Base)
          const blockDiff = Number(currentBlock - log.blockNumber);
          const ts = now - blockDiff * 2;
          const dateUtc = toIsoUtc(ts);
          const dateMadrid = toMadridCT(ts);

          // Compute WETH price at time (approximate — use current price for now)
          const wethUsd = wethPriceUsd;
          const tokenPriceAtBuy = tokenReceived > 0 ? (wethSpent * wethUsd) / tokenReceived : 0;

          // Row 1: Gas fee as Other Fee (ETH)
          // We don't have gas cost from logs alone; skip gas row for now.
          // AMI 9000 will add its own gas rows.

          // Row 2: Trade — token bought with WETH
          const rows = [
            {
              type: "Trade",
              buy_amount: tokenReceived,
              buy_currency: ctTickerToken,
              sell_amount: wethSpent,
              sell_currency: "WETH",
              exchange: "Treasury Manager",
              group_name: "Treasury Manager",
              comment: `Strategic Buy ${ticker} via ${strat?.isV4 ? "V4" : "V3"}`,
              op_type: "StrategicBuy",
              token_address: tokenAddr,
              amount_raw: `${tokenReceived.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${ticker}`,
              weth_price_usd: wethUsd,
              token_price_usd: tokenPriceAtBuy,
              tx_hash: log.transactionHash,
              block_number: Number(log.blockNumber),
              date_utc: dateUtc,
              date_madrid: dateMadrid,
              source: "dashboard",
            },
          ];

          const { error } = await sb.from("operations").insert(rows);
          if (!error) newOpsInserted += rows.length;
        }

        // Update scan state
        await sb.from("scan_state").upsert({
          key: "last_block",
          block_number: Number(currentBlock),
          updated_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error("Event scan error:", e);
      }
    }

    // 4. Build chart snapshots from Transfer events (historical)
    // For chart data, we re-scan from a wide window and build daily snapshots
    // This runs only when cache is stale (every 5 min)
    const chartStartBlock = currentBlock > 4_320_000n ? currentBlock - 4_320_000n : 0n;
    const tokenInfo: Record<string, { cat: "tusd" | "weth" | "usdc" | "strategic"; dec: number }> = {};
    tokenInfo[TUSD.toLowerCase()] = { cat: "tusd", dec: 18 };
    tokenInfo[WETH_ADDR.toLowerCase()] = { cat: "weth", dec: 18 };
    tokenInfo[USDC_ADDR.toLowerCase()] = { cat: "usdc", dec: 6 };
    for (const t of STRATEGIC_TOKENS) {
      tokenInfo[t.address.toLowerCase()] = { cat: "strategic", dec: 18 };
    }
    const tokenAddrs = Object.keys(tokenInfo) as `0x${string}`[];
    const treasuries = [TREASURY_V1, TREASURY_V2_OLDEST, TREASURY_V2_OLD, ACTIVE_TREASURY] as `0x${string}`[];

    type LogEntry = { block: bigint; token: string; amount: bigint; dir: 1 | -1 };
    const allLogs: LogEntry[] = [];

    const coreTokenAddrs = new Set([TUSD.toLowerCase(), WETH_ADDR.toLowerCase(), USDC_ADDR.toLowerCase()]);
    const coreTokens = tokenAddrs.filter(a => coreTokenAddrs.has(a.toLowerCase()));

    for (const tAddr of treasuries) {
      const tokensForThisTreasury = tAddr === ACTIVE_TREASURY ? tokenAddrs : coreTokens;
      if (tokensForThisTreasury.length === 0) continue;
      try {
        const [inLogs, outLogs] = await Promise.all([
          client.getLogs({
            address: tokensForThisTreasury as `0x${string}`[],
            event: transferEvent,
            args: { to: tAddr as `0x${string}` },
            fromBlock: chartStartBlock,
          }),
          client.getLogs({
            address: tokensForThisTreasury as `0x${string}`[],
            event: transferEvent,
            args: { from: tAddr as `0x${string}` },
            fromBlock: chartStartBlock,
          }),
        ]);
        for (const l of inLogs) {
          if ((l.args as { value: bigint }).value)
            allLogs.push({ block: l.blockNumber, token: l.address.toLowerCase(), amount: (l.args as { value: bigint }).value, dir: 1 });
        }
        for (const l of outLogs) {
          if ((l.args as { value: bigint }).value)
            allLogs.push({ block: l.blockNumber, token: l.address.toLowerCase(), amount: (l.args as { value: bigint }).value, dir: -1 });
        }
      } catch {
        // Continue if one treasury range fails
      }
    }

    allLogs.sort((a, b) => Number(a.block - b.block));

    const running: Record<string, number> = {};
    const dailyMap: Record<string, Record<string, number>> = {};

    for (const log of allLogs) {
      const info = tokenInfo[log.token];
      if (!info) continue;
      const v = Number(log.amount) / 10 ** info.dec;
      running[log.token] = (running[log.token] || 0) + v * log.dir;

      const blockDiff = Number(currentBlock - log.block);
      const ts = now - blockDiff * 2;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      dailyMap[date] = { ...running };
    }

    const tokenToTicker: Record<string, string> = {};
    for (const t of STRATEGIC_TOKENS) tokenToTicker[t.address.toLowerCase()] = t.ticker;

    const dates = Object.keys(dailyMap).sort();
    const chartSnapshots = dates.map(d => {
      const bals = dailyMap[d];
      let tusd = 0, weth = 0, usdc = 0, strategic = 0;
      const perToken: Record<string, number> = {};
      for (const [addr, bal] of Object.entries(bals)) {
        const info = tokenInfo[addr];
        if (!info) continue;
        const b = Math.max(0, bal);
        if (info.cat === "tusd") tusd += b * tusdPriceUsd;
        else if (info.cat === "weth") weth += b * wethPriceUsd;
        else if (info.cat === "usdc") usdc += b;
        else if (info.cat === "strategic") {
          const tick = tokenToTicker[addr] || addr.slice(0, 6);
          const price = stratPrices[tick] || 0;
          const usd = b * price;
          strategic += usd;
          perToken[`strat_${tick}`] = (perToken[`strat_${tick}`] || 0) + usd;
        }
      }
      return { date: d, dateRaw: d, tusd, weth, usdc, strategic, ...perToken };
    });

    // Today snapshot
    const todayPerToken: Record<string, number> = {};
    for (const r of strategicRows) {
      todayPerToken[`strat_${r.ticker}`] = r.valueUsd;
    }
    const todaySnapshot = {
      date: "Today",
      tusd: tusdBalNum * tusdPriceUsd,
      weth: wethBalNum * wethPriceUsd,
      usdc: usdcBalNum,
      strategic: strategicTotalUsd,
      ...todayPerToken,
    };

    const fullChart = [...chartSnapshots, todaySnapshot];

    // 5. Update cache
    const cacheData = {
      wethPriceUsd,
      tusdPriceUsd,
      tusdBalNum,
      wethBalNum,
      usdcBalNum,
      tusdSupplyNum,
      tusdBurnedNum,
      tusdStakedNum,
      pendingTusd,
      pendingWeth,
      engineBurned,
      engineCycles,
      engineLastCycleTs,
      ownerAddr,
      operatorAddr,
      strategicRows,
      stratPrices,
      stratBalances,
      strategicTotalUsd,
      totalManagedUsd,
      chartData: fullChart,
      currentBlock: Number(currentBlock),
    };

    await sb.from("treasury_cache").upsert({
      key: "current",
      data: cacheData,
      updated_at: new Date().toISOString(),
    });

    // 6. Get operations from DB
    const { data: ops } = await sb
      .from("operations")
      .select("*")
      .order("date_utc", { ascending: false })
      .limit(200);

    return NextResponse.json({
      ...cacheData,
      operations: ops || [],
      cached: false,
      newOpsInserted,
    });
  } catch (error) {
    console.error("Treasury data API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch treasury data", details: String(error) },
      { status: 500 },
    );
  }
}

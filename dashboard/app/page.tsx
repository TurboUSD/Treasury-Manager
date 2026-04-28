"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { Area, AreaChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

// ── Contract Addresses ─────────────────────────────────────────────────────
const TREASURY_V1 = "0x3dbF93D110C677A1c063A600cb42940262f3BBd6" as const;
const TREASURY_V2 = "0xAF8b3FEBA3411430FAc757968Ac1c9FB25b84107" as const;
const TREASURY_V2_OLD = "0x65D240dD9Aa9280DcFb4a5648de8C0668a854E1b" as const;
const TREASURY_V2_OLDEST = "0xefd86aAd40Cb4340d4ace8B5d8bf7692ADdc02f8" as const;
const BURN_ENGINE = "0x022688aDcDc24c648F4efBa76e42CD16BD0863AB" as const;
const LEGACY_FEE_CLAIMER = "0x2c857A891338fe17D86651B7B78C59c96e274246" as const;
// Owner is read dynamically from the contract (see ownerAddr below)

const TUSD = "0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07" as const;
const WETH_ADDR = "0x4200000000000000000000000000000000000006" as const;
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const DEAD = "0x000000000000000000000000000000000000dEaD" as const;

const TUSD_POOL = "0xd013725b904e76394A3aB0334Da306C505D778F8" as const;
const USDC_WETH_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224" as const;
const STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71" as const;

// Fee source addresses for BurnEngine pending fees
const LEGACY_FEE_SOURCE = "0x1eaf444ebDf6495C57aD52A04C61521bBf564ace" as const;
const LP_FEE_SOURCE = "0x33e2Eda238edcF470309b8c6D228986A1204c8f9" as const;

// Staking contract (TUSD staking on Base)
const STAKING_CONTRACT = "0x2a70a42BC0524aBCA9Bff59a51E7aAdB575DC89A" as const;

// The active treasury address — change when v2 is deployed
const ACTIVE_TREASURY =
  (TREASURY_V2 as string) !== "0x0000000000000000000000000000000000000000" ? TREASURY_V2 : TREASURY_V1;

// ── ABIs ──────────────────────────────────────────────────────────────────
const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

const poolAbi = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const stateViewAbi = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

const transferEventAbi = {
  type: "event",
  name: "Transfer",
  inputs: [
    { type: "address", name: "from", indexed: true },
    { type: "address", name: "to", indexed: true },
    { type: "uint256", name: "value", indexed: false },
  ],
} as const;

const strategicBuyEventAbi = {
  type: "event",
  name: "StrategicBuy",
  inputs: [
    { type: "address", name: "token", indexed: true },
    { type: "uint256", name: "wethSpent", indexed: false },
    { type: "uint256", name: "tokenReceived", indexed: false },
  ],
} as const;

const burnEngineAbi = [
  {
    name: "getStatus",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "_totalBurnedAllTime", type: "uint256" },
      { name: "_lastCycleTimestamp", type: "uint256" },
      { name: "_cycleCount", type: "uint256" },
      { name: "_wethBalance", type: "uint256" },
      { name: "_tusdBalance", type: "uint256" },
    ],
  },
] as const;

const legacyFeeClaimerAbi = [
  {
    name: "claimAndBurn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

const treasuryV2Abi = [
  {
    name: "owner",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "authorizedOperator",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "addStrategicToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "isV4", type: "bool" },
      { name: "v3Pool", type: "address" },
      { name: "v3Fee", type: "uint24" },
      { name: "v4PoolId", type: "bytes32" },
      { name: "v4Currency0", type: "address" },
      { name: "v4Currency1", type: "address" },
      { name: "v4Fee", type: "uint24" },
      { name: "v4TickSpacing", type: "int24" },
      { name: "v4Hooks", type: "address" },
      { name: "buyPriceUsd", type: "uint256" },
      { name: "buyMarketCapUsd", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "strategicTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "isV4", type: "bool" },
      { name: "fallbackActivatedOnce", type: "bool" },
      { name: "v3Fee", type: "uint24" },
      { name: "v4Fee", type: "uint24" },
      { name: "v4TickSpacing", type: "int24" },
      { name: "v3Pool", type: "address" },
      { name: "v4Hooks", type: "address" },
      { name: "v4Currency0", type: "address" },
      { name: "v4Currency1", type: "address" },
      { name: "v4PoolId", type: "bytes32" },
      { name: "buyPriceUsd", type: "uint256" },
      { name: "buyMarketCapUsd", type: "uint256" },
      { name: "trackedDeposits", type: "uint256" },
      { name: "totalSold", type: "uint256" },
      { name: "fallbackSold", type: "uint256" },
    ],
  },
  // Owner operations
  {
    name: "buybackWETH",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wethAmount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "buybackUSDC",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "usdcAmount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "burnTUSD",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "stakeTUSD",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "poolId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "unstakeTUSD",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "poolId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "rebalanceStrategicToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "buyStrategicToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "wethAmount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setBuyStrategicLimits",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_perAction", type: "uint256" },
      { name: "_perDay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setCoreOperatorLimits",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_buybackWethPerAction", type: "uint256" },
      { name: "_buybackWethPerDay", type: "uint256" },
      { name: "_buybackUsdcPerAction", type: "uint256" },
      { name: "_buybackUsdcPerDay", type: "uint256" },
      { name: "_burnTusdPerAction", type: "uint256" },
      { name: "_burnTusdPerDay", type: "uint256" },
      { name: "_stakeTusdPerAction", type: "uint256" },
      { name: "_stakeTusdPerDay", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setOperatorConfig",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_cooldown", type: "uint256" },
      { name: "_slippageBps", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setRebalanceLimits",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_perAction", type: "uint256" },
      { name: "_perDay", type: "uint256" },
    ],
    outputs: [],
  },
  // State variable readers for current limits
  {
    name: "buybackWethPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "buybackWethPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "buybackUsdcPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "buybackUsdcPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "burnTusdPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "burnTusdPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "stakeTusdPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "stakeTusdPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "operatorCooldown",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "operatorSlippageBps",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "rebalanceWethPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "rebalanceWethPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "buyStrategicWethPerAction",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "buyStrategicWethPerDay",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Strategic Token Presets ──────────────────────────────────────────────
type StrategicPreset = {
  ticker: string;
  token: string;
  isV4: boolean;
  v3Pool: string;
  v3Fee: number;
  v4PoolId: string;
  v4Currency0: string;
  v4Currency1: string;
  v4Fee: number;
  v4TickSpacing: number;
  v4Hooks: string;
  buyPriceUsd: string;
  buyMarketCapUsd: string;
  entryDate: string;
  entryTxHash: string;
};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const V4_HOOKS = "0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC";

const STRATEGIC_PRESETS: StrategicPreset[] = [
  // V3 Tokens
  {
    ticker: "BNKR",
    token: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b",
    isV4: false,
    v3Pool: "0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703",
    v3Fee: 10000,
    v4PoolId: ZERO_BYTES32,
    v4Currency0: ZERO_ADDR,
    v4Currency1: ZERO_ADDR,
    v4Fee: 0,
    v4TickSpacing: 0,
    v4Hooks: ZERO_ADDR,
    buyPriceUsd: "", // computed from operations
    buyMarketCapUsd: "35000000",
    entryDate: "2026-04-06",
    entryTxHash: "0xd53e31aa6d385ffc7591af5d72b365af310da559c817e75c37aeaacd59e6a0b8",
  },
  {
    ticker: "DRB",
    token: "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2",
    isV4: false,
    v3Pool: "0x5116773e18A9C7bB03EBB961b38678E45E238923",
    v3Fee: 10000,
    v4PoolId: ZERO_BYTES32,
    v4Currency0: ZERO_ADDR,
    v4Currency1: ZERO_ADDR,
    v4Fee: 0,
    v4TickSpacing: 0,
    v4Hooks: ZERO_ADDR,
    buyPriceUsd: "", // computed from operations
    buyMarketCapUsd: "9000000",
    entryDate: "2026-04-06",
    entryTxHash: "0x629e9b161c0ebc42afb619c76c7e74f30c42cff474864690132544afdd7735ec",
  },
  {
    ticker: "Clanker",
    token: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb",
    isV4: false,
    v3Pool: "0xC1a6FBeDAe68E1472DbB91FE29B51F7a0Bd44F97",
    v3Fee: 10000,
    v4PoolId: ZERO_BYTES32,
    v4Currency0: ZERO_ADDR,
    v4Currency1: ZERO_ADDR,
    v4Fee: 0,
    v4TickSpacing: 0,
    v4Hooks: ZERO_ADDR,
    buyPriceUsd: "25",
    buyMarketCapUsd: "25000000",
    entryDate: "2026-03-18",
    entryTxHash: "",
  },
  // V4 Tokens
  {
    ticker: "KELLY",
    token: "0x50D2280441372486BeecdD328c1854743EBaCb07",
    isV4: true,
    v3Pool: ZERO_ADDR,
    v3Fee: 0,
    v4PoolId: "0x7EAC33D5641697366EAEC3234147FD98BA25F01ACCA66A51A48BD129FC532145",
    v4Currency0: WETH_ADDR,
    v4Currency1: "0x50D2280441372486BeecdD328c1854743EBaCb07",
    v4Fee: 8388608,
    v4TickSpacing: 200,
    v4Hooks: V4_HOOKS,
    buyPriceUsd: "0.00001534",
    buyMarketCapUsd: "1000000",
    entryDate: "2026-04-06",
    entryTxHash: "0x98b109a4676955aaa51f6838e39beb2e90467390e07bbb68277d70ccbe1a119b",
  },
  {
    ticker: "CLAWD",
    token: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07",
    isV4: true,
    v3Pool: ZERO_ADDR,
    v3Fee: 0,
    v4PoolId: "0x9FD58E73D8047CB14AC540ACD141D3FC1A41FB6252D674B730FAF62FE24AA8CE",
    v4Currency0: WETH_ADDR,
    v4Currency1: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07",
    v4Fee: 8388608,
    v4TickSpacing: 200,
    v4Hooks: V4_HOOKS,
    buyPriceUsd: "", // computed from operations
    buyMarketCapUsd: "2800000",
    entryDate: "2026-04-06",
    entryTxHash: "0xe155eaae48be06fea5c1bd7fe2831f10b15f6d4a07be1fa09e32469c97a39d82",
  },
  {
    ticker: "JUNO",
    token: "0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07",
    isV4: true,
    v3Pool: ZERO_ADDR,
    v3Fee: 0,
    v4PoolId: "0x1635213E2B19E459A4132DF40011638B65AE7510A35D6A88C47EBF94912C7F2E",
    v4Currency0: WETH_ADDR,
    v4Currency1: "0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07",
    v4Fee: 8388608,
    v4TickSpacing: 200,
    v4Hooks: V4_HOOKS,
    buyPriceUsd: "0.000008",
    buyMarketCapUsd: "800000",
    entryDate: "2026-03-18",
    entryTxHash: "",
  },
  {
    ticker: "FELIX",
    token: "0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07",
    isV4: true,
    v3Pool: ZERO_ADDR,
    v3Fee: 0,
    v4PoolId: "0x6E19027912DB90892200A2B08C514921917BC55D7291EC878AA382C193B50084",
    v4Currency0: WETH_ADDR,
    v4Currency1: "0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07",
    v4Fee: 8388608,
    v4TickSpacing: 200,
    v4Hooks: V4_HOOKS,
    buyPriceUsd: "0.00001",
    buyMarketCapUsd: "1000000",
    entryDate: "2026-03-18",
    entryTxHash: "",
  },
];

const EMPTY_PRESET: StrategicPreset = {
  ticker: "CUSTOM",
  token: "",
  isV4: false,
  v3Pool: "",
  v3Fee: 10000,
  v4PoolId: ZERO_BYTES32,
  v4Currency0: WETH_ADDR,
  v4Currency1: "",
  v4Fee: 8388608,
  v4TickSpacing: 200,
  v4Hooks: V4_HOOKS,
  buyPriceUsd: "",
  buyMarketCapUsd: "",
  entryDate: "",
  entryTxHash: "",
};

// ── Known historical operations (TreasuryManager v1 + BurnEngine) ────────
type Operation = {
  type: "Buyback" | "Burn" | "Rebalance" | "Stake" | "BurnEngine" | "StrategicBuy" | "StrategicSell" | "FeeClaim" | string;
  amount: string;
  token: string;
  usdValue: string;
  date: string;
  txHash: string;
  // StrategicSell: ROI vs buy price (shown as sub-line under amount)
  roiPct?: number; // e.g. 250 (green) or -30 (red)
};

// Historical ops — USD values for burns are computed dynamically from live price.
// StrategicBuy entries are read from Supabase operations table (written by AMI 9000).
const HISTORICAL_OPS_RAW = [
  {
    type: "Buyback" as const,
    amount: "22,024,060 \u20B8USD",
    token: "\u20B8USD",
    usdValue: "$100",
    date: "2026-03-18",
    txHash: "0x5c3aac4e5ff14e22313f485d01b19432fd1294acf1740055f3e77f0ce7c5362b",
    tusdAmount: 0,
  },
  {
    type: "Burn" as const,
    amount: "43,147,461 \u20B8USD",
    token: "\u20B8USD",
    usdValue: "",
    date: "2026-03-18",
    txHash: "0xa590b565b381eea85b144cd39821d301fb7d23d4c13e4a147033d87491db161c",
    tusdAmount: 43_147_461,
  },
  {
    type: "BurnEngine" as const,
    amount: "1,000 \u20B8USD",
    token: "\u20B8USD",
    usdValue: "",
    date: "2026-03-18",
    txHash: "0xe39ab49ffd9894e21ecfd8f7eec071ffef09587b19e57503680f1a51fc297c0b",
    tusdAmount: 1_000,
  },
  {
    type: "BurnEngine" as const,
    amount: "1,000 \u20B8USD",
    token: "\u20B8USD",
    usdValue: "",
    date: "2026-03-18",
    txHash: "0xb8df47dcd3ff0e07efa98007360dba7d0ab74058bd283163c9db397d34913f96",
    tusdAmount: 1_000,
  },
  // StrategicBuy entries are no longer hardcoded here — they come from Supabase
];

// Total ₸USD already accounted for in HISTORICAL_OPS_RAW for BurnEngine
const KNOWN_ENGINE_BURNED = 2_000;

// ── Price Helpers ──────────────────────────────────────────────────────────

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

// V4: currency0=WETH, currency1=TOKEN (both 18 dec)
// sqrtPriceX96² / Q192 = TOKEN per WETH → token price in WETH = 1 / that ratio
function calcV4TokenPriceUsd(sqrtPriceX96: bigint, wethPriceUsd: number): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n || wethPriceUsd === 0) return 0;
  const scale = 10n ** 18n;
  // price = token/weth = sqrtPriceX96² * scale / Q192
  const tokenPerWeth = (sqrtPriceX96 * sqrtPriceX96 * scale) / Q192;
  const tokenPerWethNum = Number(tokenPerWeth) / 1e18;
  if (tokenPerWethNum === 0) return 0;
  return wethPriceUsd / tokenPerWethNum;
}

// V3: token is token0 (18 dec), WETH is token1 (18 dec) — true for BNKR, DRB, Clanker
function calcV3TokenPriceUsd(sqrtPriceX96: bigint, wethPriceUsd: number): number {
  if (!sqrtPriceX96 || sqrtPriceX96 === 0n || wethPriceUsd === 0) return 0;
  const scale = 10n ** 18n;
  const priceScaled = (sqrtPriceX96 * sqrtPriceX96 * scale) / Q192;
  return (Number(priceScaled) / 1e18) * wethPriceUsd;
}

// ── Format Helpers ────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** USD without decimals unless value < 10 (then 2 decimals) */
function fmtUsdShort(n: number): string {
  if (n < 10) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtBig(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return Math.round(n).toString();
}

/** Like fmtBig but without decimals: 956M, 22M, 25B */
function fmtBigRound(n: number): string {
  if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return Math.round(n).toString();
}

/** Full number with thousand separators: 3838664 → "3,838,664", 0.0018 → "0.0018" */
function fmtFull(n: number): string {
  if (n === 0) return "0";
  // For small numbers (< 1), show at least 2 significant digits
  if (Math.abs(n) < 1) {
    const digits = Math.max(2, -Math.floor(Math.log10(Math.abs(n))) + 1);
    return n.toFixed(digits);
  }
  return Math.round(n).toLocaleString("en-US");
}

/** Compact an amount string like "22,024,060 ₸USD" → "22M ₸USD" for mobile.
 *  Rules: >=1B → XB, >=1M → XM, >=1K → XK, all without decimals.
 *  Small numbers (<1) keep significant digits (e.g. "0.0018 WETH"). */
function compactAmount(s: string): string {
  // Match integers with commas or decimals like "0.0018"
  const m = s.match(/^([\d,.]+)\s*(.*)$/);
  if (!m) return s;
  const num = Number(m[1].replace(/,/g, ""));
  const suffix = m[2];
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B ${suffix}`.trim();
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M ${suffix}`.trim();
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K ${suffix}`.trim();
  return s;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

// ── Cache tiers (staleTime for React Query — prevents re-fetch while data is fresh) ──
const STALE_STATIC = 24 * 60 * 60 * 1000; // 24h — owner, operator (almost never change)
const STALE_SLOW = 4 * 60 * 60 * 1000; // 4h — prices, supply, burns, pending fees
const STALE_MED = 30 * 60 * 1000; // 30min — balances (change only on transactions)

// ── Design tokens ─────────────────────────────────────────────────────────
const GOLD = "#43e397";
const CARD_BG = "#141414";
const CARD_BORDER = "#0f5a2a";
const TEXT_MUTED = "#a8a8a8";
const TEXT_DIM = "#888888";

// ── Components ────────────────────────────────────────────────────────────

function CopyIconButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 800);
  };
  return (
    <button onClick={handleCopy} type="button">
      {copied ? (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="h-[18px] w-[18px]"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="h-[18px] w-[18px]"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" /></svg>
      )}
    </button>
  );
}

function StatCard({ title, value, subtitle, emoji, tooltip }: { title: React.ReactNode; value: string; subtitle?: React.ReactNode; emoji?: string; tooltip?: React.ReactNode }) {
  const [tipOpen, setTipOpen] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const isTouch = useRef(false);

  useEffect(() => {
    if (!tipOpen) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setTipOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [tipOpen]);

  return (
    <div
      ref={cardRef}
      className="rounded-xl p-3 sm:p-5 stat-card-mobile relative"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, cursor: tooltip ? "pointer" : undefined }}
      onTouchStart={() => { isTouch.current = true; }}
      onClick={() => tooltip && setTipOpen(prev => !prev)}
      onMouseEnter={() => { if (tooltip && !isTouch.current) setTipOpen(true); }}
      onMouseLeave={() => { if (tooltip && !isTouch.current) setTipOpen(false); isTouch.current = false; }}
    >
      {emoji && (
        <span className="absolute bottom-2 right-2 sm:bottom-auto sm:top-1/2 sm:right-4 sm:-translate-y-1/2 text-2xl sm:text-4xl opacity-80 select-none">
          {emoji}
        </span>
      )}
      <h3
        className="text-[10px] sm:text-xs font-medium uppercase tracking-wider"
        style={{ color: TEXT_MUTED, fontWeight: 600 }}
      >
        {title}
      </h3>
      <p className="text-base sm:text-xl font-bold mt-1 text-white">{value}</p>
      {subtitle && (
        <div className="text-[10px] sm:text-sm mt-2" style={{ color: TEXT_DIM }}>
          {subtitle}
        </div>
      )}
      {tooltip && tipOpen && (
        <div
          className="absolute rounded-lg z-50"
          style={{
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "#111",
            border: "1px solid #0f5a2a",
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 12,
            color: "#ccc",
            whiteSpace: "nowrap",
            boxShadow: "0 8px 20px rgba(0,0,0,0.5)",
          }}
        >
          {tooltip}
        </div>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold mb-4 uppercase tracking-widest" style={{ color: GOLD }}>
      {children}
    </h2>
  );
}

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="max-w-4xl w-full px-4 mb-8">
      <button onClick={() => setOpen(o => !o)} className="flex items-center justify-between w-full mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-widest" style={{ color: GOLD }}>
          {title}
        </h2>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke={GOLD}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && children}
    </div>
  );
}

// ── Permissionless Fee Burner Panel ───────────────────────────────────────
function LegacyFeeBurnerPanel() {
  const { address: connectedAddress } = useAccount();
  const { openConnectModal } = useConnectModal();

  const {
    writeContract: writeClaimBurn,
    data: cbHash,
    isPending: cbPending,
    error: cbError,
    isSuccess: cbSuccess,
  } = useWriteContract();

  const { isLoading: cbConfirming } = useWaitForTransactionReceipt({ hash: cbHash });

  const handleClaimBurn = () => {
    writeClaimBurn({
      address: LEGACY_FEE_CLAIMER,
      abi: legacyFeeClaimerAbi,
      functionName: "claimAndBurn",
      chainId: base.id,
    });
  };

  return (
    <div className="max-w-4xl w-full px-4 mb-8">
      <SectionTitle>Permissionless Fee Burner</SectionTitle>
      <div
        className="rounded-xl p-6 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 sm:gap-6 items-center"
        style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      >
        {/* Left: How it works */}
        <div className="text-sm" style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <p
            className="font-semibold text-xs uppercase tracking-widest"
            style={{ color: TEXT_MUTED, fontWeight: 600, margin: 0 }}
          >
            How it works
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em", lineHeight: 1.4, margin: 0 }}>
            ↳ Claims Clanker LP fees <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>(WETH + ₸USD)</span> and
            Legacy fees <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>(₸USD)</span>
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em", margin: 0 }}>
            ↳ Swaps WETH → ₸USD
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em", margin: 0 }}>
            ↳ Burns ALL ₸USD to{" "}
            <span className="font-mono text-xs" style={{ color: GOLD }}>
              0xdead
            </span>
          </p>
        </div>

        {/* Right: Claim & Burn card */}
        <div
          className="rounded-lg px-5 py-3 sm:py-5 space-y-3 min-w-[220px] sm:max-w-[300px] mt-[10px] sm:mt-0"
          style={{
            background: "linear-gradient(135deg, #002a10 0%, #00150a 100%)",
            border: "1px solid #0f5a2a",
            paddingTop: 3,
          }}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Claim & Burn</p>
            <p className="text-xs" style={{ color: TEXT_DIM }}>
              Everyone can claim the fees at any moment. No owner, no admin, no pause — permissionless hyperstructure
            </p>
          </div>
          <button
            onClick={connectedAddress ? handleClaimBurn : openConnectModal}
            disabled={connectedAddress ? cbPending || cbConfirming : false}
            className="btn btn-sm w-full"
            style={{
              background: !connectedAddress ? "transparent" : cbPending || cbConfirming ? "#1a1a1a" : GOLD,
              border: `1px solid ${GOLD}`,
              color: !connectedAddress ? GOLD : "#000",
            }}
          >
            {!connectedAddress ? "Connect Wallet" : cbPending || cbConfirming ? "Confirming…" : "Claim & Burn"}
          </button>
          {cbSuccess && cbHash && (
            <a
              href={`https://basescan.org/tx/${cbHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs hover:underline block text-center"
              style={{ color: GOLD }}
            >
              View tx ↗
            </a>
          )}
          {cbError && <p className="text-xs text-red-400">{cbError.message?.slice(0, 100)}</p>}
        </div>
      </div>
    </div>
  );
}

// ── Owner Operations Panel ────────────────────────────────────────────────
type OpType = "buyback-weth" | "buyback-usdc" | "burn" | "stake" | "unstake" | "rebalance" | "buy-strategic";

function OwnerOperationsPanel() {
  const [activeOp, setActiveOp] = useState<OpType>("buyback-weth");
  const [amount, setAmount] = useState("");
  const [rebalanceToken, setRebalanceToken] = useState(STRATEGIC_PRESETS[0].token);
  const [buyStrategicToken, setBuyStrategicToken] = useState(STRATEGIC_PRESETS[0].token);
  const [poolId, setPoolId] = useState("5");

  const { writeContract, data: txHash, isPending, error: writeError, isSuccess, reset } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const opFilters: { id: OpType; label: string }[] = [
    { id: "buyback-weth", label: "Buyback (WETH)" },
    { id: "buyback-usdc", label: "Buyback (USDC)" },
    { id: "burn", label: "Burn" },
    { id: "stake", label: "Stake" },
    { id: "unstake", label: "Unstake" },
    { id: "rebalance", label: "Rebalance" },
    { id: "buy-strategic", label: "Buy Strategic" },
  ];

  const handleSubmit = () => {
    if (!amount && activeOp !== "rebalance") return;
    reset();

    try {
      if (activeOp === "buyback-weth") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "buybackWETH",
          args: [parseEther(amount)],
          chainId: base.id,
        });
      } else if (activeOp === "buyback-usdc") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "buybackUSDC",
          args: [parseUnits(amount, 6)],
          chainId: base.id,
        });
      } else if (activeOp === "burn") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "burnTUSD",
          args: [parseEther(amount)],
          chainId: base.id,
        });
      } else if (activeOp === "stake") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "stakeTUSD",
          args: [parseEther(amount), BigInt(poolId || "5")],
          chainId: base.id,
        });
      } else if (activeOp === "unstake") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "unstakeTUSD",
          args: [parseEther(amount), BigInt(poolId || "5")],
          chainId: base.id,
        });
      } else if (activeOp === "rebalance") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "rebalanceStrategicToken",
          args: [rebalanceToken as `0x${string}`, parseEther(amount || "0")],
          chainId: base.id,
        });
      } else if (activeOp === "buy-strategic") {
        writeContract({
          address: ACTIVE_TREASURY as `0x${string}`,
          abi: treasuryV2Abi,
          functionName: "buyStrategicToken",
          args: [buyStrategicToken as `0x${string}`, parseEther(amount)],
          chainId: base.id,
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const amountLabel: Record<OpType, string> = {
    "buyback-weth": "WETH amount",
    "buyback-usdc": "USDC amount",
    burn: "₸USD amount to burn",
    stake: "₸USD amount",
    unstake: "₸USD amount",
    rebalance: "Token amount (standard units)",
    "buy-strategic": "WETH amount to spend",
  };

  const amountPlaceholder: Record<OpType, string> = {
    "buyback-weth": "e.g. 0.05",
    "buyback-usdc": "e.g. 100",
    burn: "e.g. 1000000",
    stake: "e.g. 1000000",
    unstake: "e.g. 1000000",
    rebalance: "e.g. 1",
    "buy-strategic": "e.g. 0.5",
  };

  const btnLabel: Record<OpType, string> = {
    "buyback-weth": "Buyback ₸USD with WETH",
    "buyback-usdc": "Buyback ₸USD with USDC",
    burn: "Burn ₸USD",
    stake: "Stake ₸USD",
    unstake: "Unstake ₸USD",
    rebalance: "Rebalance Token",
    "buy-strategic": "Buy Token with WETH",
  };

  return (
    <div className="max-w-4xl w-full px-4 mb-8">
      <SectionTitle>Quick Operations (Owner Only)</SectionTitle>
      <div className="rounded-xl p-6" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        {/* Op type filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          {opFilters.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => {
                setActiveOp(id);
                setAmount("");
                reset();
              }}
              className="btn btn-sm"
              style={{
                background: activeOp === id ? GOLD : "transparent",
                border: `1px solid ${activeOp === id ? GOLD : "#2a2a2a"}`,
                color: activeOp === id ? "#000" : "#888",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Token picker for rebalance / buy-strategic */}
        {(activeOp === "rebalance" || activeOp === "buy-strategic") && (
          <div className="mb-4">
            <label
              className="text-xs uppercase tracking-wider block mb-2"
              style={{ color: TEXT_MUTED, fontWeight: 600 }}
            >
              Token
            </label>
            <div className="flex flex-wrap gap-2">
              {STRATEGIC_PRESETS.map(p => {
                const currentToken = activeOp === "rebalance" ? rebalanceToken : buyStrategicToken;
                const isSelected = currentToken === p.token;
                return (
                  <button
                    key={p.token}
                    onClick={() =>
                      activeOp === "rebalance" ? setRebalanceToken(p.token) : setBuyStrategicToken(p.token)
                    }
                    className="btn btn-sm"
                    style={{
                      background: isSelected ? GOLD : "transparent",
                      border: `1px solid ${isSelected ? GOLD : "#2a2a2a"}`,
                      color: isSelected ? "#000" : "#888",
                    }}
                  >
                    {p.ticker}
                    <span className="ml-1 text-xs" style={{ opacity: 0.6 }}>
                      {p.isV4 ? "V4" : "V3"}
                    </span>
                  </button>
                );
              })}
            </div>
            {activeOp === "rebalance" && rebalanceToken && (
              <p className="text-xs mt-2 font-mono" style={{ color: TEXT_DIM }}>
                {rebalanceToken}
              </p>
            )}
            {activeOp === "buy-strategic" && buyStrategicToken && (
              <p className="text-xs mt-2 font-mono" style={{ color: TEXT_DIM }}>
                {buyStrategicToken}
              </p>
            )}
          </div>
        )}

        {/* Fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {/* Pool ID — only for stake/unstake */}
          {(activeOp === "stake" || activeOp === "unstake") && (
            <div className="md:col-span-2">
              <label
                className="text-xs uppercase tracking-wider block mb-1"
                style={{ color: TEXT_MUTED, fontWeight: 600 }}
              >
                Pool ID
              </label>
              <input
                type="number"
                step="1"
                className="input input-bordered w-full font-mono"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: `1px solid #2a2a2a` }}
                placeholder="e.g. 5"
                value={poolId}
                onChange={e => setPoolId(e.target.value)}
              />
              <p className="text-xs mt-1" style={{ color: TEXT_DIM }}>
                Aerodrome pool ID (default: 5)
              </p>
            </div>
          )}

          {/* Amount */}
          <div className="md:col-span-2">
            <label
              className="text-xs uppercase tracking-wider block mb-1"
              style={{ color: TEXT_MUTED, fontWeight: 600 }}
            >
              {amountLabel[activeOp]}
            </label>
            <input
              type="number"
              step="any"
              className="input input-bordered w-full font-mono"
              style={{ background: "#0a0a0a", color: "#e8e8e8", border: `1px solid #2a2a2a` }}
              placeholder={amountPlaceholder[activeOp]}
              value={amount}
              onChange={e => setAmount(e.target.value)}
            />
            <p className="text-xs mt-1" style={{ color: TEXT_DIM }}>
              Enter in standard units (e.g. 1.5 WETH, not wei) — conversion is automatic
            </p>
          </div>
        </div>

        {/* Status */}
        {writeError && (
          <div
            className="rounded-lg p-3 mb-4 text-sm"
            style={{ background: "#1a0000", border: "1px solid #ff6b6b33", color: "#ff6b6b" }}
          >
            {writeError.message?.slice(0, 200)}
          </div>
        )}
        {isSuccess && txHash && (
          <div
            className="rounded-lg p-3 mb-4 text-sm"
            style={{ background: "#001a0a", border: "1px solid #34eeb633", color: "#34eeb6" }}
          >
            Transaction confirmed!{" "}
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View on Basescan ↗
            </a>
          </div>
        )}

        <button
          onClick={handleSubmit}
          disabled={isPending || isConfirming || !amount}
          className="btn w-full"
          style={{
            background: isPending || isConfirming ? "#1a1a1a" : GOLD,
            border: `1px solid ${GOLD}`,
            color: "#000",
            fontWeight: 700,
          }}
        >
          {isPending ? "Confirm in wallet…" : isConfirming ? "Confirming…" : btnLabel[activeOp]}
        </button>
      </div>
    </div>
  );
}

// ── Operator Limits Panel ────────────────────────────────────────────────
function OperatorLimitsPanel() {
  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  // Read current limits
  const limitReadBase = {
    address: ACTIVE_TREASURY as `0x${string}`,
    abi: treasuryV2Abi,
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  } as const;
  const { data: curBuybackWethPA } = useReadContract({ ...limitReadBase, functionName: "buybackWethPerAction" });
  const { data: curBuybackWethPD } = useReadContract({ ...limitReadBase, functionName: "buybackWethPerDay" });
  const { data: curBuybackUsdcPA } = useReadContract({ ...limitReadBase, functionName: "buybackUsdcPerAction" });
  const { data: curBuybackUsdcPD } = useReadContract({ ...limitReadBase, functionName: "buybackUsdcPerDay" });
  const { data: curBurnTusdPA } = useReadContract({ ...limitReadBase, functionName: "burnTusdPerAction" });
  const { data: curBurnTusdPD } = useReadContract({ ...limitReadBase, functionName: "burnTusdPerDay" });
  const { data: curStakeTusdPA } = useReadContract({ ...limitReadBase, functionName: "stakeTusdPerAction" });
  const { data: curStakeTusdPD } = useReadContract({ ...limitReadBase, functionName: "stakeTusdPerDay" });
  const { data: curCooldown } = useReadContract({ ...limitReadBase, functionName: "operatorCooldown" });
  const { data: curSlippage } = useReadContract({ ...limitReadBase, functionName: "operatorSlippageBps" });
  const { data: curRebalancePA } = useReadContract({ ...limitReadBase, functionName: "rebalanceWethPerAction" });
  const { data: curRebalancePD } = useReadContract({ ...limitReadBase, functionName: "rebalanceWethPerDay" });
  const { data: curBuyStratPA } = useReadContract({ ...limitReadBase, functionName: "buyStrategicWethPerAction" });
  const { data: curBuyStratPD } = useReadContract({ ...limitReadBase, functionName: "buyStrategicWethPerDay" });

  const toEth = (v: bigint | undefined, dec = 18) => (v ? Number(v) / 10 ** dec : 0);
  const toSec = (v: bigint | undefined) => (v ? Number(v) : 0);

  // Form state — all in human units
  const [buybackWethPA, setBuybackWethPA] = useState("");
  const [buybackWethPD, setBuybackWethPD] = useState("");
  const [buybackUsdcPA, setBuybackUsdcPA] = useState("");
  const [buybackUsdcPD, setBuybackUsdcPD] = useState("");
  const [burnTusdPA, setBurnTusdPA] = useState("");
  const [burnTusdPD, setBurnTusdPD] = useState("");
  const [stakeTusdPA, setStakeTusdPA] = useState("");
  const [stakeTusdPD, setStakeTusdPD] = useState("");
  const [cooldownMin, setCooldownMin] = useState("");
  const [slippageBps, setSlippageBps] = useState("");
  const [rebalancePA, setRebalancePA] = useState("");
  const [rebalancePD, setRebalancePD] = useState("");
  const [buyStratPA, setBuyStratPA] = useState("");
  const [buyStratPD, setBuyStratPD] = useState("");

  const [activeTab, setActiveTab] = useState<"core" | "config" | "rebalance" | "strategic">("core");

  const inputStyle = { background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" };
  const labelStyle = { color: TEXT_MUTED, fontWeight: 600 } as const;

  const LimitInput = ({
    label,
    value,
    onChange,
    current,
    unit,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    current: string;
    unit: string;
  }) => (
    <div>
      <label className="text-xs mb-1 block" style={labelStyle}>
        {label}
      </label>
      <input
        className="w-full rounded-lg px-3 py-2 text-sm font-mono"
        style={inputStyle}
        type="text"
        placeholder={current}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      <p className="text-[10px] mt-0.5" style={{ color: TEXT_DIM }}>
        Current: {current} {unit}
      </p>
    </div>
  );

  const handleCoreLimits = () => {
    const p = (v: string, fb: bigint | undefined, dec = 18) =>
      v ? BigInt(Math.round(Number(v) * 10 ** dec)) : (fb ?? 0n);
    writeContract({
      address: ACTIVE_TREASURY as `0x${string}`,
      abi: treasuryV2Abi,
      functionName: "setCoreOperatorLimits",
      args: [
        p(buybackWethPA, curBuybackWethPA as bigint | undefined),
        p(buybackWethPD, curBuybackWethPD as bigint | undefined),
        p(buybackUsdcPA, curBuybackUsdcPA as bigint | undefined, 6),
        p(buybackUsdcPD, curBuybackUsdcPD as bigint | undefined, 6),
        p(burnTusdPA, curBurnTusdPA as bigint | undefined),
        p(burnTusdPD, curBurnTusdPD as bigint | undefined),
        p(stakeTusdPA, curStakeTusdPA as bigint | undefined),
        p(stakeTusdPD, curStakeTusdPD as bigint | undefined),
      ],
    });
  };

  const handleConfig = () => {
    const cd = cooldownMin ? BigInt(Math.round(Number(cooldownMin) * 60)) : ((curCooldown as bigint) ?? 0n);
    const sl = slippageBps ? BigInt(Math.round(Number(slippageBps))) : ((curSlippage as bigint) ?? 0n);
    writeContract({
      address: ACTIVE_TREASURY as `0x${string}`,
      abi: treasuryV2Abi,
      functionName: "setOperatorConfig",
      args: [cd, sl],
    });
  };

  const handleRebalance = () => {
    const p = (v: string, fb: bigint | undefined) => (v ? BigInt(Math.round(Number(v) * 1e18)) : (fb ?? 0n));
    writeContract({
      address: ACTIVE_TREASURY as `0x${string}`,
      abi: treasuryV2Abi,
      functionName: "setRebalanceLimits",
      args: [
        p(rebalancePA, curRebalancePA as bigint | undefined),
        p(rebalancePD, curRebalancePD as bigint | undefined),
      ],
    });
  };

  const handleBuyStrat = () => {
    const p = (v: string, fb: bigint | undefined) => (v ? BigInt(Math.round(Number(v) * 1e18)) : (fb ?? 0n));
    writeContract({
      address: ACTIVE_TREASURY as `0x${string}`,
      abi: treasuryV2Abi,
      functionName: "setBuyStrategicLimits",
      args: [p(buyStratPA, curBuyStratPA as bigint | undefined), p(buyStratPD, curBuyStratPD as bigint | undefined)],
    });
  };

  const tabs = [
    { id: "core" as const, label: "Core Limits" },
    { id: "config" as const, label: "Cooldown" },
    { id: "rebalance" as const, label: "Rebalance" },
    { id: "strategic" as const, label: "Strategic Buy" },
  ];

  return (
    <div className="rounded-xl p-6" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-5">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => {
              setActiveTab(t.id);
              reset();
            }}
            className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
            style={{
              background: activeTab === t.id ? GOLD : "transparent",
              color: activeTab === t.id ? "#000" : "#888",
              border: activeTab === t.id ? "none" : "1px solid #333",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "core" && (
        <div className="space-y-4">
          <p className="text-xs" style={{ color: TEXT_DIM }}>
            Enter in standard units (e.g. 1.5 WETH, 500 USDC, 10000 ₸USD) — conversion to wei is automatic. Leave blank
            to keep current value.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <LimitInput
              label="Buyback WETH / Action"
              value={buybackWethPA}
              onChange={setBuybackWethPA}
              current={toEth(curBuybackWethPA as bigint | undefined).toString()}
              unit="WETH"
            />
            <LimitInput
              label="Buyback WETH / Day"
              value={buybackWethPD}
              onChange={setBuybackWethPD}
              current={toEth(curBuybackWethPD as bigint | undefined).toString()}
              unit="WETH"
            />
            <LimitInput
              label="Buyback USDC / Action"
              value={buybackUsdcPA}
              onChange={setBuybackUsdcPA}
              current={toEth(curBuybackUsdcPA as bigint | undefined, 6).toString()}
              unit="USDC"
            />
            <LimitInput
              label="Buyback USDC / Day"
              value={buybackUsdcPD}
              onChange={setBuybackUsdcPD}
              current={toEth(curBuybackUsdcPD as bigint | undefined, 6).toString()}
              unit="USDC"
            />
            <LimitInput
              label="Burn ₸USD / Action"
              value={burnTusdPA}
              onChange={setBurnTusdPA}
              current={toEth(curBurnTusdPA as bigint | undefined).toString()}
              unit="₸USD"
            />
            <LimitInput
              label="Burn ₸USD / Day"
              value={burnTusdPD}
              onChange={setBurnTusdPD}
              current={toEth(curBurnTusdPD as bigint | undefined).toString()}
              unit="₸USD"
            />
            <LimitInput
              label="Stake ₸USD / Action"
              value={stakeTusdPA}
              onChange={setStakeTusdPA}
              current={toEth(curStakeTusdPA as bigint | undefined).toString()}
              unit="₸USD"
            />
            <LimitInput
              label="Stake ₸USD / Day"
              value={stakeTusdPD}
              onChange={setStakeTusdPD}
              current={toEth(curStakeTusdPD as bigint | undefined).toString()}
              unit="₸USD"
            />
          </div>
          <button
            onClick={handleCoreLimits}
            disabled={isPending || isConfirming}
            className="w-full py-3 rounded-xl font-bold text-black transition-opacity"
            style={{ background: GOLD, opacity: isPending || isConfirming ? 0.5 : 1 }}
          >
            {isPending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : "Update Core Limits"}
          </button>
        </div>
      )}

      {activeTab === "config" && (
        <div className="space-y-4">
          <p className="text-xs" style={{ color: TEXT_DIM }}>
            Cooldown in minutes between operator actions. Slippage in basis points (100 = 1%, max 1000 = 10%). Leave
            blank to keep current.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <LimitInput
              label="Cooldown (minutes)"
              value={cooldownMin}
              onChange={setCooldownMin}
              current={(toSec(curCooldown as bigint | undefined) / 60).toString()}
              unit="min"
            />
            <LimitInput
              label="Slippage (bps)"
              value={slippageBps}
              onChange={setSlippageBps}
              current={toSec(curSlippage as bigint | undefined).toString()}
              unit="bps"
            />
          </div>
          <button
            onClick={handleConfig}
            disabled={isPending || isConfirming}
            className="w-full py-3 rounded-xl font-bold text-black transition-opacity"
            style={{ background: GOLD, opacity: isPending || isConfirming ? 0.5 : 1 }}
          >
            {isPending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : "Update Operator Config"}
          </button>
        </div>
      )}

      {activeTab === "rebalance" && (
        <div className="space-y-4">
          <p className="text-xs" style={{ color: TEXT_DIM }}>
            WETH limits for rebalanceStrategicToken. Enter in standard units (e.g. 0.5 WETH). Leave blank to keep
            current.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <LimitInput
              label="Rebalance WETH / Action"
              value={rebalancePA}
              onChange={setRebalancePA}
              current={toEth(curRebalancePA as bigint | undefined).toString()}
              unit="WETH"
            />
            <LimitInput
              label="Rebalance WETH / Day"
              value={rebalancePD}
              onChange={setRebalancePD}
              current={toEth(curRebalancePD as bigint | undefined).toString()}
              unit="WETH"
            />
          </div>
          <button
            onClick={handleRebalance}
            disabled={isPending || isConfirming}
            className="w-full py-3 rounded-xl font-bold text-black transition-opacity"
            style={{ background: GOLD, opacity: isPending || isConfirming ? 0.5 : 1 }}
          >
            {isPending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : "Update Rebalance Limits"}
          </button>
        </div>
      )}

      {activeTab === "strategic" && (
        <div className="space-y-4">
          <p className="text-xs" style={{ color: TEXT_DIM }}>
            WETH limits for buyStrategicToken. Enter in standard units (e.g. 0.5 WETH). Leave blank to keep current.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <LimitInput
              label="Buy Strategic WETH / Action"
              value={buyStratPA}
              onChange={setBuyStratPA}
              current={toEth(curBuyStratPA as bigint | undefined).toString()}
              unit="WETH"
            />
            <LimitInput
              label="Buy Strategic WETH / Day"
              value={buyStratPD}
              onChange={setBuyStratPD}
              current={toEth(curBuyStratPD as bigint | undefined).toString()}
              unit="WETH"
            />
          </div>
          <button
            onClick={handleBuyStrat}
            disabled={isPending || isConfirming}
            className="w-full py-3 rounded-xl font-bold text-black transition-opacity"
            style={{ background: GOLD, opacity: isPending || isConfirming ? 0.5 : 1 }}
          >
            {isPending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : "Update Strategic Buy Limits"}
          </button>
        </div>
      )}

      {/* Status */}
      {writeError && (
        <p
          className="text-xs mt-3 px-3 py-2 rounded-lg"
          style={{ background: "#1a0000", border: "1px solid #ff6b6b33", color: "#ff6b6b" }}
        >
          {writeError.message?.slice(0, 200)}
        </p>
      )}
      {isSuccess && (
        <p
          className="text-xs mt-3 px-3 py-2 rounded-lg"
          style={{ background: "#001a0a", border: "1px solid #34eeb633", color: "#34eeb6" }}
        >
          Limits updated successfully!
        </p>
      )}
    </div>
  );
}

// ── AddStrategicToken Panel ──────────────────────────────────────────────
function AddStrategicTokenPanel() {
  const [selected, setSelected] = useState<string>("BNKR");
  const [form, setForm] = useState<StrategicPreset>(STRATEGIC_PRESETS[0]);

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: tokenConfig } = useReadContract({
    address: ACTIVE_TREASURY as `0x${string}`,
    abi: treasuryV2Abi,
    functionName: "strategicTokens",
    args: [form.token as `0x${string}`],
    chainId: base.id,
    query: { enabled: !!form.token && form.token.length === 42, staleTime: STALE_STATIC },
  });
  const isAlreadyAdded = tokenConfig ? tokenConfig[0] === true : false;

  const handleSelect = (ticker: string) => {
    setSelected(ticker);
    reset();
    if (ticker === "CUSTOM") {
      setForm({ ...EMPTY_PRESET });
    } else {
      const preset = STRATEGIC_PRESETS.find(p => p.ticker === ticker);
      if (preset) setForm({ ...preset });
    }
  };

  const handleSubmit = () => {
    if (!form.token || !form.buyPriceUsd || !form.buyMarketCapUsd) return;
    writeContract({
      address: ACTIVE_TREASURY as `0x${string}`,
      abi: treasuryV2Abi,
      functionName: "addStrategicToken",
      args: [
        form.token as `0x${string}`,
        form.isV4,
        (form.isV4 ? ZERO_ADDR : form.v3Pool) as `0x${string}`,
        form.isV4 ? 0 : form.v3Fee,
        (form.isV4 ? form.v4PoolId : ZERO_BYTES32) as `0x${string}`,
        (form.isV4 ? form.v4Currency0 : ZERO_ADDR) as `0x${string}`,
        (form.isV4 ? form.v4Currency1 : ZERO_ADDR) as `0x${string}`,
        form.isV4 ? form.v4Fee : 0,
        form.isV4 ? form.v4TickSpacing : 0,
        (form.isV4 ? form.v4Hooks : ZERO_ADDR) as `0x${string}`,
        parseUnits(form.buyPriceUsd, 18),
        parseUnits(form.buyMarketCapUsd, 18),
      ],
      chainId: base.id,
    });
  };

  const updateField = (key: keyof StrategicPreset, value: string | number | boolean) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="rounded-xl p-6" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      {/* Token selector */}
      <div className="mb-6">
        <label
          className="text-xs font-medium uppercase tracking-wider mb-2 block"
          style={{ color: TEXT_MUTED, fontWeight: 600 }}
        >
          Select Token
        </label>
        <div className="flex flex-wrap gap-2">
          {STRATEGIC_PRESETS.map(p => (
            <button
              key={p.ticker}
              onClick={() => handleSelect(p.ticker)}
              className="btn btn-sm"
              style={{
                background: selected === p.ticker ? GOLD : "transparent",
                border: `1px solid ${selected === p.ticker ? GOLD : "#2a2a2a"}`,
                color: selected === p.ticker ? "#000" : "#888",
              }}
            >
              {p.ticker}
              <span className="text-xs opacity-60 ml-1">{p.isV4 ? "V4" : "V3"}</span>
            </button>
          ))}
          <button
            onClick={() => handleSelect("CUSTOM")}
            className="btn btn-sm"
            style={{
              background: selected === "CUSTOM" ? "#555" : "transparent",
              border: "1px solid #2a2a2a",
              color: selected === "CUSTOM" ? "#fff" : "#888",
            }}
          >
            CUSTOM
          </button>
        </div>
      </div>

      {/* Form fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
            Token Address
          </label>
          <input
            className="input input-bordered w-full font-mono text-sm"
            style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
            value={form.token}
            onChange={e => updateField("token", e.target.value)}
            disabled={selected !== "CUSTOM"}
            placeholder="0x..."
          />
        </div>
        <div>
          <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
            Pool Version
          </label>
          <div className="flex gap-2 mt-1">
            <button
              className="btn btn-sm flex-1"
              style={{
                background: !form.isV4 ? GOLD : "transparent",
                border: `1px solid ${!form.isV4 ? GOLD : "#2a2a2a"}`,
                color: !form.isV4 ? "#000" : "#888",
              }}
              onClick={() => updateField("isV4", false)}
              disabled={selected !== "CUSTOM"}
            >
              V3
            </button>
            <button
              className="btn btn-sm flex-1"
              style={{
                background: form.isV4 ? GOLD : "transparent",
                border: `1px solid ${form.isV4 ? GOLD : "#2a2a2a"}`,
                color: form.isV4 ? "#000" : "#888",
              }}
              onClick={() => updateField("isV4", true)}
              disabled={selected !== "CUSTOM"}
            >
              V4
            </button>
          </div>
        </div>

        {/* V3 fields */}
        {!form.isV4 && (
          <>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V3 Pool Address
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                value={form.v3Pool}
                onChange={e => updateField("v3Pool", e.target.value)}
                disabled={selected !== "CUSTOM"}
                placeholder="0x..."
              />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V3 Fee
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                type="number"
                value={form.v3Fee}
                onChange={e => updateField("v3Fee", Number(e.target.value))}
                disabled={selected !== "CUSTOM"}
              />
            </div>
          </>
        )}

        {/* V4 fields */}
        {form.isV4 && (
          <>
            <div className="md:col-span-2">
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Pool ID
              </label>
              <input
                className="input input-bordered w-full font-mono text-xs"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                value={form.v4PoolId}
                onChange={e => updateField("v4PoolId", e.target.value)}
                disabled={selected !== "CUSTOM"}
                placeholder="0x..."
              />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Currency0
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                value={form.v4Currency0}
                onChange={e => updateField("v4Currency0", e.target.value)}
                disabled={selected !== "CUSTOM"}
              />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Currency1
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                value={form.v4Currency1}
                onChange={e => updateField("v4Currency1", e.target.value)}
                disabled={selected !== "CUSTOM"}
              />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Fee
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                type="number"
                value={form.v4Fee}
                onChange={e => updateField("v4Fee", Number(e.target.value))}
                disabled={selected !== "CUSTOM"}
              />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Tick Spacing
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                type="number"
                value={form.v4TickSpacing}
                onChange={e => updateField("v4TickSpacing", Number(e.target.value))}
                disabled={selected !== "CUSTOM"}
              />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                V4 Hooks
              </label>
              <input
                className="input input-bordered w-full font-mono text-sm"
                style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
                value={form.v4Hooks}
                onChange={e => updateField("v4Hooks", e.target.value)}
                disabled={selected !== "CUSTOM"}
              />
            </div>
          </>
        )}

        <div>
          <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
            Buy Price (USD)
          </label>
          <input
            className="input input-bordered w-full font-mono text-sm"
            style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
            value={form.buyPriceUsd}
            onChange={e => updateField("buyPriceUsd", e.target.value)}
            placeholder="0.001"
          />
        </div>
        <div>
          <label className="text-xs mb-1 block" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
            Buy Market Cap (USD)
          </label>
          <input
            className="input input-bordered w-full font-mono text-sm"
            style={{ background: "#0a0a0a", color: "#e8e8e8", border: "1px solid #2a2a2a" }}
            value={form.buyMarketCapUsd}
            onChange={e => updateField("buyMarketCapUsd", e.target.value)}
            placeholder="1000000"
          />
        </div>
      </div>

      {isAlreadyAdded && (
        <div
          className="rounded-lg p-3 mb-4 text-sm"
          style={{ background: "#1a1500", border: "1px solid #ffcf7233", color: "#ffcf72" }}
        >
          This token is already added to the contract.
        </div>
      )}
      {writeError && (
        <div
          className="rounded-lg p-3 mb-4 text-sm"
          style={{ background: "#1a0000", border: "1px solid #ff6b6b33", color: "#ff6b6b" }}
        >
          {writeError.message?.slice(0, 200)}
        </div>
      )}
      {isSuccess && (
        <div
          className="rounded-lg p-3 mb-4 text-sm"
          style={{ background: "#001a0a", border: "1px solid #34eeb633", color: "#34eeb6" }}
        >
          Token added successfully!{" "}
          {txHash && (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View tx ↗
            </a>
          )}
        </div>
      )}

      <button
        className="btn w-full"
        onClick={handleSubmit}
        style={{ background: GOLD, border: `1px solid ${GOLD}`, color: "#000", fontWeight: 700 }}
        disabled={
          isPending || isConfirming || isAlreadyAdded || !form.token || !form.buyPriceUsd || !form.buyMarketCapUsd
        }
      >
        {isPending
          ? "Confirm in wallet…"
          : isConfirming
            ? "Confirming…"
            : isAlreadyAdded
              ? "Already Added"
              : `Add ${selected !== "CUSTOM" ? selected : "Token"}`}
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────
const Home: NextPage = () => {
  const [opsPage, setOpsPage] = useState(1);
  const [opsPerPage, setOpsPerPage] = useState(10);
  const [opsTypeFilter, setOpsTypeFilter] = useState<Set<string>>(new Set());
  const [opsTokenFilter, setOpsTokenFilter] = useState<Set<string>>(new Set());
  const [opsFilterOpen, setOpsFilterOpen] = useState(false);
  const opsFilterRef = useRef<HTMLDivElement>(null);
  const opsSectionRef = useRef<HTMLDivElement>(null);
  const [opsShowUsd, setOpsShowUsd] = useState(false);

  // Close filter dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (opsFilterRef.current && !opsFilterRef.current.contains(e.target as Node)) {
        setOpsFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const [stratShowUsd, setStratShowUsd] = useState(false);
  const [stratShowBuyPrice, setStratShowBuyPrice] = useState(false);
  const [stratPage, setStratPage] = useState(1);
  const [stratPerPage, setStratPerPage] = useState(10);
  // Sort state: column + direction. null = default (date desc = newest first)
  const [opsSort, setOpsSort] = useState<{ col: "date" | "amount" | "usd"; dir: "asc" | "desc" } | null>(null);
  // Strategic table sort state
  const [stratSort, setStratSort] = useState<{
    col: "amount" | "usd" | "buyprice" | "entry" | "roi";
    dir: "asc" | "desc";
  } | null>(null);
  const { address: connectedAddress } = useAccount();

  // ── Supabase-backed data fetch (replaces all useReadContract hooks) ──
  type ApiData = {
    wethPriceUsd: number;
    tusdPriceUsd: number;
    tusdBalNum: number;
    wethBalNum: number;
    usdcBalNum: number;
    tusdSupplyNum: number;
    tusdBurnedNum: number;
    tusdStakedNum: number;
    pendingTusd: number;
    pendingWeth: number;
    engineBurned: number;
    engineCycles: number;
    engineLastCycleTs: number | null;
    ownerAddr: string | null;
    operatorAddr: string | null;
    strategicRows: {
      ticker: string;
      address: string;
      isV4: boolean;
      balance: number;
      currentPrice: number;
      valueUsd: number;
    }[];
    stratPrices: Record<string, number>;
    stratBalances: Record<string, number>;
    strategicTotalUsd: number;
    totalManagedUsd: number;
    treasuryBurnedTotal: number;
    buybackWethTusd: number;
    buybackUsdcTusd: number;
    totalBuybackTusd: number;
    flywheelData: {
      ticker: string;
      currentMC: number;
      progress: number;
      positionValueUsd: number;
      tusdQuoted: number;
      priceImpactPct: number;
      balance: number;
    }[];
    flywheelTotalTusdQuoted: number;
    flywheelTotalPriceImpactPct: number;
    tusdPoolBalNum: number;
    wethPoolBalNum: number;
    chartData: {
      date: string;
      dateRaw?: string;
      tusd: number;
      weth: number;
      usdc: number;
      strategic: number;
      [key: string]: unknown;
    }[];
    operations: {
      id: number;
      type: string;
      op_type: string;
      amount_raw: string;
      token_address: string;
      weth_price_usd: number;
      token_price_usd: number;
      tx_hash: string;
      block_number: number;
      date_utc: string;
      date_madrid: string;
      comment: string;
      buy_amount: number;
      buy_currency: string;
      sell_amount: number;
      sell_currency: string;
    }[];
  };

  const [apiData, setApiData] = useState<ApiData | null>(null);
  const [apiLoading, setApiLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        const res = await fetch("/api/treasury-data");
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setApiData(data);
          setApiLoading(false);
        }
      } catch (e) {
        console.error("Failed to fetch treasury data:", e);
        if (!cancelled) setApiLoading(false);
      }
    };
    fetchData();
    // Refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Destructure API data with fallbacks
  const wethPriceUsd = apiData?.wethPriceUsd ?? 0;
  const tusdPriceUsd = apiData?.tusdPriceUsd ?? 0;
  const tusdBalNum = apiData?.tusdBalNum ?? 0;
  const wethBalNum = apiData?.wethBalNum ?? 0;
  const usdcBalNum = apiData?.usdcBalNum ?? 0;
  const tusdSupplyNum = apiData?.tusdSupplyNum ?? 0;
  const tusdBurnedNum = apiData?.tusdBurnedNum ?? 0;
  const tusdStakedNum = apiData?.tusdStakedNum ?? 0;
  const pendingTusd = apiData?.pendingTusd ?? 0;
  const pendingWeth = apiData?.pendingWeth ?? 0;
  const engineBurned = apiData?.engineBurned ?? 0;
  const engineCycles = apiData?.engineCycles ?? 0;
  const engineLastCycle = apiData?.engineLastCycleTs ? new Date(apiData.engineLastCycleTs * 1000) : null;
  const ownerAddr = apiData?.ownerAddr ?? null;
  const operatorAddr = apiData?.operatorAddr ?? null;

  const isOwner = !!(
    connectedAddress &&
    ownerAddr &&
    connectedAddress.toLowerCase() === ownerAddr.toLowerCase()
  );

  const isOperator = !!(
    connectedAddress &&
    operatorAddr &&
    connectedAddress.toLowerCase() === operatorAddr.toLowerCase()
  );

  // Prices now come from API (see destructured values above)

  // Balances now come from API (see destructured values above)

  // ── TUSD locked in staking contract (medium — 1min cache) ──
  // ── Computed values from API data ──
  const tusdBalUsd = tusdBalNum * tusdPriceUsd;
  const wethBalUsd = wethBalNum * wethPriceUsd;
  const usdcBalUsd = usdcBalNum;

  const baseManagedUsd = tusdBalUsd + wethBalUsd + usdcBalUsd;
  const burnPct = tusdSupplyNum > 0 ? (tusdBurnedNum / tusdSupplyNum) * 100 : 0;
  const burnUsd = tusdBurnedNum * tusdPriceUsd;

  // Legacy burn from TreasuryManager v1 (not in Supabase)
  const LEGACY_TREASURY_BURNED = 43_147_461;
  const treasuryBurnedTotal = (apiData?.treasuryBurnedTotal ?? 0) + LEGACY_TREASURY_BURNED;
  const externalBurned = Math.max(0, tusdBurnedNum - engineBurned - treasuryBurnedTotal);

  // Legacy buyback from TreasuryManager v1 (not in Supabase, paid with USDC)
  const LEGACY_BUYBACK_USDC_TUSD = 22_024_060;
  const buybackWethTusd = apiData?.buybackWethTusd ?? 0;
  const buybackUsdcTusd = (apiData?.buybackUsdcTusd ?? 0) + LEGACY_BUYBACK_USDC_TUSD;
  const totalBuybackTusd = buybackWethTusd + buybackUsdcTusd;
  const buybackPct = tusdSupplyNum > 0 ? (totalBuybackTusd / tusdSupplyNum) * 100 : 0;
  const buybackUsd = totalBuybackTusd * tusdPriceUsd;

  const totalLockedTusd = tusdBalNum + tusdStakedNum;

  const pendingTusdUsd = pendingTusd * tusdPriceUsd;
  const pendingWethUsd = pendingWeth * wethPriceUsd;
  const pendingTotalUsd = pendingTusdUsd + pendingWethUsd;

  const totalClaimedTusd = HISTORICAL_OPS_RAW.filter(op => op.type === "BurnEngine").reduce(
    (sum, op) => sum + op.tusdAmount,
    0,
  );
  const totalClaimedTusdUsd = totalClaimedTusd * tusdPriceUsd;
  const totalClaimedWeth = 0;

  // ── Strategic token rows from API ──
  type StrategicRow = {
    preset: StrategicPreset;
    balance: number;
    currentPrice: number;
    valueUsd: number;
    roi: number | null;
    computedBuyPrice: number;
    lastOpDate: string;
    lastOpIdx: number;
    firstBuyTxHash: string;
  };

  // Build buy-price data from on-chain operations stored in Supabase
  const onChainBuys = useMemo(() => {
    if (!apiData?.operations) return [];
    return apiData.operations
      .filter(op => op.op_type === "StrategicBuy")
      .map(op => ({
        token: (op.token_address || "").toLowerCase(),
        wethSpent: op.sell_amount || 0,
        tokenReceived: op.buy_amount || 0,
        txHash: op.tx_hash || "",
        blockNumber: BigInt(op.block_number || 0),
        date: op.date_utc ? op.date_utc.slice(0, 10) : "",
      }));
  }, [apiData?.operations]);

  const tokenToTicker = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of STRATEGIC_PRESETS) m[p.token.toLowerCase()] = p.ticker;
    return m;
  }, []);

  const buyDataByToken = useMemo(() => {
    const m: Record<
      string,
      {
        totalWeth: number;
        totalTokens: number;
        firstTx: string;
        lastTx: string;
        lastBlockNum: bigint;
        lastDate: string;
        firstDate: string;
      }
    > = {};
    for (const buy of onChainBuys) {
      const key = buy.token;
      if (!m[key]) {
        m[key] = {
          totalWeth: 0,
          totalTokens: 0,
          firstTx: buy.txHash,
          lastTx: buy.txHash,
          lastBlockNum: buy.blockNumber,
          lastDate: buy.date,
          firstDate: buy.date,
        };
      }
      m[key].totalWeth += buy.wethSpent;
      m[key].totalTokens += buy.tokenReceived;
      if (buy.blockNumber > m[key].lastBlockNum) {
        m[key].lastBlockNum = buy.blockNumber;
        m[key].lastTx = buy.txHash;
        m[key].lastDate = buy.date;
      }
      if (buy.blockNumber < (m[key].lastBlockNum ?? buy.blockNumber)) {
        m[key].firstTx = buy.txHash;
        m[key].firstDate = buy.date;
      }
    }
    return m;
  }, [onChainBuys]);

  // Map API strategic rows to the StrategicRow type the rendering expects
  const apiStratRows = apiData?.strategicRows ?? [];
  const strategicRows: StrategicRow[] = useMemo(() => {
    return STRATEGIC_PRESETS.map(preset => {
      const apiRow = apiStratRows.find(r => r.ticker === preset.ticker);
      const balance = apiRow?.balance ?? 0;
      const currentPrice = apiRow?.currentPrice ?? 0;
      const valueUsd = apiRow?.valueUsd ?? 0;

      const bd = buyDataByToken[preset.token.toLowerCase()];
      let buyPrice: number;
      let lastOpDate: string;
      let lastOpIdx: number;
      let firstBuyTxHash: string;
      if (bd && bd.totalTokens > 0) {
        buyPrice = (bd.totalWeth / bd.totalTokens) * wethPriceUsd;
        lastOpIdx = Number(bd.lastBlockNum);
        lastOpDate = bd.firstDate;
        firstBuyTxHash = bd.firstTx;
      } else {
        buyPrice = Number(preset.buyPriceUsd) || 0;
        lastOpDate = preset.entryDate;
        lastOpIdx = -1;
        firstBuyTxHash = preset.entryTxHash;
      }
      const roi = currentPrice > 0 && buyPrice > 0 ? ((currentPrice - buyPrice) / buyPrice) * 100 : null;
      return { preset, balance, currentPrice, valueUsd, roi, computedBuyPrice: buyPrice, lastOpDate, lastOpIdx, firstBuyTxHash };
    })
      .filter(row => row.balance > 0)
      .sort((a, b) => b.lastOpIdx - a.lastOpIdx);
  }, [apiStratRows, buyDataByToken, wethPriceUsd]);

  const hasStrategicTokens = strategicRows.length > 0;
  const strategicTotalUsd = apiData?.strategicTotalUsd ?? strategicRows.reduce((s, r) => s + r.valueUsd, 0);
  const totalManagedUsd = apiData?.totalManagedUsd ?? (baseManagedUsd + strategicTotalUsd);

  // ── Chart data from API (already computed server-side) ──
  type DailySnapshot = {
    date: string;
    dateRaw?: string;
    tusd: number;
    weth: number;
    usdc: number;
    strategic: number;
    [key: `strat_${string}`]: number;
  };

  // Add BurnEngine + Treasury burns to ₸USD in chart (matching Managed Funds logic)
  const burnUsdForChart = (engineBurned + treasuryBurnedTotal) * tusdPriceUsd;
  const chartData: DailySnapshot[] = useMemo(() => {
    const raw = (apiData?.chartData as DailySnapshot[] | undefined) ?? [];
    return raw.map(d => ({ ...d, tusd: d.tusd + burnUsdForChart }));
  }, [apiData?.chartData, burnUsdForChart]);

  // ── Deflation Edge chart ──────────────────────────────────────────────────
  const [deflHidden, setDeflHidden] = useState<Set<string>>(new Set());
  const [deflFilter, setDeflFilter] = useState<"all" | "inflationary" | "fixed" | "deflationary">("all");
  const [deflFilterOpen, setDeflFilterOpen] = useState(false);

  const deflAssets = useMemo(() => [
    { key: "usd", label: "US Dollar (M2)", color: "#888888", category: "inflationary" as const },
    { key: "gold", label: "Gold", color: "#d4a017", category: "inflationary" as const },
    { key: "btc", label: "Bitcoin", color: "#f7931a", category: "fixed" as const },
    { key: "tusd", label: "TurboUSD", color: GOLD, category: "deflationary" as const },
  ], []);

  const deflData = useMemo(() => {
    // Annual supply growth rates (%)
    // USD M2: historical avg ~7%, recent years vary
    const usdRates: Record<number, number> = {
      2016: 7.2, 2017: 5.3, 2018: 3.9, 2019: 6.7, 2020: 25.2,
      2021: 12.8, 2022: -1.3, 2023: -3.5, 2024: 3.5, 2025: 4.5,
      // Projected
      2026: 5.0, 2027: 5.0, 2028: 4.5, 2029: 4.5, 2030: 4.5,
    };
    // Gold: ~1-1.7%
    const goldRates: Record<number, number> = {
      2016: 1.4, 2017: 1.3, 2018: 1.5, 2019: 1.4, 2020: 1.2,
      2021: 1.6, 2022: 1.3, 2023: 1.5, 2024: 1.0, 2025: 1.0,
      2026: 1.2, 2027: 1.1, 2028: 1.0, 2029: 1.0, 2030: 0.9,
    };
    // BTC: halving-dependent
    const btcRates: Record<number, number> = {
      2016: 8.2, 2017: 4.2, 2018: 3.9, 2019: 3.7, 2020: 2.5,
      2021: 1.8, 2022: 1.7, 2023: 1.7, 2024: 0.85, 2025: 0.83,
      2026: 0.8, 2027: 0.8, 2028: 0.4, 2029: 0.4, 2030: 0.4,
    };
    // TurboUSD: launched mid-2025, -1.28% annual burn
    const tusdRates: Record<number, number> = {
      2025: -0.64, // half year
      2026: -1.28, 2027: -1.3, 2028: -1.3, 2029: -1.3, 2030: -1.3,
    };

    const years = Array.from({ length: 15 }, (_, i) => 2016 + i);
    let usdIdx = 100, goldIdx = 100, btcIdx = 100, tusdIdx = 100;
    const PROJ = 2026; // first projected year
    return years.map(y => {
      if (y > 2016) {
        usdIdx *= 1 + (usdRates[y] ?? 5) / 100;
        goldIdx *= 1 + (goldRates[y] ?? 1.2) / 100;
        btcIdx *= 1 + (btcRates[y] ?? 0.5) / 100;
        if (y >= 2025) tusdIdx *= 1 + (tusdRates[y] ?? -1.3) / 100;
      }
      const uV = Math.round(usdIdx * 100) / 100;
      const gV = Math.round(goldIdx * 100) / 100;
      const bV = Math.round(btcIdx * 100) / 100;
      const tV = y >= 2025 ? Math.round(tusdIdx * 100) / 100 : null;
      const isProj = y >= PROJ;
      const isBridge = y === PROJ - 1;
      return {
        year: y.toString(),
        projected: isProj,
        ...((!isProj || isBridge) ? { usd: uV, gold: gV, btc: bV, ...(tV != null ? { tusd: tV } : {}) } : {}),
        ...((isProj || isBridge) ? { usd_p: uV, gold_p: gV, btc_p: bV, ...(tV != null ? { tusd_p: tV } : {}) } : {}),
      };
    });
  }, []);

  const deflFilterLabels: Record<string, string> = {
    all: "All",
    inflationary: "Inflationary",
    fixed: "Fixed Supply",
    deflationary: "Deflationary",
  };

  const visibleDeflAssets = useMemo(() => {
    return deflAssets.filter(a => {
      if (deflHidden.has(a.key)) return false;
      if (deflFilter === "all") return true;
      return a.category === deflFilter;
    });
  }, [deflAssets, deflHidden, deflFilter]);

  // ── Chart controls ───────────────────────────────────────────────────────
  const [chartView, setChartView] = useState<"all" | "strategic">("all");
  const [chartRange, setChartRange] = useState<"7d" | "30d" | "90d" | "max">("max");
  const [chartRangeOpen, setChartRangeOpen] = useState(false);
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());

  const STRAT_COLORS: Record<string, string> = {
    BNKR: "#f97316",
    DRB: "#ef4444",
    Clanker: "#06b6d4",
    KELLY: "#eab308",
    CLAWD: "#ec4899",
    JUNO: "#8b5cf6",
    FELIX: "#10b981",
  };

  const toggleSeries = (key: string) => {
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Filter chart data by time range using actual dates
  const filteredChartData = useMemo(() => {
    if (chartRange === "max" || chartData.length === 0) return chartData;
    const days = chartRange === "7d" ? 7 : chartRange === "30d" ? 30 : 90;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // "YYYY-MM-DD"
    return chartData.filter(d => !d.dateRaw || d.dateRaw >= cutoffStr || d.date === "Today");
  }, [chartData, chartRange]);

  // Legend items based on view mode
  const chartLegendItems = useMemo(() => {
    if (chartView === "all") {
      return [
        { key: "tusd", label: "₸USD", color: "#43e397" },
        { key: "weth", label: "WETH", color: "#8b5cf6" },
        { key: "usdc", label: "USDC", color: "#3b82f6" },
        { key: "strategic", label: "Strategic", color: "#c2660a" },
      ];
    }
    return STRATEGIC_PRESETS.filter(p => strategicRows.some(r => r.preset.ticker === p.ticker && r.balance > 0)).map(
      p => ({
        key: `strat_${p.ticker}`,
        label: p.ticker,
        color: STRAT_COLORS[p.ticker] || "#a78bfa",
      }),
    );
  }, [chartView, strategicRows]);

  const { filtered: filteredOps, allOpsUnfiltered: allOpsForFilter } = useMemo(() => {
    const allOps: Operation[] = HISTORICAL_OPS_RAW.map(op => {
      let usdValue: string;
      if (op.tusdAmount > 0 && tusdPriceUsd > 0) {
        usdValue = fmtUsd(op.tusdAmount * tusdPriceUsd);
      } else {
        usdValue = op.usdValue || "\u2014";
      }
      return {
        type: op.type,
        amount: op.amount,
        token: op.token,
        usdValue,
        date: op.date,
        txHash: op.txHash,
        roiPct: (op as Record<string, unknown>).roiPct as number | undefined,
      };
    });

    // Append operations from Supabase DB (written by AMI 9000 and scanner).
    // The hardcoded HISTORICAL_OPS_RAW above covers legacy entries.
    // DB ops with a tx_hash that matches a hardcoded entry are skipped to avoid duplicates.
    const hardcodedTxHashes = new Set(HISTORICAL_OPS_RAW.map(op => op.txHash));

    if (apiData?.operations) {
      const seenTx = new Set<string>();
      for (const op of apiData.operations) {
        // Skip if already shown via hardcoded entries
        if (op.tx_hash && hardcodedTxHashes.has(op.tx_hash)) continue;
        // Skip Other Fee gas rows (they supplement the main row, not shown separately)
        if (op.type === "Other Fee" && op.sell_currency === "ETH") continue;
        const txKey = `${op.tx_hash || ""}_${op.op_type || ""}_${op.buy_currency || ""}`;
        // For multi-row ops, deduplicate by tx_hash+op_type+buy_currency
        if (op.tx_hash && seenTx.has(txKey)) continue;
        if (op.tx_hash) seenTx.add(txKey);

        const opType = (op.op_type || "Trade") as Operation["type"];
        let amount = op.amount_raw || "";
        let token = "";
        let usdValue = "\u2014";

        if (opType === "StrategicBuy") {
          const ticker = tokenToTicker[(op.token_address || "").toLowerCase()] || (op.buy_currency || "");
          amount = `${fmtFull(op.buy_amount || 0)} ${ticker}`;
          token = ticker;
          const histWeth = op.weth_price_usd || wethPriceUsd;
          usdValue = histWeth > 0 && op.sell_amount ? fmtUsd(op.sell_amount * histWeth) : "\u2014";
        } else if (opType === "Buyback") {
          amount = `${fmtFull(op.buy_amount || 0)} \u20B8USD`;
          token = "\u20B8USD";
          const sellCur = (op.sell_currency || "WETH").toUpperCase();
          if (sellCur === "USDC") {
            usdValue = op.sell_amount ? fmtUsd(op.sell_amount) : "\u2014";
          } else {
            const histWethBB = op.weth_price_usd || wethPriceUsd;
            usdValue = histWethBB > 0 && op.sell_amount ? fmtUsd(op.sell_amount * histWethBB) : "\u2014";
          }
        } else if (opType === "Burn") {
          const tusdAmt = op.sell_amount || 0;
          amount = `${fmtFull(tusdAmt)} \u20B8USD`;
          token = "\u20B8USD";
          const histTusd = op.token_price_usd || tusdPriceUsd;
          usdValue = histTusd > 0 ? fmtUsd(tusdAmt * histTusd) : "\u2014";
        } else if (opType === "Stake") {
          const tusdAmt = op.sell_amount || 0;
          amount = `${fmtFull(tusdAmt)} \u20B8USD`;
          token = "\u20B8USD";
          const histTusd = op.token_price_usd || tusdPriceUsd;
          usdValue = histTusd > 0 ? fmtUsd(tusdAmt * histTusd) : "\u2014";
        } else if (opType === "BurnEngine") {
          const tusdAmt = op.sell_amount || 0;
          amount = `${fmtFull(tusdAmt)} \u20B8USD`;
          token = "\u20B8USD";
          const histTusd = op.token_price_usd || tusdPriceUsd;
          usdValue = histTusd > 0 ? fmtUsd(tusdAmt * histTusd) : "\u2014";
        } else if (opType === "FeeClaim") {
          const cur = op.buy_currency || "";
          const amt = op.buy_amount || 0;
          const displayCur = cur === "TUSD2" ? "\u20B8USD" : cur;
          amount = `${fmtFull(amt)} ${displayCur}`;
          token = "\u20B8USD";
          const price = op.token_price_usd || (cur === "WETH" ? wethPriceUsd : tusdPriceUsd);
          usdValue = amt > 0 && price > 0 ? fmtUsd(amt * price) : "\u2014";
        } else if (opType === "Rebalance") {
          amount = `${fmtFull(op.sell_amount || 0)} ${op.sell_currency || ""}`;
          token = op.buy_currency || "";
          usdValue = "\u2014";
        } else {
          amount = amount || `${op.sell_amount || 0} ${op.sell_currency || ""}`;
          token = op.sell_currency || "";
          usdValue = "\u2014";
        }

        allOps.push({
          type: opType,
          amount,
          token,
          usdValue,
          date: op.date_utc ? op.date_utc.slice(0, 10) : "\u2014",
          txHash: op.tx_hash || "",
        });
      }
    }

    // Default: newest first (reverse chronological)
    allOps.reverse();

    // Save unfiltered list for token dropdown
    const allOpsUnfiltered = [...allOps];

    // Apply type filter (empty set = all types)
    let filtered = opsTypeFilter.size === 0
      ? allOps
      : allOps.filter(op => opsTypeFilter.has(op.type.toLowerCase()));

    // Apply token filter if any tickers are selected
    if (opsTokenFilter.size > 0) {
      filtered = filtered.filter(op => opsTokenFilter.has(op.token));
    }

    // Apply sort if active
    {
      const col = opsSort?.col ?? "date";
      const dir = opsSort?.dir ?? "desc";
      // Sub-sort for same-date ops (fee claim tx produces 4 rows with same date)
      // Desc order (top→bottom): BurnEngine, Buyback, FeeClaim WETH, FeeClaim ₸USD
      const typeRank = (op: Operation): number => {
        if (op.type === "BurnEngine") return 4;
        if (op.type === "Buyback") return 3;
        if (op.type === "FeeClaim" && op.amount.includes("WETH")) return 2;
        if (op.type === "FeeClaim") return 1;
        return 0;
      };
      filtered.sort((a, b) => {
        let cmp = 0;
        if (col === "date") {
          cmp = a.date.localeCompare(b.date);
          if (cmp === 0) cmp = typeRank(a) - typeRank(b);
        } else if (col === "usd") {
          const aVal = parseFloat(a.usdValue.replace(/[^0-9.-]/g, "")) || 0;
          const bVal = parseFloat(b.usdValue.replace(/[^0-9.-]/g, "")) || 0;
          cmp = aVal - bVal;
        } else if (col === "amount") {
          const aVal = parseFloat(a.amount.replace(/[^0-9.-]/g, "")) || 0;
          const bVal = parseFloat(b.amount.replace(/[^0-9.-]/g, "")) || 0;
          cmp = aVal - bVal;
        }
        return dir === "asc" ? cmp : -cmp;
      });
    }

    return { filtered, allOpsUnfiltered };
  }, [
    opsTypeFilter,
    opsTokenFilter,
    tusdPriceUsd,
    wethPriceUsd,
    opsSort,
    apiData?.operations,
    tokenToTicker,
  ]);

  // Sort toggle: click once = desc, click again = asc, click again = reset to default (date desc)
  const toggleSort = (col: "date" | "amount" | "usd") => {
    setOpsSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: "desc" };
      if (prev.dir === "desc") return { col, dir: "asc" };
      return null; // reset to default
    });
  };

  const sortIcon = (col: "date" | "amount" | "usd") => {
    if (!opsSort || opsSort.col !== col) return "↕";
    return opsSort.dir === "desc" ? "↓" : "↑";
  };

  // ── Strategic table sort helpers ──
  type StratSortCol = "amount" | "usd" | "buyprice" | "entry" | "roi";
  const toggleStratSort = (col: StratSortCol) => {
    setStratSort(prev => {
      if (!prev || prev.col !== col) return { col, dir: "desc" as const };
      if (prev.dir === "desc") return { col, dir: "asc" as const };
      return null;
    });
  };
  const stratSortIcon = (col: StratSortCol) => {
    if (!stratSort || stratSort.col !== col) return "↕";
    return stratSort.dir === "desc" ? "↓" : "↑";
  };

  const sortedStrategicRows = useMemo(() => {
    if (!stratSort) return strategicRows; // default: already sorted by most recent op
    const rows = [...strategicRows];
    const { col, dir } = stratSort;
    rows.sort((a, b) => {
      let cmp = 0;
      if (col === "amount") cmp = a.balance - b.balance;
      else if (col === "usd") cmp = a.valueUsd - b.valueUsd;
      else if (col === "buyprice") cmp = a.computedBuyPrice - b.computedBuyPrice;
      else if (col === "entry") {
        cmp = a.lastOpDate.localeCompare(b.lastOpDate);
        if (cmp === 0) cmp = a.lastOpIdx - b.lastOpIdx;
      } else if (col === "roi") cmp = (a.roi ?? -Infinity) - (b.roi ?? -Infinity);
      return dir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [strategicRows, stratSort]);

  const badgeColor: Record<string, string> = {
    Buyback: "#34eeb6",
    Burn: "#ff6b6b",
    BurnEngine: "#ff6b6b",
    Rebalance: "#5b8dee",
    Stake: "#ffcf72",
    StrategicBuy: "rgb(232, 144, 55)",
    StrategicSell: "#fb923c",
    FeeClaim: "#4ade80",
  };

  return (
    <div className="flex flex-col items-center grow pb-12" style={{ background: "#000", paddingTop: 10 }}>
      {/* Header — hidden on mobile (shown in nav bar), visible on desktop */}
      <div className="hidden sm:block text-center px-4 mb-8">
        <h1 className="text-4xl font-bold mb-1 text-white tracking-tight">₸USD Treasury</h1>
        <p className="text-sm" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
          Operated by AMI · Artificial Monetary Intelligence
        </p>
      </div>

      {/* Hero: Managed Funds */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <div
          className="rounded-2xl p-8 max-w-2xl w-full text-center mx-auto"
          style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
        >
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: GOLD }}>
            Managed Funds
          </p>
          <p className="text-5xl font-bold text-white mt-2">{fmtUsd(totalManagedUsd + (engineBurned + treasuryBurnedTotal) * tusdPriceUsd)}</p>
          <p className="text-xs mt-3" style={{ color: TEXT_DIM }}>
            {fmtUsdShort(totalManagedUsd)} excluding burns
          </p>
        </div>
      </div>

      {/* Main Stats Row */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <div className="grid grid-cols-3 gap-3 sm:gap-4 max-w-2xl mx-auto">
          <StatCard
            title={`\u20B8USD Burned`}
            value={fmtBig(tusdBurnedNum)}
            subtitle={<>{fmtUsdShort(burnUsd)}<br />{fmtPct(burnPct)}</>}
            emoji="🔥"
            tooltip={
              <div style={{ lineHeight: 1.7 }}>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>BurnEngine:</span> {fmtBigRound(engineBurned)} ₸USD</div>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>Treasury:</span> {fmtBigRound(treasuryBurnedTotal)} ₸USD</div>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>External:</span> {fmtBigRound(externalBurned)} ₸USD</div>
              </div>
            }
          />
          <StatCard
            title={`\u20B8USD Bought`}
            value={fmtBig(totalBuybackTusd)}
            subtitle={<>{fmtUsdShort(buybackUsd)}<br />{fmtPct(buybackPct)}</>}
            emoji="🛒"
            tooltip={
              <div style={{ lineHeight: 1.7 }}>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>WETH Buyback:</span> {fmtBigRound(buybackWethTusd)} ₸USD</div>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>USDC Buyback:</span> {fmtBigRound(buybackUsdcTusd)} ₸USD</div>
              </div>
            }
          />
          <StatCard
            title={<><span className="sm:hidden">In Contracts</span><span className="hidden sm:inline">₸USD In Contracts</span></>}
            value={totalLockedTusd > 0 ? fmtBig(totalLockedTusd) : "\u2014"}
            subtitle={
              totalLockedTusd > 0
                ? <>{fmtUsdShort(totalLockedTusd * tusdPriceUsd)}<br />{fmtPct((totalLockedTusd / tusdSupplyNum) * 100)}</>
                : "No locked tokens"
            }
            emoji="🔓"
            tooltip={
              <div style={{ lineHeight: 1.7 }}>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>Staking:</span> {fmtBigRound(tusdStakedNum)} ₸USD</div>
                <div><span style={{ color: "#fff", fontWeight: 600 }}>Treasury:</span> {fmtBigRound(tusdBalNum)} ₸USD</div>
              </div>
            }
          />
        </div>
      </div>

      {/* Zero ₸USD Sold Banner */}
      <div className="max-w-4xl w-full px-4 mb-8 sm:flex sm:justify-center">
        <div
          className="relative rounded-xl overflow-hidden px-5 py-4 flex items-center gap-4 sm:gap-10 w-full sm:max-w-[50%]"
          style={{
            background: "linear-gradient(135deg, #002a10 0%, #00150a 100%)",
            border: "1px solid #0f5a2a",
          }}
        >
          {/* Text */}
          <div className="flex-1 min-w-0">
            <div className="text-xs sm:text-sm" style={{ color: "#2cab6f" }}>
              No function in the contract to sell or withdraw {`\u20B8USD`}. It only locks, buys, and burns it. Fully verifiable onchain.
            </div>
          </div>
          {/* Big zero */}
          <div className="shrink-0 text-right">
            <div className="text-3xl sm:text-4xl font-black" style={{ color: "#43e397", lineHeight: 1 }}>
              0
            </div>
            <div className="text-[10px] sm:text-xs mt-1 whitespace-nowrap" style={{ color: "#fff", fontWeight: 800 }}>
              {`\u20B8USD sold \u00B7 ever`}
            </div>
          </div>
        </div>
      </div>

      {/* Treasury Balances */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>Treasury Balances</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard
            title={`\u20B8USD Balance`}
            value={tusdBalNum > 0 ? `${fmtBig(tusdBalNum)} \u20B8USD` : `0 \u20B8USD`}
            subtitle={tusdBalUsd > 0 ? fmtUsd(tusdBalUsd) : "\u2014"}
          />
          <StatCard
            title="WETH Balance"
            value={wethBalNum > 0 ? `${wethBalNum.toFixed(2)} WETH` : "0 WETH"}
            subtitle={wethBalUsd > 0 ? fmtUsd(wethBalUsd) : "\u2014"}
          />
          <StatCard
            title="USDC Balance"
            value={usdcBalNum > 0 ? `${usdcBalNum < 1000 ? usdcBalNum.toFixed(2) : fmtBig(usdcBalNum)} USDC` : "0 USDC"}
            subtitle={usdcBalUsd > 0 ? fmtUsd(usdcBalUsd) : "\u2014"}
          />
          <StatCard title="Strategic Portfolio" value={fmtUsd(strategicTotalUsd)} subtitle="(Combined token value)" />
        </div>
      </div>

      {/* Strategic Token Balance Table — hidden if no tokens held */}
      {hasStrategicTokens && (
        <div className="max-w-4xl w-full px-4 mb-8">
          <SectionTitle>Strategic Token Balance</SectionTitle>
          <div
            className="rounded-xl overflow-hidden text-xs sm:text-sm"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          >
            <div className="overflow-x-auto">
              <table className="table table-xs sm:table-sm w-full strat-table" style={{ color: "#e8e8e8" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${CARD_BORDER}`, height: "2.0rem" }}>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider"
                      style={{ color: TEXT_MUTED, background: "transparent" }}
                    >
                      Token
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider cursor-pointer select-none"
                      style={{ color: stratSort?.col === "amount" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                      onClick={() => toggleStratSort("amount")}
                    >
                      Amount{" "}
                      <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{stratSortIcon("amount")}</span>
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider hidden sm:table-cell cursor-pointer select-none"
                      style={{ color: stratSort?.col === "usd" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                      onClick={() => toggleStratSort("usd")}
                    >
                      USD Value{" "}
                      <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{stratSortIcon("usd")}</span>
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider hidden sm:table-cell cursor-pointer select-none"
                      style={{ color: stratSort?.col === "buyprice" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                      onClick={() => toggleStratSort("buyprice")}
                    >
                      Buy Price{" "}
                      <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{stratSortIcon("buyprice")}</span>
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider cursor-pointer select-none"
                      style={{ color: stratSort?.col === "entry" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                      onClick={() => toggleStratSort("entry")}
                    >
                      Entry{" "}
                      <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{stratSortIcon("entry")}</span>
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider cursor-pointer select-none"
                      style={{ color: stratSort?.col === "roi" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                      onClick={() => toggleStratSort("roi")}
                    >
                      ROI <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{stratSortIcon("roi")}</span>
                    </th>
                    <th
                      className="text-[10px] sm:text-xs uppercase tracking-wider"
                      style={{ color: TEXT_MUTED, background: "transparent" }}
                    >
                      Tx
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStrategicRows.slice((stratPage - 1) * stratPerPage, stratPage * stratPerPage).map(row => {
                    const roiColor = row.roi === null ? TEXT_DIM : row.roi >= 0 ? "#43e397" : "#ff6b6b";
                    const roiLabel = row.roi === null ? "—" : `${row.roi >= 0 ? "+" : ""}${row.roi.toFixed(0)}%`;
                    const buyPriceFmt =
                      row.computedBuyPrice > 0
                        ? `$${row.computedBuyPrice.toFixed(row.computedBuyPrice >= 1 ? 2 : 7).replace(/\.?0+$/, "")}`
                        : "—";
                    return (
                      <tr key={row.preset.ticker} style={{ borderBottom: `1px solid #111` }}>
                        <td>
                          <span className="font-semibold text-white">{row.preset.ticker}</span>
                        </td>
                        <td className="text-white">
                          {/* Desktop: show amount */}
                          <span className="hidden sm:inline">{fmtBig(row.balance)}</span>
                          {/* Mobile: tap to toggle ALL rows USD */}
                          <span className="sm:hidden cursor-pointer" onClick={() => setStratShowUsd(prev => !prev)}>
                            {stratShowUsd ? (
                              <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                                {row.valueUsd > 0 ? fmtUsd(row.valueUsd) : "—"}
                              </span>
                            ) : (
                              fmtBig(row.balance)
                            )}
                          </span>
                        </td>
                        <td className="hidden sm:table-cell" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                          {row.valueUsd > 0 ? fmtUsd(row.valueUsd) : "—"}
                        </td>
                        <td className="hidden sm:table-cell" style={{ color: TEXT_DIM }}>
                          {buyPriceFmt}
                        </td>
                        <td style={{ color: TEXT_DIM }}>
                          {/* Desktop: show date */}
                          <span className="hidden sm:inline">{row.lastOpDate || "—"}</span>
                          {/* Mobile: tap to toggle ALL rows buy price */}
                          <span
                            className="sm:hidden cursor-pointer"
                            onClick={() => setStratShowBuyPrice(prev => !prev)}
                          >
                            {stratShowBuyPrice ? (
                              <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>{buyPriceFmt}</span>
                            ) : (
                              row.lastOpDate || "—"
                            )}
                          </span>
                        </td>
                        <td>
                          <span style={{ color: roiColor, fontWeight: 600 }}>{roiLabel}</span>
                        </td>
                        <td>
                          <button
                            className="hover:underline"
                            style={{ color: GOLD, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                            onClick={() => {
                              const ticker = row.preset.ticker;
                              setOpsTypeFilter(new Set());
                              setOpsTokenFilter(new Set([ticker]));
                              setOpsPage(1);
                              setTimeout(() => {
                                opsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }, 100);
                            }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {sortedStrategicRows.length > 0 &&
              (() => {
                const totalPages = Math.ceil(sortedStrategicRows.length / stratPerPage);
                return totalPages > 1 ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                    style={{ borderTop: `1px solid ${CARD_BORDER}` }}
                  >
                    <div className="flex items-center gap-1 text-xs" style={{ color: TEXT_DIM }}>
                      <span>Show</span>
                      {[10, 25, 50].map(n => (
                        <button
                          key={n}
                          onClick={() => {
                            setStratPerPage(n);
                            setStratPage(1);
                          }}
                          className="px-1.5 py-0.5 rounded"
                          style={{
                            color: stratPerPage === n ? "#fff" : TEXT_MUTED,
                            background: stratPerPage === n ? "#ffffff15" : "transparent",
                          }}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 text-xs" style={{ color: TEXT_MUTED }}>
                      <span>
                        Page {stratPage} of {totalPages}
                      </span>
                      <button
                        onClick={() => setStratPage(p => Math.max(1, p - 1))}
                        disabled={stratPage <= 1}
                        className="px-2 py-0.5 rounded"
                        style={{ color: stratPage <= 1 ? TEXT_DIM : "#fff", background: "#ffffff10" }}
                      >
                        ‹
                      </button>
                      <button
                        onClick={() => setStratPage(p => Math.min(totalPages, p + 1))}
                        disabled={stratPage >= totalPages}
                        className="px-2 py-0.5 rounded"
                        style={{ color: stratPage >= totalPages ? TEXT_DIM : "#fff", background: "#ffffff10" }}
                      >
                        ›
                      </button>
                    </div>
                  </div>
                ) : null;
              })()}
            <p
              className="sm:hidden px-4 text-[10px]"
              style={{ color: TEXT_DIM, margin: "0.55rem 0", paddingBottom: 0 }}
            >
              Tap amount to see USD value and Entry for purchase price
            </p>
          </div>
        </div>
      )}

      {/* Turbo Flywheel — strategic token progress toward 100M MC */}
      {hasStrategicTokens && (() => {
        // Use API flywheel data (Quoter-simulated) when available, otherwise compute fallback
        const TARGET_MC_FW = 100_000_000;
        const apiFw = apiData?.flywheelData;
        const fwData: { ticker: string; balance: number; currentMC: number; progress: number; positionValueUsd: number; tusdQuoted: number; priceImpactPct: number }[] =
          apiFw && apiFw.length > 0
            ? apiFw
            : strategicRows.map(row => {
                const buyPrice = row.computedBuyPrice;
                const entryMC = Number(row.preset.buyMarketCapUsd) || 0;
                const totalSupply = buyPrice > 0 ? entryMC / buyPrice : 0;
                const currentMC = totalSupply > 0 ? totalSupply * row.currentPrice : 0;
                const progress = currentMC > 0 ? Math.min((currentMC / TARGET_MC_FW) * 100, 100) : 0;
                const positionValueUsd = totalSupply > 0 ? row.balance * (TARGET_MC_FW / totalSupply) : 0;
                const tusdQuoted = tusdPriceUsd > 0 ? positionValueUsd / tusdPriceUsd : 0;
                return { ticker: row.preset.ticker, balance: row.balance, currentMC, progress, positionValueUsd, tusdQuoted, priceImpactPct: 0 };
              });
        if (fwData.length === 0) return null;
        const totalPotentialUsd = fwData.reduce((s, r) => s + r.positionValueUsd, 0);
        // Use single-swap Quoter total (accurate price impact), fallback to sum of individuals
        const totalPotentialTusd = apiData?.flywheelTotalTusdQuoted
          ? apiData.flywheelTotalTusdQuoted
          : fwData.reduce((s, r) => s + r.tusdQuoted, 0);
        const circulatingSupply = tusdSupplyNum - tusdBurnedNum;
        const pctOfSupply = circulatingSupply > 0 ? (totalPotentialTusd / circulatingSupply) * 100 : 0;
        const tusdPoolBal = apiData?.tusdPoolBalNum ?? 0;
        const pctOfPool = tusdPoolBal > 0 ? Math.min((totalPotentialTusd / tusdPoolBal) * 100, 100) : 0;
        const totalPriceImpact = apiData?.flywheelTotalPriceImpactPct ?? 0;

        // Donut chart SVG params
        const donutR = 38, donutStroke = 10;
        const circ = 2 * Math.PI * donutR;
        const filledSupply = circ * Math.min(pctOfSupply, 100) / 100;
        const filledPool = circ * pctOfPool / 100;

        return (
          <div className="max-w-4xl w-full px-4 mb-8">
            <SectionTitle>Turbo Flywheel</SectionTitle>

            {/* Summary hero card */}
            <div
              className="rounded-xl p-4 sm:p-6 mb-4"
              style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
            >
              {/* Subtitle — single line, full width on mobile */}
              <p className="text-[10px] sm:text-xs uppercase tracking-wider mb-3 whitespace-nowrap overflow-hidden text-ellipsis" style={{ color: TEXT_MUTED }}>
                Potential buyback if all tokens reach $100M
              </p>

              {/* Desktop: text left + donuts right, centered */}
              <div className="hidden sm:flex items-center justify-center gap-12">
                {/* Left: value block */}
                <div>
                  <p className="text-3xl font-bold text-white leading-tight">
                    {fmtBigRound(totalPotentialTusd)} ₸USD
                  </p>
                  <p className="text-base" style={{ color: "#fff", lineHeight: 1.3 }}>
                    {fmtUsdShort(totalPotentialUsd)} buyback
                  </p>
                  {totalPriceImpact > 0 && (
                    <p className="text-base font-semibold" style={{ color: GOLD, lineHeight: 1.3 }}>
                      +{Math.round(totalPriceImpact)}% on price
                    </p>
                  )}
                </div>

                {/* Desktop donuts — 140px, spaced */}
                <div className="flex items-center gap-12 flex-shrink-0 ml-6">
                  {/* Donut 1: % of total supply */}
                  <div className="flex flex-col items-center">
                    <div className="relative w-[140px] h-[140px]">
                      <svg viewBox="0 0 96 96" className="w-full h-full" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke="rgb(63,63,63)" strokeWidth={donutStroke} />
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke={GOLD} strokeWidth={donutStroke} strokeDasharray={`${filledSupply} ${circ - filledSupply}`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-sm font-bold text-white">{pctOfSupply.toFixed(1)}%</span>
                      </div>
                    </div>
                    <span className="text-xs mt-1" style={{ color: TEXT_DIM }}>Total supply</span>
                  </div>
                  {/* Donut 2: % of Uniswap pool */}
                  <div className="flex flex-col items-center">
                    <div className="relative w-[140px] h-[140px]">
                      <svg viewBox="0 0 96 96" className="w-full h-full" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke="rgb(63,63,63)" strokeWidth={donutStroke} />
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke={GOLD} strokeWidth={donutStroke} strokeDasharray={`${filledPool} ${circ - filledPool}`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-sm font-bold text-white">{pctOfPool.toFixed(1)}%</span>
                      </div>
                    </div>
                    <span className="text-xs mt-1" style={{ color: TEXT_DIM }}>Uniswap pool</span>
                  </div>
                </div>
              </div>

              {/* Mobile: centered text block + donuts below */}
              <div className="sm:hidden flex flex-col items-center">
                {/* Value row: 10B left, usd+% right vertically centered */}
                <div className="inline-flex items-center gap-4">
                  <p className="font-bold text-white leading-none whitespace-nowrap flex-shrink-0" style={{ fontSize: "30px", margin: 0 }}>
                    {fmtBigRound(totalPotentialTusd)} ₸USD
                  </p>
                  <div className="flex flex-col justify-center flex-shrink-0" style={{ lineHeight: 1.15, gap: 0 }}>
                    <p className="text-sm whitespace-nowrap" style={{ color: "#fff", margin: 0, padding: 0 }}>
                      {fmtUsdShort(totalPotentialUsd)} buyback
                    </p>
                    {totalPriceImpact > 0 && (
                      <p className="text-sm font-semibold whitespace-nowrap" style={{ color: GOLD, margin: 0, padding: 0 }}>
                        +{Math.round(totalPriceImpact)}% on price
                      </p>
                    )}
                  </div>
                </div>
                {/* Donuts centered */}
                <div className="flex justify-center gap-6 mt-4">
                  <div className="flex flex-col items-center">
                    <div className="relative w-[100px] h-[100px]">
                      <svg viewBox="0 0 96 96" className="w-full h-full" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke="rgb(63,63,63)" strokeWidth={donutStroke} />
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke={GOLD} strokeWidth={donutStroke} strokeDasharray={`${filledSupply} ${circ - filledSupply}`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-xs font-bold text-white">{pctOfSupply.toFixed(1)}%</span>
                      </div>
                    </div>
                    <span className="text-[10px] mt-1" style={{ color: TEXT_DIM }}>Total supply</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <div className="relative w-[100px] h-[100px]">
                      <svg viewBox="0 0 96 96" className="w-full h-full" style={{ transform: "rotate(-90deg)" }}>
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke="rgb(63,63,63)" strokeWidth={donutStroke} />
                        <circle cx="48" cy="48" r={donutR} fill="none" stroke={GOLD} strokeWidth={donutStroke} strokeDasharray={`${filledPool} ${circ - filledPool}`} strokeLinecap="round" />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-xs font-bold text-white">{pctOfPool.toFixed(1)}%</span>
                      </div>
                    </div>
                    <span className="text-[10px] mt-1" style={{ color: TEXT_DIM }}>Uniswap pool</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Progress bars — 2 columns */}
            <div className="grid grid-cols-2 gap-3">
              {fwData.map(row => (
                <div
                  key={row.ticker}
                  className="rounded-xl p-3 sm:p-4"
                  style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
                >
                  {/* Row 1: ticker + % to target */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-white">{row.ticker}</span>
                    <span className="text-xs" style={{ color: TEXT_MUTED }}>
                      {row.progress.toFixed(1)}% to $100M
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-3 rounded-full overflow-hidden" style={{ background: "rgb(63,63,63)" }}>
                    <div
                      className="h-full rounded-full transition-all duration-700"
                      style={{ width: `${Math.max(row.progress, 0.5)}%`, background: GOLD }}
                    />
                  </div>
                  {/* Row 2: tusd → price impact */}
                  <div className="flex items-center justify-end mt-2">
                    <span className="text-[10px] sm:text-xs" style={{ color: TEXT_MUTED }}>
                      {fmtBigRound(row.tusdQuoted)} ₸USD{row.priceImpactPct > 0 ? ` → +${Math.round(row.priceImpactPct)}%` : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* The Deflation Edge — supply growth comparison chart */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>The Deflation Edge</SectionTitle>
        <div className="rounded-xl p-4 sm:p-6" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          {/* Top controls: legend left, asset filter right */}
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            {/* Clickable legend */}
            <div className="flex flex-wrap gap-3 text-xs">
              {deflAssets.map(({ key, label, color }) => {
                const hidden = deflHidden.has(key) || (deflFilter !== "all" && deflAssets.find(a => a.key === key)?.category !== deflFilter);
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setDeflHidden(prev => {
                        const next = new Set(prev);
                        next.has(key) ? next.delete(key) : next.add(key);
                        return next;
                      });
                    }}
                    className="flex items-center gap-1.5 transition-opacity"
                    style={{ opacity: hidden ? 0.35 : 1 }}
                  >
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: hidden ? "#555" : color }} />
                    <span style={{ color: hidden ? TEXT_DIM : TEXT_MUTED, textDecoration: hidden ? "line-through" : "none" }}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Asset filter dropdown */}
            <div className="relative">
              <button
                onClick={() => setDeflFilterOpen(prev => !prev)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors"
                style={{ background: "transparent", color: "#fff" }}
              >
                Asset
                <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor"
                  style={{ transform: deflFilterOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>
              {deflFilterOpen && (
                <div className="absolute right-0 mt-1 rounded-lg overflow-hidden z-10" style={{ background: "#1c1c1c", border: "1px solid #333", minWidth: 140 }}>
                  {(["all", "inflationary", "fixed", "deflationary"] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => { setDeflFilter(f); setDeflFilterOpen(false); }}
                      className="block w-full text-left px-3 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        background: deflFilter === f ? "#ffffff10" : "transparent",
                        color: deflFilter === f ? "#fff" : TEXT_MUTED,
                      }}
                    >
                      {deflFilterLabels[f]}
                      <span className="ml-1" style={{ color: TEXT_DIM, fontSize: 10 }}>
                        {f === "inflationary" ? "Gold, USD" : f === "fixed" ? "BTC" : f === "deflationary" ? "₸USD" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Line chart */}
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={deflData}>
              <XAxis
                dataKey="year"
                tick={{ fontSize: 11, fill: "#a6a6a6" }}
                stroke="#1c1c1c"
                interval={1}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#a6a6a6" }}
                stroke="#1c1c1c"
                width={45}
                domain={[92, "auto"]}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const d = payload[0]?.payload as Record<string, any>;
                  return (
                    <div style={{ background: "#0c0c0c", border: "1px solid #1c1c1c", borderRadius: 8, padding: "8px 12px", color: "#e8e8e8", fontSize: 12 }}>
                      <div className="font-semibold mb-1">{d.year}{d.projected ? " (projected)" : ""}</div>
                      {visibleDeflAssets.map(({ key, label, color }) => {
                        const val = d[key] ?? d[`${key}_p`];
                        if (val == null) return null;
                        const change = val - 100;
                        return (
                          <div key={key}>
                            <span style={{ color }}>{label}:</span> {val.toFixed(1)}
                            <span style={{ color: change >= 0 ? TEXT_MUTED : GOLD, marginLeft: 4 }}>
                              ({change >= 0 ? "+" : ""}{change.toFixed(1)}%)
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              {/* Reference line at 100 */}
              <Line
                type="monotone"
                dataKey={() => 100}
                stroke="#333"
                strokeWidth={1}
                strokeDasharray="4 4"
                dot={false}
                isAnimationActive={false}
              />
              {visibleDeflAssets.flatMap(({ key, color }) => [
                <Line
                  key={`${key}-solid`}
                  type="monotone"
                  dataKey={key}
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />,
                <Line
                  key={`${key}-dash`}
                  type="monotone"
                  dataKey={`${key}_p`}
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />,
              ])}
            </LineChart>
          </ResponsiveContainer>

          {/* Annual rate badges */}
          <div className="flex flex-wrap justify-center gap-3 mt-4">
            {deflAssets.filter(a => deflFilter === "all" || a.category === deflFilter).map(({ key, label, color }) => {
              const rate = key === "usd" ? 4.5 : key === "gold" ? 1.0 : key === "btc" ? 0.83 : -1.28;
              return (
                <div key={key} className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full" style={{ border: `1px solid ${color}30`, background: `${color}10` }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                  <span style={{ color: TEXT_MUTED }}>{label.split(" ")[0]}</span>
                  <span className="font-semibold" style={{ color }}>
                    {rate >= 0 ? "+" : ""}{rate}%/yr
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Treasury Composition Chart — stacked area by asset category */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>Treasury Composition Over Time</SectionTitle>
        <div className="rounded-xl p-6" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          {/* Top controls: view toggle left, time range right */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            {/* View toggle */}
            <div className="flex gap-1">
              {(["all", "strategic"] as const).map(v => (
                <button
                  key={v}
                  onClick={() => {
                    setChartView(v);
                    setHiddenSeries(new Set());
                  }}
                  className="px-3 py-1 text-xs font-medium rounded-full transition-colors"
                  style={{
                    background: chartView === v ? "#43e39720" : "transparent",
                    color: chartView === v ? "#43e397" : TEXT_MUTED,
                    border: `1px solid ${chartView === v ? "#43e397" : "#333"}`,
                  }}
                >
                  {v === "all" ? "All Assets" : "Strategic Tokens"}
                </button>
              ))}
            </div>
            {/* Time range dropdown — only for "all" view (strategic has no historical per-token data) */}
            {chartView === "all" && (
              <div className="relative">
                <button
                  onClick={() => setChartRangeOpen(prev => !prev)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors"
                  style={{
                    background: "transparent",
                    color: "#fff",
                  }}
                >
                  {chartRange === "max" ? "Max" : chartRange.toUpperCase()}
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    style={{
                      transform: chartRangeOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                    }}
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
                {chartRangeOpen && (
                  <div
                    className="absolute right-0 mt-1 rounded-lg overflow-hidden z-10"
                    style={{ background: "#1c1c1c", border: "1px solid #333", minWidth: 70 }}
                  >
                    {(["7d", "30d", "90d", "max"] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => {
                          setChartRange(r);
                          setChartRangeOpen(false);
                        }}
                        className="block w-full text-left px-3 py-1.5 text-xs font-medium transition-colors"
                        style={{
                          background: chartRange === r ? "#ffffff10" : "transparent",
                          color: chartRange === r ? "#fff" : TEXT_MUTED,
                        }}
                      >
                        {r === "max" ? "Max" : r.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Clickable legend */}
          <div className="flex flex-wrap gap-4 mb-4 text-xs">
            {chartLegendItems.map(({ key, label, color }) => {
              const hidden = hiddenSeries.has(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleSeries(key)}
                  className="flex items-center gap-1.5 transition-opacity"
                  style={{ opacity: hidden ? 0.35 : 1 }}
                >
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm"
                    style={{ background: hidden ? "#555" : color }}
                  />
                  <span
                    style={{ color: hidden ? TEXT_DIM : TEXT_MUTED, textDecoration: hidden ? "line-through" : "none" }}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          {filteredChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={filteredChartData}>
                <defs>
                  {chartLegendItems.map(({ key, color }) => (
                    <linearGradient key={key} id={`g_${key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.5} />
                      <stop offset="95%" stopColor={color} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "#a6a6a6" }}
                  stroke="#1c1c1c"
                  tickFormatter={(v: string) => {
                    if (v === "Today") return "Today";
                    const parts = v.split("-");
                    if (parts.length === 3) return `${parts[1]}/${parts[2]}/${parts[0].slice(2)}`;
                    return v;
                  }}
                />
                <YAxis
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fontSize: 11, fill: "#a6a6a6" }}
                  stroke="#1c1c1c"
                  width={80}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const d = payload[0]?.payload as DailySnapshot;
                    const visibleItems = chartLegendItems.filter(i => !hiddenSeries.has(i.key));
                    const total = visibleItems.reduce(
                      (s, i) => s + ((d[i.key as keyof DailySnapshot] as number) || 0),
                      0,
                    );
                    return (
                      <div
                        style={{
                          background: "#0c0c0c",
                          border: "1px solid #1c1c1c",
                          borderRadius: 8,
                          padding: "8px 12px",
                          color: "#e8e8e8",
                          fontSize: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.25em",
                        }}
                      >
                        <div className="font-semibold">
                          {d.date === "Today"
                            ? "Today"
                            : (() => {
                                const p = d.date.split("-");
                                return p.length === 3 ? `${p[1]}/${p[2]}/${p[0]}` : d.date;
                              })()}
                        </div>
                        <div className="font-bold" style={{ color: "#fff" }}>
                          Total: {fmtUsd(total)}
                        </div>
                        {visibleItems.map(({ key, label, color }) => {
                          const val = (d[key as keyof DailySnapshot] as number) || 0;
                          return val > 0.01 ? (
                            <div key={key}>
                              <span style={{ color }}>{label}:</span> {fmtUsd(val)}
                            </div>
                          ) : null;
                        })}
                      </div>
                    );
                  }}
                />
                {chartLegendItems
                  .filter(i => !hiddenSeries.has(i.key))
                  .map(({ key, color }) => (
                    <Area
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stackId="1"
                      stroke={color}
                      fill={`url(#g_${key})`}
                      strokeWidth={1.5}
                    />
                  ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[280px]" style={{ color: TEXT_DIM }}>
              <p>Loading on-chain data…</p>
            </div>
          )}
        </div>
      </div>

      {/* BurnEngine */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>Burn Engine</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {/* Card 1: Total Burned */}
          <StatCard
            title="Total Burned"
            value={`${fmtBig(engineBurned)} \u20B8USD`}
            subtitle={engineBurned > 0 ? fmtUsd(engineBurned * tusdPriceUsd) : "\u2014"}
          />
          {/* Card 2: Pending Fees */}
          <StatCard
            title="Pending Fees"
            value={pendingTotalUsd > 0.01 ? fmtUsd(pendingTotalUsd) : "$0.00"}
            subtitle={
              pendingTusd > 0 || pendingWeth > 0
                ? `${fmtBig(pendingTusd)} \u20B8USD · ${pendingWeth.toFixed(2)} WETH`
                : "No fees to claim"
            }
          />
          {/* Card 3: Total Claimed */}
          <StatCard
            title="Total Claimed"
            value={totalClaimedTusd > 0 ? fmtUsd(totalClaimedTusdUsd) : "$0.00"}
            subtitle={`${fmtBig(totalClaimedTusd)} \u20B8USD · ${totalClaimedWeth.toFixed(2)} WETH`}
          />
          {/* Card 4: Cycles */}
          <StatCard
            title="Cycles"
            value={`${engineCycles} execution${engineCycles !== 1 ? "s" : ""}`}
            subtitle={engineLastCycle ? `Last: ${engineLastCycle.toISOString().slice(0, 10)}` : "No cycles yet"}
          />
        </div>
      </div>

      {/* Permissionless Fee Burner — below BurnEngine */}
      <LegacyFeeBurnerPanel />

      {/* Operations Table */}
      <div ref={opsSectionRef} className="max-w-4xl w-full px-4 mb-8">
        <div className="flex items-center justify-between" style={{ marginBottom: "-0.5rem" }}>
          <SectionTitle>Treasury Activity</SectionTitle>
          {connectedAddress &&
            apiData &&
            (connectedAddress.toLowerCase() === apiData.ownerAddr?.toLowerCase() ||
              connectedAddress.toLowerCase() === apiData.operatorAddr?.toLowerCase()) && (
              <div className="flex gap-2" style={{ marginTop: "-1rem" }}>
                <button
                  onClick={() => window.open("/api/export-operations-csv", "_blank")}
                  className="btn btn-xs sm:btn-sm"
                  style={{
                    background: "transparent",
                    border: `1px solid ${GOLD}`,
                    color: GOLD,
                  }}
                >
                  Export CSV
                </button>
                <button
                  onClick={() => window.open("/api/export-operations", "_blank")}
                  className="btn btn-xs sm:btn-sm"
                  style={{
                    background: "transparent",
                    border: `1px solid ${GOLD}`,
                    color: GOLD,
                  }}
                >
                  Export Excel
                </button>
              </div>
            )}
        </div>
        <div
          className="rounded-xl text-xs sm:text-sm"
          style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}`, overflow: "visible" }}
        >
          {/* Table */}
          <div className="overflow-x-auto">
            <table className="table table-xs sm:table-sm ops-table" style={{ color: "#e8e8e8" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${CARD_BORDER}`, height: "2.0rem" }}>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider"
                    style={{ color: TEXT_MUTED, background: "transparent" }}
                  >
                    <div ref={opsFilterRef} className="inline-flex items-center gap-1">
                      Type
                      <button
                        onClick={() => setOpsFilterOpen(prev => !prev)}
                        className="inline-flex items-center justify-center"
                        style={{ color: (opsTypeFilter.size > 0 || opsTokenFilter.size > 0) ? GOLD : TEXT_MUTED }}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill={(opsTypeFilter.size > 0 || opsTokenFilter.size > 0) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
                      </button>
                      {opsFilterOpen && (() => {
                        const rect = opsFilterRef.current?.getBoundingClientRect();
                        return (
                          <div
                            className="fixed rounded-lg shadow-xl py-2 px-3"
                            style={{
                              background: "#1a1a1a",
                              border: `1px solid ${CARD_BORDER}`,
                              minWidth: "280px",
                              zIndex: 9999,
                              top: rect ? rect.bottom + 4 : 0,
                              left: rect ? rect.left : 0,
                            }}
                            onClick={e => e.stopPropagation()}
                          >
                          <div className="flex gap-5">
                            {/* Left column: Types */}
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: TEXT_DIM }}>Types</div>
                              {[
                                { v: "all", l: "All Types" },
                                { v: "buyback", l: "Buyback" },
                                { v: "burn", l: "Burn" },
                                { v: "rebalance", l: "Rebalance" },
                                { v: "stake", l: "Stake" },
                                { v: "burnengine", l: "BurnEngine" },
                                { v: "feeclaim", l: "FeeClaim" },
                                { v: "strategicbuy", l: "Str.Buy" },
                                { v: "strategicsell", l: "Str.Sell" },
                              ].map(({ v, l }) => {
                                const isAll = v === "all";
                                const selected = isAll ? opsTypeFilter.size === 0 : opsTypeFilter.has(v);
                                return (
                                  <button
                                    key={v}
                                    onClick={() => {
                                      if (isAll) {
                                        setOpsTypeFilter(new Set());
                                      } else {
                                        setOpsTypeFilter(prev => {
                                          const next = new Set(prev);
                                          if (next.has(v)) next.delete(v);
                                          else next.add(v);
                                          return next;
                                        });
                                      }
                                      setOpsPage(1);
                                    }}
                                    className="w-full text-left py-1 text-xs hover:bg-[#333] flex items-center gap-2 rounded px-1"
                                    style={{ color: selected ? (isAll ? GOLD : "#fff") : "#888" }}
                                  >
                                    <span className="inline-block w-3 h-3 rounded-sm border shrink-0" style={{ borderColor: "#555", background: selected ? GOLD : "transparent" }} />
                                    {l}
                                  </button>
                                );
                              })}
                            </div>
                            {/* Right column: Tokens */}
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: TEXT_DIM }}>Tokens</div>
                              <button
                                onClick={() => { setOpsTokenFilter(new Set()); setOpsPage(1); }}
                                className="w-full text-left py-1 text-xs hover:bg-[#333] flex items-center gap-2 rounded px-1"
                                style={{ color: opsTokenFilter.size === 0 ? GOLD : "#888" }}
                              >
                                <span className="inline-block w-3 h-3 rounded-sm border shrink-0" style={{ borderColor: "#555", background: opsTokenFilter.size === 0 ? GOLD : "transparent" }} />
                                All Tokens
                              </button>
                              {(() => {
                                const tokenSet = new Set<string>();
                                for (const op of allOpsForFilter) {
                                  if (op.token) tokenSet.add(op.token);
                                }
                                tokenSet.delete("");
                                tokenSet.delete("ETH");
                                tokenSet.delete("WETH");
                                tokenSet.delete("USDC");
                                tokenSet.delete("TUSD2");
                                const allTokens = Array.from(tokenSet).sort();
                                return allTokens.map(t => {
                                  const selected = opsTokenFilter.has(t);
                                  return (
                                    <button
                                      key={t}
                                      onClick={() => {
                                        setOpsTokenFilter(prev => {
                                          const next = new Set(prev);
                                          if (next.has(t)) next.delete(t);
                                          else next.add(t);
                                          return next;
                                        });
                                        setOpsPage(1);
                                      }}
                                      className="w-full text-left py-1 text-xs hover:bg-[#333] flex items-center gap-2 rounded px-1"
                                      style={{ color: selected ? "#fff" : "#888" }}
                                    >
                                      <span className="inline-block w-3 h-3 rounded-sm border shrink-0" style={{ borderColor: "#555", background: selected ? GOLD : "transparent" }} />
                                      {t}
                                    </button>
                                  );
                                });
                              })()}
                            </div>
                          </div>
                        </div>
                        );
                      })()}
                    </div>
                  </th>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider cursor-pointer select-none"
                    style={{ color: opsSort?.col === "amount" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                    onClick={() => toggleSort("amount")}
                  >
                    Amount <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{sortIcon("amount")}</span>
                  </th>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider hidden sm:table-cell cursor-pointer select-none"
                    style={{ color: opsSort?.col === "usd" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                    onClick={() => toggleSort("usd")}
                  >
                    USD Value <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{sortIcon("usd")}</span>
                  </th>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider cursor-pointer select-none"
                    style={{ color: opsSort?.col === "date" ? "#fff" : TEXT_MUTED, background: "transparent" }}
                    onClick={() => toggleSort("date")}
                  >
                    Date <span className="text-[8px] sm:text-[10px] ml-0.5 opacity-60">{sortIcon("date")}</span>
                  </th>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider"
                    style={{ color: TEXT_MUTED, background: "transparent" }}
                  >
                    Tx
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredOps.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8" style={{ color: TEXT_DIM }}>
                      No operations found
                    </td>
                  </tr>
                ) : (
                  filteredOps.slice((opsPage - 1) * opsPerPage, opsPage * opsPerPage).map((op, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid #111` }}>
                      <td>
                        <span
                          className="badge badge-xs sm:badge-sm font-mono"
                          style={{
                            background: op.type === "StrategicBuy" ? "rgb(223 119 15 / 36%)" : `${badgeColor[op.type] ?? "#888"}40`,
                            color: badgeColor[op.type] ?? "#888",
                            border: "none",
                            fontSize: "inherit",
                          }}
                        >
                          {op.type === "StrategicBuy" ? "Str.Buy" : op.type === "StrategicSell" ? "Str.Sell" : op.type}
                        </span>
                      </td>
                      <td className="font-mono text-white">
                        {/* Desktop: amount + ROI sub-line for StrategicSell */}
                        <span className="hidden sm:inline">
                          <span>{op.amount}</span>
                          {op.type === "StrategicSell" && op.roiPct !== undefined && (
                            <span
                              className="block text-[10px] mt-0.5 font-semibold"
                              style={{ color: op.roiPct >= 0 ? "#43e397" : "#ff6b6b" }}
                            >
                              {op.roiPct >= 0 ? "+" : ""}
                              {op.roiPct.toFixed(0)}% ROI
                            </span>
                          )}
                        </span>
                        {/* Mobile: tap to toggle between amount and USD */}
                        <span className="sm:hidden cursor-pointer" onClick={() => setOpsShowUsd(prev => !prev)}>
                          {opsShowUsd ? (
                            <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>{op.usdValue || "\u2014"}</span>
                          ) : (
                            <span>
                              {compactAmount(op.amount)}
                              {op.type === "StrategicSell" && op.roiPct !== undefined && (
                                <span
                                  className="block text-[9px] mt-0.5 font-semibold"
                                  style={{ color: op.roiPct >= 0 ? "#43e397" : "#ff6b6b" }}
                                >
                                  {op.roiPct >= 0 ? "+" : ""}
                                  {op.roiPct.toFixed(0)}% ROI
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="hidden sm:table-cell" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                        {op.usdValue}
                      </td>
                      <td style={{ color: TEXT_DIM }}>{op.date}</td>
                      <td>
                        {op.txHash ? (
                          <a
                            href={`https://basescan.org/tx/${op.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                            style={{ color: GOLD }}
                          >
                            View ↗
                          </a>
                        ) : (
                          <span style={{ color: TEXT_DIM }}>{"\u2014"}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {filteredOps.length > 0 &&
            (() => {
              const totalPages = Math.ceil(filteredOps.length / opsPerPage);
              return (
                <div
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                  style={{ borderTop: `1px solid ${CARD_BORDER}` }}
                >
                  <div className="flex items-center gap-1 text-xs" style={{ color: TEXT_DIM }}>
                    <span>Show</span>
                    {[10, 25, 50, 100].map(n => (
                      <button
                        key={n}
                        onClick={() => {
                          setOpsPerPage(n);
                          setOpsPage(1);
                        }}
                        className="px-1.5 py-0.5 rounded"
                        style={{
                          color: opsPerPage === n ? "#fff" : TEXT_MUTED,
                          background: opsPerPage === n ? "#ffffff15" : "transparent",
                        }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 text-xs" style={{ color: TEXT_MUTED }}>
                    <span>
                      Page {opsPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setOpsPage(p => Math.max(1, p - 1))}
                      disabled={opsPage <= 1}
                      className="px-2 py-0.5 rounded"
                      style={{ color: opsPage <= 1 ? TEXT_DIM : "#fff", background: "#ffffff10" }}
                    >
                      ‹
                    </button>
                    <button
                      onClick={() => setOpsPage(p => Math.min(totalPages, p + 1))}
                      disabled={opsPage >= totalPages}
                      className="px-2 py-0.5 rounded"
                      style={{ color: opsPage >= totalPages ? TEXT_DIM : "#fff", background: "#ffffff10" }}
                    >
                      ›
                    </button>
                  </div>
                </div>
              );
            })()}
          <p className="sm:hidden px-4 text-[10px]" style={{ color: TEXT_DIM, marginTop: 0, marginBottom: "0.55rem" }}>
            Tap amount to see USD value
          </p>
        </div>
      </div>

      {/* Owner-only panels */}
      {isOwner && (
        <>
          <CollapsibleSection title="Operator Limits (Owner Only)">
            <OperatorLimitsPanel />
          </CollapsibleSection>
          <CollapsibleSection title="Add Strategic Token (Owner Only)">
            <AddStrategicTokenPanel />
          </CollapsibleSection>
          <OwnerOperationsPanel />
        </>
      )}

      {/* Contracts */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>Contracts and Wallets</SectionTitle>
        <div className="rounded-xl p-6 space-y-3" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          {(
            [
              ["\u20B8USD Token", TUSD],
              ["\u20B8USD/WETH Pool", TUSD_POOL],
              ["Staking", STAKING_CONTRACT],
              ["BurnEngine", BURN_ENGINE],
              ["LegacyFeeClaimer", LEGACY_FEE_CLAIMER],
              ["Treasury Manager", TREASURY_V2],
              ["Owner", ownerAddr || "0x0000000000000000000000000000000000000000"],
              ["Operator", operatorAddr || "0x0000000000000000000000000000000000000000"],
            ] as [string, `0x${string}`][]
          ).map(([label, addr]) => {
            const BASE_NAMES: Record<string, string> = {
              "0x29c3246636977351b7f7238f77a873e62320799d": "turbousd.base.eth",
              "0x2a248b2e5d22507c6b1ade62d92f59ad4516ced4": "ami9000.base.eth",
            };
            const baseName = BASE_NAMES[addr.toLowerCase()] || null;
            return (
              <div key={`${label}-${addr}`} className="flex justify-between items-center">
                <span className="text-sm" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
                  {label}
                </span>
                {baseName ? (
                  <span className="flex items-center gap-1 text-sm">
                    <a
                      href={`https://basescan.org/address/${addr}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm hover:underline"
                      style={{ color: "#fff", fontFamily: "inherit" }}
                    >
                      {baseName}
                    </a>
                    <CopyIconButton address={addr} />
                  </span>
                ) : (
                  <span className="hide-address-avatar text-sm" style={{ fontFamily: "inherit" }}>
                    <Address address={addr} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm space-y-2" style={{ color: TEXT_DIM }}>
        <p>
          <a
            href="https://github.com/TurboUSD/Treasury-Manager"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            style={{ color: TEXT_DIM }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
              <svg height="16" width="16" viewBox="0 0 16 16" fill="white" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Open source on GitHub
            </span>
          </a>
        </p>
        <p>
          <a
            href="https://turbousd.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            style={{ color: GOLD }}
          >
            turbousd.com
          </a>
          {" · ₸USD Treasury · Powered by AMI"}
        </p>
      </div>
    </div>
  );
};

export default Home;

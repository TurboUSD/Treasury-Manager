"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

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
    buyPriceUsd: "0.00001",
    buyMarketCapUsd: "1000000",
    entryDate: "2026-03-18",
    entryTxHash: "",
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
  type: "Buyback" | "Burn" | "Rebalance" | "Stake" | "BurnEngine" | "StrategicBuy" | "StrategicSell";
  amount: string;
  token: string;
  usdValue: string;
  date: string;
  txHash: string;
  // StrategicSell: ROI vs buy price (shown as sub-line under amount)
  roiPct?: number; // e.g. 250 (green) or -30 (red)
};

// Historical ops — USD values for burns are computed dynamically from live price
// StrategicBuy ops carry wethSpent + tokenReceived so buy-price is computed from real execution data
const HISTORICAL_OPS_RAW = [
  {
    type: "Buyback" as const,
    amount: "22,024,060 \u20B8USD",
    token: "WETH",
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
  // StrategicBuy entries are read dynamically from on-chain events (see onChainBuys)
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

/** Compact an amount string like "22,024,060 ₸USD" → "22M ₸USD" for mobile */
function compactAmount(s: string): string {
  const m = s.match(/^([\d,]+)\s*(.*)$/);
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
const CARD_BG = "#0c0c0c";
const CARD_BORDER = "#1c1c1c";
const TEXT_MUTED = "#a8a8a8";
const TEXT_DIM = "#888888";

// ── Components ────────────────────────────────────────────────────────────

function StatCard({ title, value, subtitle }: { title: React.ReactNode; value: string; subtitle?: string }) {
  return (
    <div
      className="rounded-xl p-3 sm:p-5 stat-card-mobile"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
    >
      <h3
        className="text-[10px] sm:text-xs font-medium uppercase tracking-wider"
        style={{ color: TEXT_MUTED, fontWeight: 600 }}
      >
        {title}
      </h3>
      <p className="text-base sm:text-xl font-bold mt-1 text-white">{value}</p>
      {subtitle && (
        <p className="text-[10px] sm:text-xs mt-1" style={{ color: TEXT_DIM }}>
          {subtitle}
        </p>
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
        <div className="text-sm" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p
            className="font-semibold text-xs uppercase tracking-widest"
            style={{ color: TEXT_MUTED, fontWeight: 600, marginBottom: "0.25rem" }}
          >
            How it works
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em", lineHeight: 1.4 }}>
            ↳ Claims Clanker LP fees <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>(WETH + ₸USD)</span> and
            Legacy fees <span style={{ color: TEXT_MUTED, fontWeight: 600 }}>(₸USD)</span>
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em" }}>
            ↳ Swaps WETH → ₸USD
          </p>
          <p className="text-white/80" style={{ paddingLeft: "1.2em", textIndent: "-1.2em" }}>
            ↳ Burns ALL ₸USD to{" "}
            <span className="font-mono text-xs" style={{ color: GOLD }}>
              0xdead
            </span>
          </p>
        </div>

        {/* Right: Claim & Burn card */}
        <div
          className="rounded-lg px-5 py-3 sm:py-5 space-y-3 min-w-[220px] mt-0"
          style={{ background: "#080808", border: `1px solid #1a1a1a`, paddingTop: 3 }}
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">Claim & Burn</p>
            <p className="text-xs" style={{ color: TEXT_DIM }}>
              No owner, no admin, no pause — permissionless hyperstructure
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
  const [opsFilter, setOpsFilter] = useState<string>("all");
  const [opsShowUsd, setOpsShowUsd] = useState(false);
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

  // ── Dynamic owner & operator reads (static — 24h cache) ──
  const { data: ownerAddr } = useReadContract({
    address: ACTIVE_TREASURY as `0x${string}`,
    abi: treasuryV2Abi,
    functionName: "owner",
    chainId: base.id,
    query: { staleTime: STALE_STATIC },
  });
  const { data: operatorAddr } = useReadContract({
    address: ACTIVE_TREASURY as `0x${string}`,
    abi: treasuryV2Abi,
    functionName: "authorizedOperator",
    chainId: base.id,
    query: { staleTime: STALE_STATIC },
  });
  const isOwner = !!(
    connectedAddress &&
    ownerAddr &&
    connectedAddress.toLowerCase() === (ownerAddr as string).toLowerCase()
  );

  // ── Pool prices (slow — 5min cache) ──
  const { data: usdcWethSlot0 } = useReadContract({
    address: USDC_WETH_POOL,
    abi: poolAbi,
    functionName: "slot0",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: tusdPoolSlot0 } = useReadContract({
    address: TUSD_POOL,
    abi: poolAbi,
    functionName: "slot0",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  const wethPriceUsd = usdcWethSlot0 ? calcWethPriceUsd(usdcWethSlot0[0]) : 0;
  const tusdPriceUsd = tusdPoolSlot0 ? calcTusdPriceUsd(tusdPoolSlot0[0], wethPriceUsd) : 0;

  // ── Treasury balances (medium — 1min cache) ──
  const { data: tusdBal } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: wethBal } = useReadContract({
    address: WETH_ADDR,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: usdcBal } = useReadContract({
    address: USDC_ADDR,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });

  // ── TUSD locked in staking contract (medium — 1min cache) ──
  const { data: tusdStakedBal } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [STAKING_CONTRACT],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });

  // ── Supply & burns (slow — 5min cache) ──
  const { data: tusdSupply } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "totalSupply",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: tusdBurned } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [DEAD],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  // ── Burn engine status (slow — 5min cache) ──
  const { data: burnStatus } = useReadContract({
    address: BURN_ENGINE,
    abi: burnEngineAbi,
    functionName: "getStatus",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  // ── Strategic token balances (medium — 1min cache) ──
  const { data: bnkrBal } = useReadContract({
    address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: drbBal } = useReadContract({
    address: "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: clankerBal } = useReadContract({
    address: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: kellyBal } = useReadContract({
    address: "0x50D2280441372486BeecdD328c1854743EBaCb07",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: clawdBal } = useReadContract({
    address: "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: junoBal } = useReadContract({
    address: "0x4E6c9f48f73E54EE5F3AB7e2992B2d733D0d0b07",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });
  const { data: felixBal } = useReadContract({
    address: "0xf30Bf00edd0C22db54C9274B90D2A4C21FC09b07",
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ACTIVE_TREASURY],
    chainId: base.id,
    query: { staleTime: STALE_MED },
  });

  // ── Pending fees (slow — 5min cache) ──
  const { data: legacyTusdPending } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [LEGACY_FEE_SOURCE],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: lpTusdPending } = useReadContract({
    address: TUSD,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [LP_FEE_SOURCE],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: lpWethPending } = useReadContract({
    address: WETH_ADDR,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [LP_FEE_SOURCE],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  // ── V3 strategic token pool prices (3 fixed reads) ──
  const { data: bnkrSlot0 } = useReadContract({
    address: "0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703",
    abi: poolAbi,
    functionName: "slot0",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: drbSlot0 } = useReadContract({
    address: "0x5116773e18A9C7bB03EBB961b38678E45E238923",
    abi: poolAbi,
    functionName: "slot0",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: clankerSlot0 } = useReadContract({
    address: "0xC1a6FBeDAe68E1472DbB91FE29B51F7a0Bd44F97",
    abi: poolAbi,
    functionName: "slot0",
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  // ── V4 strategic token pool prices via StateView.getSlot0(poolId) ──
  const { data: kellySlot0 } = useReadContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: ["0x7EAC33D5641697366EAEC3234147FD98BA25F01ACCA66A51A48BD129FC532145"],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: clawdSlot0 } = useReadContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: ["0x9FD58E73D8047CB14AC540ACD141D3FC1A41FB6252D674B730FAF62FE24AA8CE"],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: junoSlot0 } = useReadContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: ["0x1635213E2B19E459A4132DF40011638B65AE7510A35D6A88C47EBF94912C7F2E"],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });
  const { data: felixSlot0 } = useReadContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: ["0x6E19027912DB90892200A2B08C514921917BC55D7291EC878AA382C193B50084"],
    chainId: base.id,
    query: { staleTime: STALE_SLOW },
  });

  const publicClient = usePublicClient({ chainId: base.id });

  // ── On-chain StrategicBuy events — auto-discovers ALL buys, no manual maintenance ──
  type StrategicBuyEvent = {
    token: string;
    wethSpent: number;
    tokenReceived: number;
    txHash: string;
    blockNumber: bigint;
    date: string;
  };
  const [onChainBuys, setOnChainBuys] = useState<StrategicBuyEvent[]>([]);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    (async () => {
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const now = Math.floor(Date.now() / 1000);
        // Contract was deployed recently — scan from ~60 days back (generous range)
        const fromBlock = currentBlock > 2_600_000n ? currentBlock - 2_600_000n : 0n;

        const logs = await publicClient.getLogs({
          address: ACTIVE_TREASURY as `0x${string}`,
          event: strategicBuyEventAbi,
          fromBlock,
          toBlock: currentBlock,
        });

        if (cancelled) return;
        const buys: StrategicBuyEvent[] = logs.map(l => {
          // Estimate date from block number (~2s blocks on Base)
          const blockDiff = Number(currentBlock - l.blockNumber);
          const ts = now - blockDiff * 2;
          const date = new Date(ts * 1000).toISOString().slice(0, 10);
          return {
            token: (l.args as { token: string }).token.toLowerCase(),
            wethSpent: Number(formatEther((l.args as { wethSpent: bigint }).wethSpent)),
            tokenReceived: Number(formatEther((l.args as { tokenReceived: bigint }).tokenReceived)),
            txHash: l.transactionHash,
            blockNumber: l.blockNumber,
            date,
          };
        });
        setOnChainBuys(buys);
      } catch (e) {
        console.error("Failed to fetch StrategicBuy events:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient]);

  // ── Computed values ──
  const tusdBalNum = tusdBal ? Number(formatEther(tusdBal)) : 0;
  const wethBalNum = wethBal ? Number(formatEther(wethBal)) : 0;
  const usdcBalNum = usdcBal ? Number(formatUnits(usdcBal, 6)) : 0;
  const tusdSupplyNum = tusdSupply ? Number(formatEther(tusdSupply)) : 0;
  const tusdBurnedNum = tusdBurned ? Number(formatEther(tusdBurned)) : 0;
  const tusdStakedNum = tusdStakedBal ? Number(formatEther(tusdStakedBal)) : 0;

  const tusdBalUsd = tusdBalNum * tusdPriceUsd;
  const wethBalUsd = wethBalNum * wethPriceUsd;
  const usdcBalUsd = usdcBalNum;

  // totalManagedUsd includes strategic token holdings (computed after strategicRows below)
  // We define the base first, then add strategic total after it's computed
  const baseManagedUsd = tusdBalUsd + wethBalUsd + usdcBalUsd;

  const burnPct = tusdSupplyNum > 0 ? (tusdBurnedNum / tusdSupplyNum) * 100 : 0;
  const burnUsd = tusdBurnedNum * tusdPriceUsd;

  const totalBuybackTusd = 22_024_060;
  const buybackPct = tusdSupplyNum > 0 ? (totalBuybackTusd / tusdSupplyNum) * 100 : 0;
  const buybackUsd = totalBuybackTusd * tusdPriceUsd;

  // Total ₸USD locked = treasury balance + staking contract balance
  const totalLockedTusd = tusdBalNum + tusdStakedNum;

  const engineBurned = burnStatus ? Number(formatEther(burnStatus[0])) : 0;
  const engineCycles = burnStatus ? Number(burnStatus[2]) : 0;
  const engineLastCycle = burnStatus && burnStatus[1] > 0n ? new Date(Number(burnStatus[1]) * 1000) : null;

  // Pending fees
  const pendingTusd =
    (legacyTusdPending ? Number(formatEther(legacyTusdPending)) : 0) +
    (lpTusdPending ? Number(formatEther(lpTusdPending)) : 0);
  const pendingWeth = lpWethPending ? Number(formatEther(lpWethPending)) : 0;
  const pendingTusdUsd = pendingTusd * tusdPriceUsd;
  const pendingWethUsd = pendingWeth * wethPriceUsd;
  const pendingTotalUsd = pendingTusdUsd + pendingWethUsd;

  // Total claimed via BurnEngine (sum of all BurnEngine entries from HISTORICAL_OPS_RAW)
  const totalClaimedTusd = HISTORICAL_OPS_RAW.filter(op => op.type === "BurnEngine").reduce(
    (sum, op) => sum + op.tusdAmount,
    0,
  );
  const totalClaimedTusdUsd = totalClaimedTusd * tusdPriceUsd;
  // WETH claimed historically — update when tracked in HISTORICAL_OPS_RAW
  const totalClaimedWeth = 0;

  // ── Strategic token computed rows ──
  const bnkrPrice = bnkrSlot0 ? calcV3TokenPriceUsd(bnkrSlot0[0], wethPriceUsd) : 0;
  const drbPrice = drbSlot0 ? calcV3TokenPriceUsd(drbSlot0[0], wethPriceUsd) : 0;
  const clankerPrice = clankerSlot0 ? calcV3TokenPriceUsd(clankerSlot0[0], wethPriceUsd) : 0;
  const kellyPrice = kellySlot0 ? calcV4TokenPriceUsd(kellySlot0[0], wethPriceUsd) : 0;
  const clawdPrice = clawdSlot0 ? calcV4TokenPriceUsd(clawdSlot0[0], wethPriceUsd) : 0;
  const junoPrice = junoSlot0 ? calcV4TokenPriceUsd(junoSlot0[0], wethPriceUsd) : 0;
  const felixPrice = felixSlot0 ? calcV4TokenPriceUsd(felixSlot0[0], wethPriceUsd) : 0;

  type StrategicRow = {
    preset: StrategicPreset;
    balance: number;
    currentPrice: number;
    valueUsd: number;
    roi: number | null;
    /** Buy price USD derived from operations (weighted average if multiple buys) */
    computedBuyPrice: number;
    /** Date of most recent StrategicBuy/StrategicSell operation for this token */
    lastOpDate: string;
    /** Index in HISTORICAL_OPS_RAW of the most recent op (for tie-breaking same-date sort) */
    lastOpIdx: number;
    /** Tx hash of the first buy (for the Tx link) */
    firstBuyTxHash: string;
  };

  // Build buy-price data from on-chain StrategicBuy events — fully automatic, no manual maintenance
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

  const strategicRows: StrategicRow[] = [
    {
      preset: STRATEGIC_PRESETS[0],
      balance: bnkrBal ? Number(formatEther(bnkrBal)) : 0,
      currentPrice: bnkrPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[1],
      balance: drbBal ? Number(formatEther(drbBal)) : 0,
      currentPrice: drbPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[2],
      balance: clankerBal ? Number(formatEther(clankerBal)) : 0,
      currentPrice: clankerPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[3],
      balance: kellyBal ? Number(formatEther(kellyBal)) : 0,
      currentPrice: kellyPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[4],
      balance: clawdBal ? Number(formatEther(clawdBal)) : 0,
      currentPrice: clawdPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[5],
      balance: junoBal ? Number(formatEther(junoBal)) : 0,
      currentPrice: junoPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
    {
      preset: STRATEGIC_PRESETS[6],
      balance: felixBal ? Number(formatEther(felixBal)) : 0,
      currentPrice: felixPrice,
      valueUsd: 0,
      roi: null,
      computedBuyPrice: 0,
      lastOpDate: "",
      lastOpIdx: -1,
      firstBuyTxHash: "",
    },
  ]
    .map(row => {
      const valueUsd = row.balance * row.currentPrice;
      // Compute buy price from operations data (weighted average WETH cost → USD)
      const bd = buyDataByToken[row.preset.token.toLowerCase()];
      let buyPrice: number;
      let lastOpDate: string;
      let lastOpIdx: number;
      let firstBuyTxHash: string;
      if (bd && bd.totalTokens > 0) {
        // Price per token in WETH, then convert to USD with current WETH price
        buyPrice = (bd.totalWeth / bd.totalTokens) * wethPriceUsd;
        // Use block number as ordering key (higher = more recent)
        lastOpIdx = Number(bd.lastBlockNum);
        lastOpDate = bd.firstDate; // date of first buy (entry date)
        firstBuyTxHash = bd.firstTx;
      } else {
        // Fallback to preset if no on-chain events found yet
        buyPrice = Number(row.preset.buyPriceUsd) || 0;
        lastOpDate = row.preset.entryDate;
        lastOpIdx = -1;
        firstBuyTxHash = row.preset.entryTxHash;
      }
      const roi = row.currentPrice > 0 && buyPrice > 0 ? ((row.currentPrice - buyPrice) / buyPrice) * 100 : null;
      return { ...row, valueUsd, roi, computedBuyPrice: buyPrice, lastOpDate, lastOpIdx, firstBuyTxHash };
    })
    .filter(row => row.balance > 0)
    // Sort by most recent operation first (highest block number = most recent)
    .sort((a, b) => b.lastOpIdx - a.lastOpIdx);

  const hasStrategicTokens = strategicRows.length > 0;

  // ── Strategic token price map (for chart USD conversion) ──
  const strategicPriceMap = useMemo(() => {
    const m: Record<string, number> = {};
    m[STRATEGIC_PRESETS[0].token.toLowerCase()] = bnkrPrice;
    m[STRATEGIC_PRESETS[1].token.toLowerCase()] = drbPrice;
    m[STRATEGIC_PRESETS[2].token.toLowerCase()] = clankerPrice;
    m[STRATEGIC_PRESETS[3].token.toLowerCase()] = kellyPrice;
    m[STRATEGIC_PRESETS[4].token.toLowerCase()] = clawdPrice;
    m[STRATEGIC_PRESETS[5].token.toLowerCase()] = junoPrice;
    m[STRATEGIC_PRESETS[6].token.toLowerCase()] = felixPrice;
    return m;
  }, [bnkrPrice, drbPrice, clankerPrice, kellyPrice, clawdPrice, junoPrice, felixPrice]);

  const strategicTotalUsd = strategicRows.reduce((sum, r) => sum + r.valueUsd, 0);
  const totalManagedUsd = baseManagedUsd + strategicTotalUsd;

  // ── Chart data: on-chain Transfer events → stacked daily snapshots ──
  // Historical snapshots are fetched once (async), "Today" is appended reactively from live balances.
  type DailySnapshot = {
    date: string;
    dateRaw?: string;
    tusd: number;
    weth: number;
    usdc: number;
    strategic: number;
    [key: `strat_${string}`]: number;
  };
  const [historicalSnapshots, setHistoricalSnapshots] = useState<DailySnapshot[]>([]);
  const [historyFetched, setHistoryFetched] = useState(false);

  // Reverse lookup: token address → ticker (needed by chart snapshot builder)
  const tokenToTicker = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of STRATEGIC_PRESETS) m[p.token.toLowerCase()] = p.ticker;
    return m;
  }, []);

  // Fetch historical transfer events only once (or when prices/client change)
  useEffect(() => {
    if (!publicClient || wethPriceUsd === 0) return;
    let cancelled = false;

    // Token → category mapping
    const tokenInfo: Record<string, { cat: "tusd" | "weth" | "usdc" | "strategic"; dec: number }> = {};
    tokenInfo[TUSD.toLowerCase()] = { cat: "tusd", dec: 18 };
    tokenInfo[WETH_ADDR.toLowerCase()] = { cat: "weth", dec: 18 };
    tokenInfo[USDC_ADDR.toLowerCase()] = { cat: "usdc", dec: 6 };
    for (const p of STRATEGIC_PRESETS) {
      tokenInfo[p.token.toLowerCase()] = { cat: "strategic", dec: 18 };
    }
    const tokenAddrs = Object.keys(tokenInfo) as `0x${string}`[];

    // All treasury addresses (V1, V2-old, V3-current)
    const treasuries = [TREASURY_V1, TREASURY_V2_OLDEST, TREASURY_V2_OLD, ACTIVE_TREASURY] as const;

    (async () => {
      try {
        const currentBlock = await publicClient.getBlockNumber();
        const now = Math.floor(Date.now() / 1000);
        // ~30 days back on Base (2s blocks)
        const startBlock = currentBlock > 1_300_000n ? currentBlock - 1_300_000n : 0n;

        type LogEntry = { block: bigint; token: string; amount: bigint; dir: 1 | -1 };
        const allLogs: LogEntry[] = [];

        // Core tokens (TUSD, WETH, USDC) — scan all historical treasury addresses
        const coreTokenAddrs = [TUSD, WETH_ADDR, USDC_ADDR].map(a => a.toLowerCase());
        const coreAddrSet = new Set(coreTokenAddrs);
        const coreTokens = tokenAddrs.filter(a => coreAddrSet.has(a.toLowerCase())) as `0x${string}`[];

        // Strategic tokens — only count from the active (current) contract
        const strategicTokens = tokenAddrs.filter(a => !coreAddrSet.has(a.toLowerCase())) as `0x${string}`[];

        for (const tAddr of treasuries) {
          // Decide which token set to query for this treasury
          const tokensForThisTreasury = tAddr === ACTIVE_TREASURY ? tokenAddrs : coreTokens;
          if (tokensForThisTreasury.length === 0) continue;
          try {
            const [inLogs, outLogs] = await Promise.all([
              publicClient.getLogs({
                address: tokensForThisTreasury,
                event: transferEventAbi,
                args: { to: tAddr },
                fromBlock: startBlock,
              }),
              publicClient.getLogs({
                address: tokensForThisTreasury,
                event: transferEventAbi,
                args: { from: tAddr },
                fromBlock: startBlock,
              }),
            ]);
            for (const l of inLogs) {
              if (l.args.value)
                allLogs.push({ block: l.blockNumber, token: l.address.toLowerCase(), amount: l.args.value, dir: 1 });
            }
            for (const l of outLogs) {
              if (l.args.value)
                allLogs.push({ block: l.blockNumber, token: l.address.toLowerCase(), amount: l.args.value, dir: -1 });
            }
          } catch {
            // If one treasury range fails, continue with others
          }
        }
        // Suppress unused variable warning
        void strategicTokens;

        allLogs.sort((a, b) => Number(a.block - b.block));

        // Running per-token balances → daily snapshots
        const running: Record<string, number> = {};
        const dailyMap: Record<string, Record<string, number>> = {};

        for (const log of allLogs) {
          const info = tokenInfo[log.token];
          if (!info) continue;
          const val = Number(log.amount) / 10 ** info.dec;
          running[log.token] = (running[log.token] || 0) + val * log.dir;

          const blockDiff = Number(currentBlock - log.block);
          const ts = now - blockDiff * 2;
          const date = new Date(ts * 1000).toISOString().slice(0, 10);
          dailyMap[date] = { ...running };
        }

        // Convert to chart format
        const dates = Object.keys(dailyMap).sort();
        const snapshots: DailySnapshot[] = dates.map(d => {
          const bals = dailyMap[d];
          let tusd = 0,
            weth = 0,
            usdc = 0,
            strategic = 0;
          const perToken: Record<string, number> = {};
          for (const [addr, bal] of Object.entries(bals)) {
            const info = tokenInfo[addr];
            if (!info) continue;
            const b = Math.max(0, bal);
            if (info.cat === "tusd") tusd += b * tusdPriceUsd;
            else if (info.cat === "weth") weth += b * wethPriceUsd;
            else if (info.cat === "usdc") usdc += b;
            else if (info.cat === "strategic") {
              const usd = b * (strategicPriceMap[addr] || 0);
              strategic += usd;
              const ticker = tokenToTicker[addr] || addr.slice(0, 6);
              perToken[`strat_${ticker}`] = (perToken[`strat_${ticker}`] || 0) + usd;
            }
          }
          return { date: d.slice(5), dateRaw: d, tusd, weth, usdc, strategic, ...perToken } as DailySnapshot;
        });

        if (!cancelled) {
          setHistoricalSnapshots(snapshots);
          setHistoryFetched(true);
        }
      } catch (e) {
        console.error("Chart event fetch failed:", e);
        if (!cancelled) {
          setHistoricalSnapshots([]);
          setHistoryFetched(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, wethPriceUsd, tusdPriceUsd, strategicPriceMap]);

  // Combine historical snapshots with live "Today" data reactively
  // This ensures "Today" always reflects current balances regardless of async fetch timing
  const chartData = useMemo(() => {
    const perToken: Record<string, number> = {};
    for (const r of strategicRows) {
      perToken[`strat_${r.preset.ticker}`] = r.valueUsd;
    }
    const today: DailySnapshot = {
      date: "Today",
      tusd: tusdBalUsd,
      weth: wethBalUsd,
      usdc: usdcBalUsd,
      strategic: strategicTotalUsd,
      ...perToken,
    } as DailySnapshot;
    if (!historyFetched) return [];
    return [...historicalSnapshots, today];
  }, [historicalSnapshots, historyFetched, tusdBalUsd, wethBalUsd, usdcBalUsd, strategicTotalUsd, strategicRows]);

  // ── Chart controls ───────────────────────────────────────────────────────
  const [chartView, setChartView] = useState<"all" | "strategic">("all");
  const [chartRange, setChartRange] = useState<"30d" | "max">("max");
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

  // Filter chart data by time range
  const filteredChartData = useMemo(() => {
    if (chartRange === "max" || chartData.length === 0) return chartData;
    const days = 30;
    // Keep last N entries + "Today"
    const total = chartData.length;
    const start = Math.max(0, total - days - 1);
    return chartData.slice(start);
  }, [chartData, chartRange]);

  // Legend items based on view mode
  const chartLegendItems = useMemo(() => {
    if (chartView === "all") {
      return [
        { key: "tusd", label: "₸USD", color: "#43e397" },
        { key: "weth", label: "WETH", color: "#627eea" },
        { key: "usdc", label: "USDC", color: "#2775ca" },
        { key: "strategic", label: "Strategic", color: "#a78bfa" },
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

  const filteredOps = useMemo(() => {
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

    // Append on-chain StrategicBuy events (auto-discovered, no manual entries needed)
    for (const buy of onChainBuys) {
      const ticker = tokenToTicker[buy.token] || buy.token.slice(0, 6);
      allOps.push({
        type: "StrategicBuy",
        amount: `${fmtBig(buy.tokenReceived)} ${ticker}`,
        token: ticker,
        usdValue: wethPriceUsd > 0 ? fmtUsd(buy.wethSpent * wethPriceUsd) : "\u2014",
        date: buy.date,
        txHash: buy.txHash,
      });
    }

    // Only add a dynamic entry for NEW BurnEngine burns beyond the known historical ones
    const newEngineBurned = engineBurned - KNOWN_ENGINE_BURNED;
    if (newEngineBurned > 0) {
      allOps.push({
        type: "BurnEngine",
        amount: `${fmtBig(newEngineBurned)} \u20B8USD`,
        token: "\u20B8USD",
        usdValue: fmtUsd(newEngineBurned * tusdPriceUsd),
        date: engineLastCycle ? engineLastCycle.toISOString().slice(0, 10) : "\u2014",
        txHash: "",
      });
    }

    // Default: newest first (reverse chronological)
    allOps.reverse();

    const filtered =
      opsFilter === "all" ? allOps : allOps.filter(op => op.type.toLowerCase().includes(opsFilter.toLowerCase()));

    // Apply sort if active
    if (opsSort) {
      const { col, dir } = opsSort;
      filtered.sort((a, b) => {
        let cmp = 0;
        if (col === "date") {
          cmp = a.date.localeCompare(b.date);
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

    return filtered;
  }, [
    opsFilter,
    engineCycles,
    engineBurned,
    tusdPriceUsd,
    wethPriceUsd,
    engineLastCycle,
    opsSort,
    onChainBuys,
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
    StrategicBuy: "#a78bfa",
    StrategicSell: "#fb923c",
  };

  return (
    <div className="flex flex-col items-center grow pt-6 pb-12" style={{ background: "#000" }}>
      {/* Header — hidden on mobile (shown in nav bar), visible on desktop */}
      <div className="hidden sm:block text-center px-4 mb-8">
        <h1 className="text-4xl font-bold mb-1 text-white tracking-tight">₸USD Treasury</h1>
        <p className="text-sm" style={{ color: TEXT_MUTED, fontWeight: 600 }}>
          Operated by AMI · Artificial Monetary Intelligence
        </p>
      </div>
      <div className="sm:hidden mb-4" />

      {/* Hero: Managed Funds */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <div
          className="rounded-2xl p-8 max-w-2xl w-full text-center mx-auto"
          style={{ background: CARD_BG, border: `1px solid ${GOLD}22` }}
        >
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: GOLD }}>
            Managed Funds
          </p>
          <p className="text-5xl font-bold text-white mt-2">{fmtUsd(totalManagedUsd)}</p>
          <p className="text-xs mt-3" style={{ color: TEXT_DIM }}>
            Total USD value of all tokens held in the Treasury contract
          </p>
        </div>
      </div>

      {/* Main Stats Row */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4 max-w-4xl w-full px-4 mb-8">
        <StatCard
          title={`\u20B8USD Burned`}
          value={fmtBig(tusdBurnedNum)}
          subtitle={`${fmtPct(burnPct)} of supply (${fmtUsdShort(burnUsd)})`}
        />
        <StatCard
          title={`\u20B8USD Bought`}
          value={fmtBig(totalBuybackTusd)}
          subtitle={`${fmtPct(buybackPct)} of supply (${fmtUsdShort(buybackUsd)})`}
        />
        <StatCard
          title={`\u20B8USD Locked`}
          value={totalLockedTusd > 0 ? fmtBig(totalLockedTusd) : "\u2014"}
          subtitle={
            totalLockedTusd > 0
              ? `${fmtPct((totalLockedTusd / tusdSupplyNum) * 100)} of supply (${fmtUsdShort(totalLockedTusd * tusdPriceUsd)})`
              : "No locked tokens"
          }
        />
      </div>

      {/* Zero ₸USD Sold Banner */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <div
          className="relative rounded-xl overflow-hidden px-5 py-4 flex items-center gap-4"
          style={{
            background: "linear-gradient(135deg, #002a10 0%, #00150a 100%)",
            border: "1px solid #0f5a2a",
          }}
        >
          {/* No-sell icon */}
          <div className="shrink-0 text-3xl" style={{ lineHeight: 1 }}>
            🚫
          </div>
          {/* Text */}
          <div className="flex-1 min-w-0">
            <div className="font-bold text-sm sm:text-base" style={{ color: "#43e397" }}>
              {`$\u20B8USD Sold: Zero. Never.`}
            </div>
            <div className="text-xs sm:text-sm mt-0.5" style={{ color: "#2cab6f" }}>
              No function in the contract to sell {`\u20B8USD`}. Not disabled, not paused — it doesn{"'"}t exist. Fully
              verifiable onchain.
            </div>
          </div>
          {/* Big zero */}
          <div className="shrink-0 text-right">
            <div className="text-3xl sm:text-4xl font-black" style={{ color: "#ef4444", lineHeight: 1 }}>
              0
            </div>
            <div className="text-[10px] sm:text-xs mt-1 whitespace-nowrap" style={{ color: "#2cab6f" }}>
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
              <table className="table table-xs sm:table-sm w-full" style={{ color: "#e8e8e8" }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${CARD_BORDER}` }}>
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
                        ? `$${row.computedBuyPrice.toFixed(row.computedBuyPrice >= 1 ? 2 : 5).replace(/\.?0+$/, "")}`
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
                          {row.firstBuyTxHash ? (
                            <a
                              href={`https://basescan.org/tx/${row.firstBuyTxHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline"
                              style={{ color: GOLD }}
                            >
                              View ↗
                            </a>
                          ) : (
                            <span style={{ color: TEXT_DIM }}>—</span>
                          )}
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
            <p className="sm:hidden px-4 pb-3 text-[10px]" style={{ color: TEXT_DIM }}>
              Tap amount to see USD value and Entry for purchase price
            </p>
          </div>
        </div>
      )}

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
                  {chartRange === "max" ? "Max" : "30D"}
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
                    {(["30d", "max"] as const).map(r => (
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
                        {r === "max" ? "Max" : "30D"}
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
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#a6a6a6" }} stroke="#1c1c1c" />
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
                          lineHeight: 1.1,
                        }}
                      >
                        <div className="font-semibold">{d.date}</div>
                        <div className="font-bold" style={{ color: GOLD }}>
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
        <SectionTitle>BurnEngine</SectionTitle>
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
            subtitle={engineLastCycle ? `Last: ${engineLastCycle.toLocaleDateString()}` : "No cycles yet"}
          />
        </div>
      </div>

      {/* Permissionless Fee Burner — below BurnEngine */}
      <LegacyFeeBurnerPanel />

      {/* Operations Table */}
      <div className="max-w-4xl w-full px-4 mb-8">
        <SectionTitle>Operations</SectionTitle>
        <div
          className="rounded-xl overflow-hidden text-xs sm:text-sm"
          style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
        >
          {/* Filter bar — horizontal scroll on mobile */}
          <div
            className="flex gap-2 p-3 sm:p-4 overflow-x-auto flex-nowrap"
            style={{ borderBottom: `1px solid ${CARD_BORDER}`, WebkitOverflowScrolling: "touch" }}
          >
            {["all", "buyback", "burn", "rebalance", "stake", "burnengine", "strategicbuy", "strategicsell"].map(f => (
              <button
                key={f}
                onClick={() => {
                  setOpsFilter(f);
                  setOpsPage(1);
                }}
                className="btn btn-xs sm:btn-sm shrink-0"
                style={{
                  background: opsFilter === f ? GOLD : "transparent",
                  border: `1px solid ${opsFilter === f ? GOLD : "#4f4f4f"}`,
                  color: opsFilter === f ? "#000" : "#888",
                  fontSize: "12px",
                }}
              >
                {f === "all"
                  ? "All"
                  : f === "burnengine"
                    ? "BurnEngine"
                    : f === "strategicbuy"
                      ? "Str.Buy"
                      : f === "strategicsell"
                        ? "Str.Sell"
                        : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="table table-xs sm:table-sm" style={{ color: "#e8e8e8" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${CARD_BORDER}` }}>
                  <th
                    className="text-[10px] sm:text-xs uppercase tracking-wider"
                    style={{ color: TEXT_MUTED, background: "transparent" }}
                  >
                    Type
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
                            background: `${badgeColor[op.type] ?? "#888"}40`,
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
          <p className="sm:hidden px-4 pb-3 text-[10px]" style={{ color: TEXT_DIM }}>
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
        <SectionTitle>Contracts</SectionTitle>
        <div className="rounded-xl p-6 space-y-3" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          {(
            [
              ["\u20B8USD Token", TUSD],
              ["\u20B8USD/WETH Pool", TUSD_POOL],
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
                  <span className="flex items-center text-sm">
                    <a
                      href={`https://basescan.org/address/${addr}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm hover:underline"
                      style={{ color: "#fff", fontFamily: "inherit" }}
                    >
                      {baseName}
                    </a>
                    <span className="hide-address-avatar hide-address-text">
                      <Address address={addr} />
                    </span>
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

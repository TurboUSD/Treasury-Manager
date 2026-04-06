# ₸USD Treasury Manager

## Operated by AMI (Artificial Monetary Intelligence)

On-chain treasury management for [₸USD (TurboUSD)](https://www.turbousd.com/) on Base. One-directional token flows: tokens accumulate into the treasury, and ₸USD can only be bought, staked, or burned — never sold. A permissionless fallback guarantees the treasury operates forever, even without the owner.

| Component | Address |
|-----------|---------|
| **TreasuryManager** | [`0xAF8b3FEBA3411430FAc757968Ac1c9FB25b84107`](https://basescan.org/address/0xAF8b3FEBA3411430FAc757968Ac1c9FB25b84107) |
| **BurnEngine** | [`0x022688aDcDc24c648F4efBa76e42CD16BD0863AB`](https://basescan.org/address/0x022688aDcDc24c648F4efBa76e42CD16BD0863AB) |
| **LegacyFeeClaimer** | [`0x2c857A891338fe17D86651B7B78C59c96e274246`](https://basescan.org/address/0x2c857A891338fe17D86651B7B78C59c96e274246) |
| **Chain** | Base (8453) |
| **Dashboard** | [treasury.turbousd.com](https://treasury.turbousd.com) |

---

## Repository Structure

```
├── contracts/           # Solidity smart contracts
│   ├── TreasuryManager.sol
│   ├── BurnEngine.sol
│   ├── interfaces/
│   └── libraries/
├── audits/              # Security audit reports (v2 + v3 PDF)
├── dashboard/           # Next.js frontend (deployable to Vercel)
├── LICENCE
└── README.md
```

---

## Smart Contract

### Core Operations

| Operation | Function | Description |
|-----------|----------|-------------|
| **Buyback (WETH)** | `buybackWETH(uint256)` | WETH → ₸USD via Uniswap V3 |
| **Buyback (USDC)** | `buybackUSDC(uint256)` | USDC → WETH → ₸USD two-hop |
| **Buy Strategic** | `buyStrategicToken(address, uint256)` | WETH → registered ERC20 (independent caps) |
| **Rebalance** | `rebalanceStrategicToken(address, uint256)` | Sell token → WETH, then 75% → ₸USD, 25% → USDC (tax) |
| **Stake / Unstake** | `stakeTUSD` / `unstakeTUSD` | Aerodrome staking |
| **Burn** | `burnTUSD(uint256)` | Send ₸USD to 0xdead |

### Strategic Token Registry

7 registered tokens with dedicated Uniswap V3 and V4 pool routes:

| Ticker | Pool | Entry Price |
|--------|------|-------------|
| BNKR | V3 | $0.00035 |
| DRB | V3 | $0.000089 |
| Clanker | V3 | $25.00 |
| KELLY | V4 | $0.00001 |
| CLAWD | V4 | $0.000028 |
| JUNO | V4 | $0.000008 |
| FELIX | V4 | $0.00001 |

### Security Model

**One-Way Safe** — No `sweep()`, no `rescue()`, no `emergencyWithdraw()`, no `selfdestruct`, no `delegatecall`, no proxy. The only withdrawal path is the 25% USDC tax allocation during rebalances — hardcoded and immutable.

Key safeguards: Ownable2Step, ReentrancyGuard, rolling-window rate limits (0.5 ETH/action, 2 ETH/day), operator cooldown, TWAP circuit breaker, SafeERC20 forceApprove.

If the owner key is compromised, damage is capped at ~2 ETH/day of suboptimal swaps, and 75% of that still becomes ₸USD in the treasury.

### Permissionless Fallback

After 180-day lockout + 14 days of owner/operator inactivity, anyone can trigger rebalances. The treasury keeps buying, burning, and staking ₸USD in perpetuity — no funds can ever be stuck.

---

## Dashboard

Next.js frontend that reads all data directly from Base. No backend, no API, no database.

Features: live prices (V3 + V4 via StateView), treasury balances, strategic portfolio with ROI, stacked composition chart from on-chain Transfer events, BurnEngine stats, permissionless fee burner, owner operations panel.

### Deploy to Vercel

```bash
cd dashboard
npm install
npm run build
```

Or connect the repo to Vercel with root directory set to `dashboard`.

---

## Built With

[Scaffold-ETH 2](https://github.com/scaffold-eth/scaffold-eth-2) · [Foundry](https://book.getfoundry.sh/) · [Uniswap V3 + V4](https://docs.uniswap.org/) · [OpenZeppelin 5.6.1](https://docs.openzeppelin.com/contracts/)

## License

MIT

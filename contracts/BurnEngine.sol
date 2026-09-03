// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IClankerFeeLocker} from "./interfaces/IClankerFeeLocker.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title BurnEngine V2 — Permissionless ₸USD Burn Hyperstructure
/// @notice Claims Clanker LP fees, swaps WETH→₸USD in liquidity-aware chunks, burns all ₸USD to 0xdead
/// @dev No owner, no admin, no pause, no upgrade. Walkaway-safe hyperstructure.
/// @dev Deployed on Base at 0x022688aDcDc24c648F4efBa76e42CD16BD0863AB (source verified on Sourcify).
///      This file mirrors the deployed bytecode's source; keep it in sync with the ABI used by the dashboard.
contract BurnEngineV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────
    IClankerFeeLocker public immutable CLANKER_FEE_LOCKER;
    ISwapRouter02 public immutable UNISWAP_ROUTER;
    IUniswapV3Pool public immutable POOL;
    IERC20 public immutable WETH;
    IERC20 public immutable TUSD;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ─── Constants ────────────────────────────────────────────────
    uint24 public constant POOL_FEE = 10000; // 1% fee tier
    uint256 public constant DEFAULT_SLIPPAGE_BPS = 300; // 3%
    uint256 public constant MIN_SWAP_AMOUNT = 1e15; // 0.001 WETH
    uint256 public constant CHUNK_FACTOR = 10; // swap at most 1/10th of absorbable liquidity

    // ─── Storage ──────────────────────────────────────────────────
    uint256 public totalBurnedAllTime;
    uint256 public lastCycleTimestamp;
    uint256 public cycleCount;

    // ─── Events ───────────────────────────────────────────────────
    event CycleExecuted(
        uint256 wethClaimed,
        uint256 tusdClaimed,
        uint256 wethSwapped,
        uint256 wethRemaining,
        uint256 tusdFromSwap,
        uint256 totalTusdBurned,
        uint256 totalBurnedAllTime,
        uint256 timestamp
    );

    // ─── Errors ───────────────────────────────────────────────────
    error NothingToBurn();
    error InvalidPrice();
    error InvalidSlippage();

    // ─── Constructor ──────────────────────────────────────────────
    constructor(
        address _clankerFeeLocker,
        address _uniswapRouter,
        address _pool,
        address _weth,
        address _tusd
    ) {
        CLANKER_FEE_LOCKER = IClankerFeeLocker(_clankerFeeLocker);
        UNISWAP_ROUTER = ISwapRouter02(_uniswapRouter);
        POOL = IUniswapV3Pool(_pool);
        WETH = IERC20(_weth);
        TUSD = IERC20(_tusd);
    }

    // ─── External ─────────────────────────────────────────────────

    /// @notice Default: auto-chunk + 3% slippage
    function executeFullCycle() external nonReentrant {
        _execute(DEFAULT_SLIPPAGE_BPS);
    }

    /// @notice Emergency override: auto-chunk + caller-defined slippage
    /// @param maxSlippageBps Slippage tolerance in basis points (300 = 3%, 10000 = 100%)
    function executeFullCycle(uint256 maxSlippageBps) external nonReentrant {
        if (maxSlippageBps == 0 || maxSlippageBps > 10000) revert InvalidSlippage();
        _execute(maxSlippageBps);
    }

    // ─── View Functions ───────────────────────────────────────────

    function getStatus()
        external
        view
        returns (
            uint256 _totalBurnedAllTime,
            uint256 _lastCycleTimestamp,
            uint256 _cycleCount,
            uint256 wethBalance,
            uint256 tusdBalance,
            uint256 wethRemaining
        )
    {
        wethBalance = WETH.balanceOf(address(this));
        tusdBalance = TUSD.balanceOf(address(this));
        return (totalBurnedAllTime, lastCycleTimestamp, cycleCount, wethBalance, tusdBalance, wethBalance);
    }

    function getCurrentPrice() external view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        if (sqrtPriceX96 == 0) revert InvalidPrice();
        address token0 = POOL.token0();
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        if (token0 == address(WETH)) {
            return FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
        } else {
            return FullMath.mulDiv(1 << 96, 1 << 96, FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96));
        }
    }

    function getChunkSize() external view returns (uint256) {
        return _calculateChunkSize();
    }

    // ─── Internal ─────────────────────────────────────────────────

    function _execute(uint256 maxSlippageBps) internal {
        // 1. Record balances before
        uint256 wethBefore = WETH.balanceOf(address(this));
        uint256 tusdBefore = TUSD.balanceOf(address(this));

        // 2. Claim fees (try/catch so we don't revert if nothing to claim)
        // Clanker v3.1 fee locker uses claimRewards(address token) — call separately for each token
        try CLANKER_FEE_LOCKER.claimRewards(address(WETH)) {} catch {}
        try CLANKER_FEE_LOCKER.claimRewards(address(TUSD)) {} catch {}

        // 3. Read balances after claim
        uint256 wethBalance = WETH.balanceOf(address(this));
        uint256 tusdBalance = TUSD.balanceOf(address(this));

        uint256 wethClaimed = wethBalance - wethBefore;
        uint256 tusdClaimed = tusdBalance - tusdBefore;

        // 4. Swap WETH → TUSD if enough balance
        uint256 wethSwapped = 0;
        uint256 tusdFromSwap = 0;

        if (wethBalance >= MIN_SWAP_AMOUNT) {
            uint256 safeChunkSize = _calculateChunkSize();
            uint256 chunkSize = wethBalance < safeChunkSize ? wethBalance : safeChunkSize;

            if (chunkSize >= MIN_SWAP_AMOUNT) {
                uint256 minAmountOut = _calculateMinAmountOut(chunkSize, maxSlippageBps);

                WETH.forceApprove(address(UNISWAP_ROUTER), chunkSize);

                uint256 tusdBeforeSwap = TUSD.balanceOf(address(this));

                UNISWAP_ROUTER.exactInputSingle(
                    ISwapRouter02.ExactInputSingleParams({
                        tokenIn: address(WETH),
                        tokenOut: address(TUSD),
                        fee: POOL_FEE,
                        recipient: address(this),
                        amountIn: chunkSize,
                        amountOutMinimum: minAmountOut,
                        sqrtPriceLimitX96: 0
                    })
                );

                wethSwapped = chunkSize;
                tusdFromSwap = TUSD.balanceOf(address(this)) - tusdBeforeSwap;
            }
        }

        // 5. Burn ALL TUSD held by contract
        uint256 totalTusdToBurn = TUSD.balanceOf(address(this));

        if (totalTusdToBurn == 0 && wethSwapped == 0) revert NothingToBurn();

        // 6. Update state (Effects before Interactions — CEI pattern per ethskills/security)
        totalBurnedAllTime += totalTusdToBurn;
        lastCycleTimestamp = block.timestamp;
        cycleCount++;

        uint256 wethRemaining = WETH.balanceOf(address(this));

        // 7. Transfer TUSD to dead address (Interaction — last per CEI)
        if (totalTusdToBurn > 0) {
            TUSD.safeTransfer(DEAD, totalTusdToBurn);
        }

        emit CycleExecuted(
            wethClaimed,
            tusdClaimed,
            wethSwapped,
            wethRemaining,
            tusdFromSwap,
            totalTusdToBurn,
            totalBurnedAllTime,
            block.timestamp
        );
    }

    function _calculateChunkSize() internal view returns (uint256) {
        uint128 activeLiquidity = POOL.liquidity();
        if (activeLiquidity == 0) return 0;

        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();

        address token0 = POOL.token0();
        uint256 absorbable;

        if (token0 == address(WETH)) {
            absorbable = FullMath.mulDiv(uint256(activeLiquidity), 1 << 96, uint256(sqrtPriceX96));
        } else {
            absorbable = FullMath.mulDiv(uint256(activeLiquidity), uint256(sqrtPriceX96), 1 << 96);
        }

        return absorbable / CHUNK_FACTOR;
    }

    function _calculateMinAmountOut(uint256 amountIn, uint256 maxSlippageBps) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        if (sqrtPriceX96 == 0) revert InvalidPrice();
        address token0 = POOL.token0();
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        uint256 expectedOut;
        if (token0 == address(WETH)) {
            // price = sqrtPrice^2 / 2^96 (token1 per token0), WETH is token0
            // expectedOut = amountIn * price = amountIn * sqrtPrice^2 / 2^192
            expectedOut = FullMath.mulDiv(amountIn, FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96), 1 << 96);
        } else {
            // WETH is token1, price = 2^192 / sqrtPrice^2 (token0 per token1... inverted)
            // expectedOut = amountIn * (2^96 / sqrtPrice)^2 = amountIn * 2^192 / sqrtPrice^2
            expectedOut = FullMath.mulDiv(amountIn, 1 << 96, sqrtPrice);
            expectedOut = FullMath.mulDiv(expectedOut, 1 << 96, sqrtPrice);
        }

        return (expectedOut * (10000 - maxSlippageBps)) / 10000;
    }
}

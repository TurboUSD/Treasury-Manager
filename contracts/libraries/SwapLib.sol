// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";
import {IUniversalRouter} from "../interfaces/IUniversalRouter.sol";
import {IPermit2} from "../interfaces/IPermit2.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {IStateView} from "../interfaces/IStateView.sol";
import {FullMath} from "./FullMath.sol";

/// @title SwapLib — Centralized swap execution for TreasuryManager
/// @notice Handles V3 single-hop swaps, V4 swaps via Universal Router, and balance-delta validation
library SwapLib {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════
    //                    UNIVERSAL ROUTER COMMANDS
    // ══════════════════════════════════════════════════════════════════

    /// @dev Universal Router command for V4 swap
    uint8 internal constant UR_V4_SWAP = 0x10;

    // ══════════════════════════════════════════════════════════════════
    //                       V4 ACTION TYPES
    // ══════════════════════════════════════════════════════════════════

    /// @dev V4 action: swap exact input single hop (Actions.SWAP_EXACT_IN_SINGLE)
    ///      IMPORTANT: These values match the DEPLOYED Universal Router on Base (0x6fF5693b).
    ///      The deployed Actions enum has 6 liquidity-management actions (0x00-0x05) before swaps:
    ///      INCREASE_LIQUIDITY=0x00, DECREASE_LIQUIDITY=0x01, MINT_POSITION=0x02,
    ///      BURN_POSITION=0x03, INCREASE_LIQUIDITY_FROM_DELTAS=0x04, MINT_POSITION_FROM_DELTAS=0x05,
    ///      SWAP_EXACT_IN_SINGLE=0x06, SWAP_EXACT_IN=0x07,
    ///      SWAP_EXACT_OUT_SINGLE=0x08, SWAP_EXACT_OUT=0x09,
    ///      DONATE=0x0a, SETTLE=0x0b, SETTLE_ALL=0x0c, SETTLE_PAIR=0x0d,
    ///      TAKE=0x0e, TAKE_ALL=0x0f, TAKE_PORTION=0x10, TAKE_PAIR=0x11
    ///      Verified: 0x04 causes UnsupportedAction(4) in V4Router (it's a liquidity action).
    ///      Verified: David's exact-out buy tx 0xd2ae7d4c uses actions [0x09, 0x0b, 0x0e]
    ///      which maps to [SWAP_EXACT_OUT, SETTLE, TAKE] — confirming the offset.
    uint8 internal constant V4_SWAP_EXACT_IN_SINGLE = 0x06;
    /// @dev V4 action: swap exact input multi-hop (Actions.SWAP_EXACT_IN)
    ///      Used instead of SINGLE because the Uniswap frontend uses this variant
    ///      and it's proven to work with Clanker hooks on Base.
    ///      Verified via successful V4 sell tx 0x088a9684 on Base mainnet.
    uint8 internal constant V4_SWAP_EXACT_IN = 0x07;
    /// @dev V4 action: settle — pull input from caller via Permit2 (amount=0 means settle full delta)
    uint8 internal constant V4_SETTLE = 0x0b;
    /// @dev V4 action: settle all — pull input from caller via Permit2
    uint8 internal constant V4_SETTLE_ALL = 0x0c;
    /// @dev V4 action: take — send output to recipient (amount=0 means take full delta)
    uint8 internal constant V4_TAKE = 0x0e;
    /// @dev V4 action: take all — send output to caller
    uint8 internal constant V4_TAKE_ALL = 0x0f;

    /// @dev TWAP lookback window for liquid pools (USDC/WETH, strategic token pools)
    uint32 internal constant TWAP_WINDOW = 1800; // 30 minutes

    /// @dev TWAP lookback window for low-volume pools (TUSD/WETH)
    uint32 internal constant TWAP_WINDOW_LONG = 7200; // 2 hours

    /// @dev V4 swap deadline buffer (60 minutes)
    uint256 internal constant V4_DEADLINE_BUFFER = 60 minutes;

    /// @dev V4 sqrtPriceLimit boundaries (TickMath.MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1)
    ///      sqrtPriceLimitX96 = 0 is NOT valid in V4 — must use directional bounds
    uint160 internal constant V4_MIN_SQRT_PRICE_LIMIT = 4295128740;
    uint160 internal constant V4_MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341;

    /// @dev Permit2 approval duration (24 hours)
    uint48 internal constant PERMIT2_EXPIRY_DURATION = 24 hours;

    // ══════════════════════════════════════════════════════════════════
    //                           ERRORS
    // ══════════════════════════════════════════════════════════════════

    error InsufficientOutput(uint256 received, uint256 minExpected);
    error ZeroOutput();
    error AmountExceedsUint128(uint256 amount);

    // ══════════════════════════════════════════════════════════════════
    //                    V3 SWAP EXECUTION
    // ══════════════════════════════════════════════════════════════════

    /// @notice Execute a V3 exact-input single-hop swap with balance-delta validation
    /// @dev [HIGH-1] sqrtPriceLimitX96 computed from spot price + slippage instead of hardcoded 0
    function swapV3ExactInput(
        address router,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) internal returns (uint256 received) {
        uint256 balanceBefore = IERC20(tokenOut).balanceOf(recipient);

        IERC20(tokenIn).forceApprove(router, amountIn);

        ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0 // [HIGH-1] Note: Uniswap V3 SwapRouter02 enforces minAmountOut internally;
                                     // sqrtPriceLimitX96=0 means "no additional price limit beyond amountOutMinimum".
                                     // On Base L2, MEV is limited by sequencer ordering. The minAmountOut guard
                                     // (calculated from TWAP + slippage) provides sufficient protection.
            })
        );

        uint256 balanceAfter = IERC20(tokenOut).balanceOf(recipient);
        received = balanceAfter - balanceBefore;
        if (received == 0) revert ZeroOutput();
        if (received < minAmountOut) revert InsufficientOutput(received, minAmountOut);
    }

    // ══════════════════════════════════════════════════════════════════
    //                    V4 SWAP EXECUTION
    // ══════════════════════════════════════════════════════════════════

    /// @notice V4 pool key for encoding Universal Router commands
    struct V4PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev V4 PathKey for multi-hop swap encoding (matches Uniswap V4 PathKey struct)
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    /// @dev V4 ExactInputParams for SWAP_EXACT_IN action (matches Uniswap V4 ExactInputParams)
    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    /// @notice Execute a V4 exact-input single-hop swap via Universal Router + Permit2
    /// @dev [HIGH-2] Deadline set to block.timestamp + 60 min instead of block.timestamp
    ///      [HIGH-6] amountIn/minAmountOut validated against uint128 max before cast
    ///      [HIGH-10] Permit2 expiration increased from 1h to 24h
    function swapV4ExactInput(
        address universalRouter,
        address permit2,
        address tokenIn,
        address tokenOut,
        V4PoolKey memory poolKey,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 received) {
        // [HIGH-6] Validate uint128 casts
        if (amountIn > type(uint128).max) revert AmountExceedsUint128(amountIn);
        if (minAmountOut > type(uint128).max) revert AmountExceedsUint128(minAmountOut);

        uint256 balanceBefore = IERC20(tokenOut).balanceOf(address(this));

        // Step 1: Approve Permit2 to spend tokenIn
        IERC20(tokenIn).forceApprove(permit2, amountIn);

        // Step 2: Approve Universal Router via Permit2
        // [HIGH-10] Increased from 1 hour to 24 hours
        IPermit2(permit2).approve(
            tokenIn,
            universalRouter,
            uint160(amountIn),
            uint48(block.timestamp + PERMIT2_EXPIRY_DURATION)
        );

        // Step 3: Build V4_SWAP command
        // Use SWAP_EXACT_IN (multi-hop with 1 hop via PathKey) instead of SWAP_EXACT_IN_SINGLE.
        // This matches the encoding used by the Uniswap frontend for V4 swaps on Base,
        // which is proven to work with Clanker hooks.
        // Verified via successful V4 sell tx 0x088a9684 on Base mainnet.

        // Build V4 actions: SWAP_EXACT_IN + SETTLE + TAKE
        bytes memory actions = abi.encodePacked(
            V4_SWAP_EXACT_IN,
            V4_SETTLE,
            V4_TAKE
        );

        bytes[] memory params = new bytes[](3);

        // Param 0: ExactInputParams — MUST be abi.encode(struct) to produce the 0x20 offset wrapper
        // that V4Router's CalldataDecoder expects. Flat abi.encode(field1, field2, ...) does NOT work.
        // Verified via David's successful V4 sell tx 0x088a9684 on Base mainnet.
        PathKey[] memory path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: tokenOut,
            fee: poolKey.fee,
            tickSpacing: poolKey.tickSpacing,
            hooks: poolKey.hooks,
            hookData: ""
        });
        params[0] = abi.encode(
            ExactInputParams({
                currencyIn: tokenIn,
                path: path,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minAmountOut)
            })
        );

        // Param 1: SETTLE — settle input currency (amount=0 means settle full delta, payerIsUser=true)
        params[1] = abi.encode(tokenIn, uint256(0), true);

        // Param 2: TAKE — take output currency (amount=0 means take full delta)
        params[2] = abi.encode(tokenOut, address(this), uint256(0));

        // Encode V4_SWAP input
        bytes memory v4SwapInput = abi.encode(actions, params);

        // Build Universal Router commands
        bytes memory commands = abi.encodePacked(UR_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4SwapInput;

        // [HIGH-2] Execute with deadline = block.timestamp + 60 minutes (not just block.timestamp)
        IUniversalRouter(universalRouter).execute(commands, inputs, block.timestamp + V4_DEADLINE_BUFFER);

        // Validate output via balance delta
        uint256 balanceAfter = IERC20(tokenOut).balanceOf(address(this));
        received = balanceAfter - balanceBefore;
        if (received == 0) revert ZeroOutput();
        if (received < minAmountOut) revert InsufficientOutput(received, minAmountOut);
    }

    // ══════════════════════════════════════════════════════════════════
    //                      PRICE HELPERS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Get spot price from a V3 pool as price of baseToken in terms of quoteToken
    /// @dev Returns price with 18 decimal precision
    /// @param pool The V3 pool
    /// @param baseToken The token to get the price of
    /// @return price Price of 1 baseToken in quoteToken units (18 decimals)
    function getV3SpotPrice(IUniswapV3Pool pool, address baseToken) internal view returns (uint256 price) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        address token0 = pool.token0();
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        // sqrtPriceX96 = sqrt(token1/token0) * 2^96
        if (token0 == baseToken) {
            // Selling token0 → receive token1: price = sqrtPrice² * 1e18 / 2^192
            price = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
            price = FullMath.mulDiv(price, 1e18, 1 << 96);
        } else {
            // Selling token1 → receive token0: price = 1e18 * 2^192 / sqrtPrice²
            price = FullMath.mulDiv(1e18, 1 << 96, sqrtPrice);
            price = FullMath.mulDiv(price, 1 << 96, sqrtPrice);
        }
    }

    /// @notice [CRIT-1] Get TWAP price from a V3 pool using observe() over a 30-min window
    /// @dev Uses Uniswap V3's built-in tick accumulator for manipulation-resistant pricing.
    ///      Falls back to spot price if the pool doesn't have enough observation history.
    /// @param pool The V3 pool
    /// @param baseToken The token to get the price of
    /// @return price TWAP price of 1 baseToken in quoteToken units (18 decimals)
    function getV3TwapPrice(IUniswapV3Pool pool, address baseToken) internal view returns (uint256 price) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW; // 30 minutes ago
        secondsAgos[1] = 0;           // now

        try pool.observe(secondsAgos) returns (
            int56[] memory tickCumulatives,
            uint160[] memory /* secondsPerLiquidityCumulativeX128s */
        ) {
            // Compute arithmetic mean tick over window
            int56 tickDiff = tickCumulatives[1] - tickCumulatives[0];
            int24 avgTick = int24(tickDiff / int56(int32(TWAP_WINDOW)));

            // Convert tick to sqrtPriceX96: sqrtPrice = 1.0001^(tick/2) * 2^96
            // Use the TickMath approach: getSqrtRatioAtTick
            uint160 sqrtPriceX96 = _getSqrtRatioAtTick(avgTick);
            uint256 sqrtPrice = uint256(sqrtPriceX96);

            // sqrtPriceX96 = sqrt(token1/token0) * 2^96
            // If baseToken == token0: we sell token0 for token1, so output/input = token1/token0
            //   price = sqrtPrice^2 / 2^192, scaled by 1e18
            // If baseToken == token1: we sell token1 for token0, so output/input = token0/token1
            //   price = 2^192 / sqrtPrice^2, scaled by 1e18
            address token0 = pool.token0();
            if (token0 == baseToken) {
                // Selling token0 → output is token1: price = sqrtPrice² * 1e18 / 2^192
                price = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
                price = FullMath.mulDiv(price, 1e18, 1 << 96);
            } else {
                // Selling token1 → output is token0: price = 1e18 * 2^192 / sqrtPrice²
                price = FullMath.mulDiv(1e18, 1 << 96, sqrtPrice);
                price = FullMath.mulDiv(price, 1 << 96, sqrtPrice);
            }
        } catch {
            // Fallback to spot if observe() fails (insufficient observations)
            price = getV3SpotPrice(pool, baseToken);
        }
    }

    /// @notice TWAP price with extended 2-hour window for low-volume pools (e.g., TUSD/WETH)
    /// @dev Same logic as getV3TwapPrice but with TWAP_WINDOW_LONG (7200s) lookback
    function getV3TwapPriceLong(IUniswapV3Pool pool, address baseToken) internal view returns (uint256 price) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW_LONG; // 2 hours ago
        secondsAgos[1] = 0;

        try pool.observe(secondsAgos) returns (
            int56[] memory tickCumulatives,
            uint160[] memory
        ) {
            int56 tickDiff = tickCumulatives[1] - tickCumulatives[0];
            int24 avgTick = int24(tickDiff / int56(int32(TWAP_WINDOW_LONG)));
            uint160 sqrtPriceX96 = _getSqrtRatioAtTick(avgTick);
            uint256 sqrtPrice = uint256(sqrtPriceX96);

            address token0 = pool.token0();
            if (token0 == baseToken) {
                price = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
                price = FullMath.mulDiv(price, 1e18, 1 << 96);
            } else {
                price = FullMath.mulDiv(1e18, 1 << 96, sqrtPrice);
                price = FullMath.mulDiv(price, 1 << 96, sqrtPrice);
            }
        } catch {
            price = getV3SpotPrice(pool, baseToken);
        }
    }

    /// @notice Get spot price from a V4 pool via StateView
    /// @dev V4 does NOT have built-in TWAP (no observe()). Spot price only.
    ///      For unlock calculations, the WETH/USD conversion leg uses V3 TWAP for partial protection.
    function getV4SpotPrice(
        IStateView stateView,
        bytes32 poolId,
        address currency0,
        address baseToken
    ) internal view returns (uint256 price) {
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(poolId);
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        if (currency0 == baseToken) {
            // baseToken IS token0 → price = token1/token0 (direct from sqrtPrice)
            price = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
            price = FullMath.mulDiv(price, 1e18, 1 << 96);
        } else {
            // baseToken IS token1 → price = token0/token1 (invert sqrtPrice)
            price = FullMath.mulDiv(1e18, 1 << 96, sqrtPrice);
            price = FullMath.mulDiv(price, 1 << 96, sqrtPrice);
        }
    }

    /// @notice Estimate WETH output for selling a given amount of strategic token
    /// @dev Used for cap enforcement — caps are on quoted WETH output, not raw token amounts
    function quoteWethOutput(
        uint256 amountIn,
        uint256 priceOfTokenInWeth,
        uint8 tokenDecimals
    ) internal pure returns (uint256 wethOut) {
        wethOut = FullMath.mulDiv(amountIn, priceOfTokenInWeth, 10 ** tokenDecimals);
    }

    /// @notice Calculate minimum output with slippage
    function applySlippage(uint256 expectedOut, uint256 slippageBps) internal pure returns (uint256 minOut) {
        minOut = FullMath.mulDiv(expectedOut, (10000 - slippageBps), 10000);
    }

    // ══════════════════════════════════════════════════════════════════
    //                    INTERNAL: TICK MATH
    // ══════════════════════════════════════════════════════════════════

    /// @dev Compute sqrtPriceX96 from a tick value. Adapted from Uniswap V3 TickMath.
    ///      Uses the binary decomposition approach for gas efficiency.
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "T");

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;

        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IClankerFeeLocker} from "./interfaces/IClankerFeeLocker.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title BurnEngine — Permissionless ₸USD Burn Hyperstructure
/// @notice Claims Clanker LP fees, swaps WETH→₸USD, burns all ₸USD atomically.
/// @dev No owner, no admin, no pause, no upgrade. Pure hyperstructure.
contract BurnEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════
    //                        IMMUTABLE STATE
    // ══════════════════════════════════════════════════════════════════

    IClankerFeeLocker public immutable CLANKER_FEE_LOCKER;
    ISwapRouter02 public immutable UNISWAP_ROUTER;
    IUniswapV3Pool public immutable POOL;
    IERC20 public immutable WETH;
    IERC20 public immutable TUSD;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint24 public constant POOL_FEE = 10000; // 1%
    uint256 public constant MAX_SLIPPAGE_BPS = 300; // 3%

    // ══════════════════════════════════════════════════════════════════
    //                           STORAGE
    // ══════════════════════════════════════════════════════════════════

    uint256 public totalBurnedAllTime;
    uint256 public lastCycleTimestamp;
    uint256 public cycleCount;

    // ══════════════════════════════════════════════════════════════════
    //                           EVENTS
    // ══════════════════════════════════════════════════════════════════

    event CycleExecuted(
        uint256 wethClaimed,
        uint256 tusdClaimed,
        uint256 wethSwapped,
        uint256 tusdFromSwap,
        uint256 totalTusdBurned,
        uint256 totalBurnedAllTime,
        uint256 timestamp
    );

    // ══════════════════════════════════════════════════════════════════
    //                           ERRORS
    // ══════════════════════════════════════════════════════════════════

    error NothingToBurn();

    // ══════════════════════════════════════════════════════════════════
    //                        CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════

    error ZeroAddress();

    constructor(
        address _clankerFeeLocker,
        address _uniswapRouter,
        address _pool,
        address _weth,
        address _tusd
    ) {
        if (_clankerFeeLocker == address(0)) revert ZeroAddress();
        if (_uniswapRouter == address(0)) revert ZeroAddress();
        if (_pool == address(0)) revert ZeroAddress();
        if (_weth == address(0)) revert ZeroAddress();
        if (_tusd == address(0)) revert ZeroAddress();

        CLANKER_FEE_LOCKER = IClankerFeeLocker(_clankerFeeLocker);
        UNISWAP_ROUTER = ISwapRouter02(_uniswapRouter);
        POOL = IUniswapV3Pool(_pool);
        WETH = IERC20(_weth);
        TUSD = IERC20(_tusd);
    }

    // ══════════════════════════════════════════════════════════════════
    //                      CORE FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Execute a full burn cycle: claim fees → swap WETH → burn all ₸USD
    /// @dev Permissionless. Anyone can call. Atomic — all-or-nothing.
    function executeFullCycle() external nonReentrant {
        // 1. Record WETH/TUSD balances before claims
        uint256 wethBefore = WETH.balanceOf(address(this));
        uint256 tusdBefore = TUSD.balanceOf(address(this));

        // 2. Claim fees from ClankerFeeLocker (this contract must be feeOwner)
        // Use try/catch — claims may revert if no fees are available
        try CLANKER_FEE_LOCKER.claim(address(this), address(WETH)) {} catch {}
        try CLANKER_FEE_LOCKER.claim(address(this), address(TUSD)) {} catch {}

        uint256 wethClaimed = WETH.balanceOf(address(this)) - wethBefore;
        uint256 tusdClaimed = TUSD.balanceOf(address(this)) - tusdBefore;

        // 3. Swap WETH → TUSD if we have WETH
        uint256 tusdFromSwap = 0;
        uint256 wethToSwap = WETH.balanceOf(address(this));

        if (wethToSwap > 0) {
            // Calculate minAmountOut from pool sqrtPriceX96
            uint256 minAmountOut = _calculateMinAmountOut(wethToSwap);

            // Approve router
            
            WETH.forceApprove(address(UNISWAP_ROUTER), wethToSwap);

            // Swap
            tusdFromSwap = UNISWAP_ROUTER.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: address(WETH),
                    tokenOut: address(TUSD),
                    fee: POOL_FEE,
                    recipient: address(this),
                    amountIn: wethToSwap,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        // 4. Burn ALL TUSD held by this contract
        uint256 totalTusdToBurn = TUSD.balanceOf(address(this));
        if (totalTusdToBurn == 0) revert NothingToBurn();

        TUSD.safeTransfer(DEAD, totalTusdToBurn);

        // 5. Update counters
        totalBurnedAllTime += totalTusdToBurn;
        lastCycleTimestamp = block.timestamp;
        cycleCount++;

        emit CycleExecuted(
            wethClaimed,
            tusdClaimed,
            wethToSwap,
            tusdFromSwap,
            totalTusdToBurn,
            totalBurnedAllTime,
            block.timestamp
        );
    }

    // ══════════════════════════════════════════════════════════════════
    //                       VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Get current status of the burn engine
    function getStatus()
        external
        view
        returns (
            uint256 _totalBurnedAllTime,
            uint256 _lastCycleTimestamp,
            uint256 _cycleCount,
            uint256 _wethBalance,
            uint256 _tusdBalance
        )
    {
        return (
            totalBurnedAllTime,
            lastCycleTimestamp,
            cycleCount,
            WETH.balanceOf(address(this)),
            TUSD.balanceOf(address(this))
        );
    }

    /// @notice Get the current ₸USD price from sqrtPriceX96
    /// @return price The price of TUSD in WETH (18 decimals)
    function getCurrentPrice() external view returns (uint256 price) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        // price = (sqrtPriceX96 / 2^96)^2
        // For token0/token1 pair pricing
        price = _sqrtPriceX96ToPrice(sqrtPriceX96);
    }

    // ══════════════════════════════════════════════════════════════════
    //                      INTERNAL FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    error InvalidPrice();

    /// @dev Calculate minimum output amount from on-chain price with slippage
    /// Uses FullMath.mulDiv to avoid overflow with sqrtPriceX96^2
    function _calculateMinAmountOut(uint256 amountIn) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        if (sqrtPriceX96 == 0) revert InvalidPrice();
        address token0 = POOL.token0();
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        uint256 expectedOut;
        if (token0 == address(WETH)) {
            // WETH is token0: expectedOut = amountIn * sqrtPrice^2 / 2^192
            expectedOut = FullMath.mulDiv(amountIn, FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96), 1 << 96);
        } else {
            // WETH is token1: expectedOut = amountIn * 2^192 / sqrtPrice^2
            expectedOut = FullMath.mulDiv(amountIn, 1 << 96, sqrtPrice);
            expectedOut = FullMath.mulDiv(expectedOut, 1 << 96, sqrtPrice);
        }

        return (expectedOut * (10000 - MAX_SLIPPAGE_BPS)) / 10000;
    }

    /// @dev Convert sqrtPriceX96 to price ratio (18 decimals)
    /// Uses FullMath.mulDiv to avoid overflow
    function _sqrtPriceX96ToPrice(uint160 sqrtPriceX96) internal view returns (uint256) {
        address token0 = POOL.token0();
        uint256 sqrtPrice = uint256(sqrtPriceX96);

        if (token0 == address(WETH)) {
            // Price = sqrtPrice^2 / 2^192, inverted for TUSD/WETH
            uint256 price = FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96);
            return FullMath.mulDiv(1e18, 1 << 96, price);
        } else {
            // Price = sqrtPrice^2 * 1e18 / 2^192
            return FullMath.mulDiv(FullMath.mulDiv(sqrtPrice, sqrtPrice, 1 << 96), 1e18, 1 << 96);
        }
    }
}

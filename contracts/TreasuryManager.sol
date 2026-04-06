// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";
import {IStateView} from "./interfaces/IStateView.sol";
import {IStaking} from "./interfaces/IStaking.sol";
import {IPermit2} from "./interfaces/IPermit2.sol";
import {SwapLib} from "./libraries/SwapLib.sol";
import {FullMath} from "./libraries/FullMath.sol";

/// @title TreasuryManager v2 — Custodied Treasury for ₸USD Monetary Policy
/// @notice Single custody contract for TUSD, WETH, USDC, and strategic ERC20 tokens.
///         Owner + operator pattern with hard caps. No pause, no arbitrary withdrawals.
///         Only external outflow: 25% of strategic rebalance WETH -> USDC to owner.
/// @dev Deployed on Base. All pool/infra addresses are constants.
///      [CRIT-1] Uses TWAP (30-min window) for all V3 pricing to resist flash-loan manipulation.
///      V4 tokens use spot price (no TWAP in V4 StateView) but WETH/USD conversion uses V3 TWAP.
contract TreasuryManager is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ══════════════════════════════════════════════════════════════════
    //                       TOKEN CONSTANTS
    // ══════════════════════════════════════════════════════════════════

    address public constant TUSD = 0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07;
    address public constant WETH = 0x4200000000000000000000000000000000000006;
    address public constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ══════════════════════════════════════════════════════════════════
    //                    POOL & INFRA CONSTANTS
    // ══════════════════════════════════════════════════════════════════

    address public constant TUSD_POOL = 0xd013725b904e76394A3aB0334Da306C505D778F8;
    uint24 public constant TUSD_POOL_FEE = 10000;

    address public constant USDC_WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    uint24 public constant USDC_WETH_POOL_FEE = 500;

    /// @dev Uniswap V3 SwapRouter02 on Base
    address public constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    /// @dev Uniswap Universal Router on Base (for V4 swaps)
    address public constant UNIVERSAL_ROUTER = 0x6fF5693b99212Da76ad316178A184AB56D299b43;

    /// @dev Uniswap V4 PoolManager on Base
    address public constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;

    /// @dev Uniswap V4 StateView on Base
    address public constant STATE_VIEW = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;

    /// @dev TUSD staking contract on Base
    address public constant STAKING = 0x2a70a42BC0524aBCA9Bff59a51E7aAdB575DC89A;

    /// @dev Canonical Permit2 on Base
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Assumed supply for all strategic tokens (for market cap calc)
    uint256 public constant ASSUMED_SUPPLY = 100_000_000_000;

    // ══════════════════════════════════════════════════════════════════
    //               PERMISSIONLESS REBALANCE CONSTANTS
    //     (immutable by design — owner cannot weaken these guarantees)
    // ══════════════════════════════════════════════════════════════════

    uint256 public constant FALLBACK_PER_ACTION = 0.5 ether;
    uint256 public constant FALLBACK_PER_DAY = 2 ether;
    uint256 public constant FALLBACK_SLIPPAGE_BPS = 300;
    uint256 public constant FALLBACK_INITIAL_DELAY = 180 days;
    uint256 public constant FALLBACK_RECURRING_DELAY = 14 days;
    /// @dev 1% of trackedDeposits — threshold for "meaningful" privileged activity
    uint256 public constant FALLBACK_ACTIVITY_BPS = 100;
    /// @dev 2% unlock increment per valid fallback window
    uint256 public constant FALLBACK_UNLOCK_INCREMENT_BPS = 200;

    uint256 internal constant WINDOW_SIZE = 1 days;
    uint256 internal constant BPS = 10000;

    // ══════════════════════════════════════════════════════════════════
    //                          STRUCTS
    // ══════════════════════════════════════════════════════════════════

    /// @dev 2-slot rolling 24h window. Packed into 1 storage slot.
    ///      windowStart (uint48) + currentAmount (uint104) + previousAmount (uint104) = 256 bits
    struct RollingWindow {
        uint48 windowStart;
        uint104 currentAmount;
        uint104 previousAmount;
    }

    /// @dev Per strategic token configuration and accounting
    struct StrategicTokenConfig {
        // --- Slot 1: flags + fees ---
        bool enabled;
        bool isV4;
        bool fallbackActivatedOnce;
        uint24 v3Fee;
        uint24 v4Fee;
        int24 v4TickSpacing;
        // --- Slot 2-5: addresses ---
        address v3Pool;
        address v4Hooks;
        address v4Currency0;
        address v4Currency1;
        // --- Slot 6: V4 pool id ---
        bytes32 v4PoolId;
        // --- Slot 7-8: pricing (immutable after add) ---
        uint256 buyPriceUsd;
        uint256 buyMarketCapUsd;
        // --- Slot 9-11: accounting ---
        uint256 trackedDeposits;
        uint256 totalSold;
        uint256 fallbackSold;
        // --- Slot 12: timestamps + fallback bps (packed) ---
        uint48 firstValidDepositTimestamp;
        uint48 lastNormalRebalanceTimestamp;
        uint48 fallbackWindowStart;
        uint16 fallbackUnlockedBps;
        // --- Slot 13: fallback window tracking ---
        uint256 fallbackWindowPrivilegedSold;
        // --- Slot 14-15: rolling windows ---
        RollingWindow normalWindow;
        RollingWindow permissionlessWindow;
    }

    // ══════════════════════════════════════════════════════════════════
    //                          STORAGE
    // ══════════════════════════════════════════════════════════════════

    address public authorizedOperator;

    // --- Operator-facing limits (mutable by owner) ---
    uint256 public buybackWethPerAction;
    uint256 public buybackWethPerDay;
    uint256 public buybackUsdcPerAction;
    uint256 public buybackUsdcPerDay;
    uint256 public burnTusdPerAction;
    uint256 public burnTusdPerDay;
    uint256 public stakeTusdPerAction;
    uint256 public stakeTusdPerDay;
    uint256 public operatorCooldown;
    uint256 public operatorSlippageBps;
    uint256 public rebalanceWethPerAction;
    uint256 public rebalanceWethPerDay;

    // --- Strategic buy limits (independent from buyback) ---
    uint256 public buyStrategicWethPerAction;
    uint256 public buyStrategicWethPerDay;

    // --- Core rolling windows ---
    RollingWindow public buybackWethWindow;
    RollingWindow public buybackUsdcWindow;
    RollingWindow public burnTusdWindow;
    RollingWindow public stakeTusdWindow;
    RollingWindow public buyStrategicWethWindow;

    // --- Operator cooldown ---
    uint256 public lastOperatorActionTimestamp;

    // --- Strategic tokens ---
    mapping(address => StrategicTokenConfig) public strategicTokens;
    address[] public knownTokens;

    // ══════════════════════════════════════════════════════════════════
    //                           EVENTS
    // ══════════════════════════════════════════════════════════════════

    event BuybackWETH(uint256 wethIn, uint256 tusdOut);
    event BuybackUSDC(uint256 usdcIn, uint256 wethIntermediate, uint256 tusdOut);
    event BurnTUSD(uint256 amount);
    event StakeTUSD(uint256 amount, uint256 poolId);
    event UnstakeTUSD(uint256 amount, uint256 poolId);
    event StrategicTokenAdded(address indexed token, bool isV4, uint256 buyPriceUsd, uint256 buyMarketCapUsd);
    event StrategicDeposit(address indexed token, uint256 amount, uint256 newTrackedDeposits);
    event StrategicRebalance(
        address indexed token,
        uint256 tokenSold,
        uint256 wethReceived,
        uint256 tusdBought,
        uint256 usdcToOwner
    );
    event StrategicBuy(
        address indexed token,
        uint256 wethSpent,
        uint256 tokenReceived
    );
    event PermissionlessRebalance(
        address indexed token,
        uint256 tokenSold,
        uint256 wethReceived,
        uint256 tusdBought,
        uint256 usdcToOwner
    );
    event OperatorSet(address indexed newOperator);
    event OperatorRevoked(address indexed oldOperator);
    event LimitsUpdated();

    // ══════════════════════════════════════════════════════════════════
    //                           ERRORS
    // ══════════════════════════════════════════════════════════════════

    error NotAuthorized();
    error ZeroAmount();
    error ZeroAddress();
    error TokenNotEnabled();
    error TokenAlreadyAdded();
    error CoreTokenNotAllowed();
    error ExceedsActionCap(uint256 requested, uint256 max);
    error ExceedsDailyCap(uint256 requested, uint256 remaining);
    error CooldownActive(uint256 timeRemaining);
    error ExceedsTrancheLimit(uint256 requested, uint256 max);
    error ExceedsUnlockedAmount(uint256 requested, uint256 available);
    error PerTokenCooldownActive();
    error FallbackNotReady();
    error SlippageTooHigh();
    error RollingWindowOverflow(uint256 amount);

    // ══════════════════════════════════════════════════════════════════
    //                         MODIFIERS
    // ══════════════════════════════════════════════════════════════════

    modifier onlyOperatorOrOwner() {
        if (msg.sender != owner() && msg.sender != authorizedOperator) revert NotAuthorized();
        _;
    }

    // ══════════════════════════════════════════════════════════════════
    //                        CONSTRUCTOR
    // ══════════════════════════════════════════════════════════════════

    constructor(address _owner) Ownable(_owner) {
        // Core buyback limits
        buybackWethPerAction = 0.5 ether;
        buybackWethPerDay = 2 ether;
        buybackUsdcPerAction = 2000e6; // USDC has 6 decimals
        buybackUsdcPerDay = 5000e6;

        // Burn & stake limits (TUSD 18 decimals)
        burnTusdPerAction = 100_000_000 ether;
        burnTusdPerDay = 500_000_000 ether;
        stakeTusdPerAction = 100_000_000 ether;
        stakeTusdPerDay = 500_000_000 ether;

        // Operator config
        operatorCooldown = 60 minutes;
        operatorSlippageBps = 300;

        // Normal rebalance caps (WETH output)
        rebalanceWethPerAction = 0.5 ether;
        rebalanceWethPerDay = 2 ether;

        // Strategic buy caps (WETH input — independent from buyback)
        buyStrategicWethPerAction = 0.5 ether;
        buyStrategicWethPerDay = 2 ether;

        // Register core tokens in known list
        knownTokens.push(TUSD);
        knownTokens.push(WETH);
        knownTokens.push(USDC);
    }

    // ══════════════════════════════════════════════════════════════════
    //                    CORE TREASURY FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Buy TUSD with WETH via the TUSD/WETH V3 pool
    function buybackWETH(uint256 amountIn) external nonReentrant onlyOperatorOrOwner {
        if (amountIn == 0) revert ZeroAmount();
        _enforceOperatorCooldown();

        if (!_callerIsOwner()) {
            _enforceActionCap(amountIn, buybackWethPerAction);
            _enforceRollingWindow(buybackWethWindow, amountIn, buybackWethPerDay);
        } else {
            _recordRollingWindow(buybackWethWindow, amountIn);
        }

        // Owner bypasses slippage entirely (minOut=0), operator uses TWAP + configured slippage
        uint256 minOut = _callerIsOwner() ? 0 : _calcMinOut(amountIn, TUSD_POOL, WETH, operatorSlippageBps);

        uint256 received = SwapLib.swapV3ExactInput(
            SWAP_ROUTER, WETH, TUSD, TUSD_POOL_FEE, amountIn, minOut, address(this)
        );

        emit BuybackWETH(amountIn, received);
    }

    /// @notice Buy TUSD with USDC via USDC->WETH->TUSD (two V3 hops)
    function buybackUSDC(uint256 amountIn) external nonReentrant onlyOperatorOrOwner {
        if (amountIn == 0) revert ZeroAmount();
        _enforceOperatorCooldown();

        if (!_callerIsOwner()) {
            _enforceActionCap(amountIn, buybackUsdcPerAction);
            _enforceRollingWindow(buybackUsdcWindow, amountIn, buybackUsdcPerDay);
        } else {
            _recordRollingWindow(buybackUsdcWindow, amountIn);
        }

        bool isOwner = _callerIsOwner();

        // Leg 1: USDC -> WETH — owner bypasses slippage entirely (minOut=0)
        uint256 minWeth = isOwner ? 0 : _calcMinOut(amountIn, USDC_WETH_POOL, USDC, operatorSlippageBps);
        uint256 wethReceived = SwapLib.swapV3ExactInput(
            SWAP_ROUTER, USDC, WETH, USDC_WETH_POOL_FEE, amountIn, minWeth, address(this)
        );

        // Leg 2: WETH -> TUSD — owner bypasses slippage entirely (minOut=0)
        uint256 minTusd = isOwner ? 0 : _calcMinOut(wethReceived, TUSD_POOL, WETH, operatorSlippageBps);
        uint256 tusdReceived = SwapLib.swapV3ExactInput(
            SWAP_ROUTER, WETH, TUSD, TUSD_POOL_FEE, wethReceived, minTusd, address(this)
        );

        emit BuybackUSDC(amountIn, wethReceived, tusdReceived);
    }

    /// @notice Burn exact amount of TUSD by sending to dead address
    function burnTUSD(uint256 amount) external nonReentrant onlyOperatorOrOwner {
        if (amount == 0) revert ZeroAmount();
        _enforceOperatorCooldown();

        if (!_callerIsOwner()) {
            _enforceActionCap(amount, burnTusdPerAction);
            _enforceRollingWindow(burnTusdWindow, amount, burnTusdPerDay);
        } else {
            _recordRollingWindow(burnTusdWindow, amount);
        }

        IERC20(TUSD).safeTransfer(DEAD, amount);
        emit BurnTUSD(amount);
    }

    /// @notice Stake TUSD in external staking contract
    function stakeTUSD(uint256 amount, uint256 poolId) external nonReentrant onlyOperatorOrOwner {
        if (amount == 0) revert ZeroAmount();
        _enforceOperatorCooldown();

        if (!_callerIsOwner()) {
            _enforceActionCap(amount, stakeTusdPerAction);
            _enforceRollingWindow(stakeTusdWindow, amount, stakeTusdPerDay);
        } else {
            _recordRollingWindow(stakeTusdWindow, amount);
        }

        IERC20(TUSD).forceApprove(STAKING, amount);
        IStaking(STAKING).deposit(amount, poolId);
        emit StakeTUSD(amount, poolId);
    }

    /// @notice Unstake TUSD from external staking contract (returns to this contract)
    function unstakeTUSD(uint256 amount, uint256 poolId) external nonReentrant onlyOperatorOrOwner {
        if (amount == 0) revert ZeroAmount();
        IStaking(STAKING).withdraw(amount, poolId);
        emit UnstakeTUSD(amount, poolId);
    }

    // ══════════════════════════════════════════════════════════════════
    //                    STRATEGIC TOKEN MANAGEMENT
    // ══════════════════════════════════════════════════════════════════

    /// @notice Register a new strategic token. Once added, cannot be removed.
    /// @dev [HIGH-8] CONSTRAINT: Strategic tokens MUST be standard ERC20 tokens.
    ///      The following token types are NOT supported and will cause rebalance failures:
    ///      - Fee-on-transfer (FOT) tokens: deposit accounting works, but exit fees cause
    ///        swap reverts or reduced WETH output. trackedDeposits may diverge from balance.
    ///      - Rebasing tokens: balance changes break unlock calculations. Rebase-down can
    ///        cause DoS (revert) when selling more than actual balance.
    ///      - ERC777 tokens: transfer hooks may cause reentrancy (blocked by nonReentrant)
    ///        or unexpected reverts during swaps.
    ///      - Tokens with blocklists/pause: if token blocks the TreasuryManager address,
    ///        all rebalances for that token become permanently DoS'd.
    ///      None of these cases can cause fund loss — at worst, rebalance reverts atomically.
    function addStrategicToken(
        address token,
        bool isV4,
        address v3Pool,
        uint24 v3Fee,
        bytes32 v4PoolId,
        address v4Currency0,
        address v4Currency1,
        uint24 v4Fee,
        int24 v4TickSpacing,
        address v4Hooks,
        uint256 buyPriceUsd,
        uint256 buyMarketCapUsd
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == TUSD || token == WETH || token == USDC) revert CoreTokenNotAllowed();
        if (strategicTokens[token].enabled) revert TokenAlreadyAdded();

        StrategicTokenConfig storage cfg = strategicTokens[token];
        cfg.enabled = true;
        cfg.isV4 = isV4;

        if (!isV4) {
            cfg.v3Pool = v3Pool;
            cfg.v3Fee = v3Fee;
        } else {
            cfg.v4PoolId = v4PoolId;
            cfg.v4Currency0 = v4Currency0;
            cfg.v4Currency1 = v4Currency1;
            cfg.v4Fee = v4Fee;
            cfg.v4TickSpacing = v4TickSpacing;
            cfg.v4Hooks = v4Hooks;
        }

        cfg.buyPriceUsd = buyPriceUsd;
        cfg.buyMarketCapUsd = buyMarketCapUsd;

        knownTokens.push(token);
        emit StrategicTokenAdded(token, isV4, buyPriceUsd, buyMarketCapUsd);
    }

    /// @notice Deposit strategic tokens into the treasury. Only from owner via transferFrom.
    function depositStrategicToken(address token, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        StrategicTokenConfig storage cfg = strategicTokens[token];
        if (!cfg.enabled) revert TokenNotEnabled();

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualDeposited = IERC20(token).balanceOf(address(this)) - balBefore;

        cfg.trackedDeposits += actualDeposited;

        if (cfg.firstValidDepositTimestamp == 0) {
            cfg.firstValidDepositTimestamp = uint48(block.timestamp);
        }

        emit StrategicDeposit(token, actualDeposited, cfg.trackedDeposits);
    }

    // ══════════════════════════════════════════════════════════════════
    //                    STRATEGIC TOKEN BUY
    // ══════════════════════════════════════════════════════════════════

    /// @notice Buy a registered strategic token using WETH from the treasury
    /// @dev WETH can only be used to buy tokens already in the registry (whitelisted by owner).
    ///      Purchased tokens are received back by the contract — no external outflow.
    ///      Uses the same swap infrastructure as rebalance (V3 or V4 depending on token config).
    /// @param token The registered strategic token to buy
    /// @param wethAmount Amount of WETH to spend
    function buyStrategicToken(address token, uint256 wethAmount) external nonReentrant onlyOperatorOrOwner {
        if (wethAmount == 0) revert ZeroAmount();
        StrategicTokenConfig storage cfg = strategicTokens[token];
        if (!cfg.enabled) revert TokenNotEnabled();

        _enforceOperatorCooldown();

        if (!_callerIsOwner()) {
            _enforceActionCap(wethAmount, buyStrategicWethPerAction);
            _enforceRollingWindow(buyStrategicWethWindow, wethAmount, buyStrategicWethPerDay);
        } else {
            _recordRollingWindow(buyStrategicWethWindow, wethAmount);
        }

        // Execute buy: WETH → strategic token (all tokens return to this contract)
        uint256 tokenReceived = _swapStrategic(cfg, WETH, token, wethAmount);

        // Track the deposit for fallback accounting
        cfg.trackedDeposits += tokenReceived;

        if (cfg.firstValidDepositTimestamp == 0) {
            cfg.firstValidDepositTimestamp = uint48(block.timestamp);
        }

        emit StrategicBuy(token, wethAmount, tokenReceived);
    }

    // ══════════════════════════════════════════════════════════════════
    //                   STRATEGIC NORMAL REBALANCE
    // ══════════════════════════════════════════════════════════════════

    /// @notice Sell strategic token for WETH, split 75% TUSD / 25% USDC to owner
    function rebalanceStrategicToken(address token, uint256 amount) external nonReentrant onlyOperatorOrOwner {
        if (amount == 0) revert ZeroAmount();
        StrategicTokenConfig storage cfg = strategicTokens[token];
        if (!cfg.enabled) revert TokenNotEnabled();

        // Quote WETH output for cap enforcement
        uint256 quotedWeth = _quoteStrategicToWeth(cfg, token, amount);

        if (_callerIsOwner()) {
            // Owner bypasses ROI/market cap unlock — can rebalance at any time
            // Only enforce that treasury actually holds enough tokens
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (amount > balance) revert ExceedsUnlockedAmount(amount, balance);
            _recordRollingWindow(cfg.normalWindow, quotedWeth);
        } else {
            // Operator: enforce ROI/market cap unlock + all rate limits
            uint256 unlocked = _normalUnlockedAvailable(cfg, token);
            if (amount > unlocked) revert ExceedsUnlockedAmount(amount, unlocked);

            _enforceOperatorCooldown();

            // Per-token cooldown (4 hours)
            if (block.timestamp < cfg.lastNormalRebalanceTimestamp + 4 hours) {
                revert PerTokenCooldownActive();
            }

            // Tranche cap: 2% of trackedDeposits
            uint256 trancheCap = cfg.trackedDeposits * 200 / BPS;
            if (amount > trancheCap) revert ExceedsTrancheLimit(amount, trancheCap);

            // WETH caps — [HIGH-5] overflow check now inside _enforceRollingWindow
            _enforceActionCap(quotedWeth, rebalanceWethPerAction);
            _enforceRollingWindow(cfg.normalWindow, quotedWeth, rebalanceWethPerDay);
        }

        // Execute sell + split
        (uint256 wethReceived, uint256 tusdBought, uint256 usdcToOwner) =
            _executeStrategicSellAndSplit(cfg, token, amount);

        // Update state
        cfg.totalSold += amount;
        cfg.lastNormalRebalanceTimestamp = uint48(block.timestamp);

        // Record privileged activity for fallback tracking
        _recordPrivilegedActivity(cfg, amount);

        emit StrategicRebalance(token, amount, wethReceived, tusdBought, usdcToOwner);
    }

    // ══════════════════════════════════════════════════════════════════
    //                STRATEGIC PERMISSIONLESS REBALANCE
    // ══════════════════════════════════════════════════════════════════

    /// @notice Permissionless fallback rebalance — callable by anyone when conditions met
    function permissionlessRebalanceStrategicToken(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        StrategicTokenConfig storage cfg = strategicTokens[token];
        if (!cfg.enabled) revert TokenNotEnabled();

        // Check fallback eligibility and compute available
        _evaluateAndAdvanceFallbackWindow(cfg);
        uint256 available = _permissionlessUnlockedAvailable(cfg);
        if (amount > available) revert ExceedsUnlockedAmount(amount, available);

        // Quote WETH output for cap enforcement
        uint256 quotedWeth = _quoteStrategicToWeth(cfg, token, amount);
        _enforceActionCap(quotedWeth, FALLBACK_PER_ACTION);
        _enforceRollingWindow(cfg.permissionlessWindow, quotedWeth, FALLBACK_PER_DAY);

        // Execute sell + split
        (uint256 wethReceived, uint256 tusdBought, uint256 usdcToOwner) =
            _executeStrategicSellAndSplit(cfg, token, amount);

        // Update state — only on success
        cfg.totalSold += amount;
        cfg.fallbackSold += amount;
        cfg.fallbackActivatedOnce = true;
        cfg.fallbackWindowStart = uint48(block.timestamp);
        cfg.fallbackWindowPrivilegedSold = 0;

        emit PermissionlessRebalance(token, amount, wethReceived, tusdBought, usdcToOwner);
    }

    // ══════════════════════════════════════════════════════════════════
    //                     ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        authorizedOperator = newOperator;
        emit OperatorSet(newOperator);
    }

    function revokeOperator() external onlyOwner {
        address old = authorizedOperator;
        authorizedOperator = address(0);
        emit OperatorRevoked(old);
    }

    /// @notice Update all core operator limits in one call
    function setCoreOperatorLimits(
        uint256 _buybackWethPerAction,
        uint256 _buybackWethPerDay,
        uint256 _buybackUsdcPerAction,
        uint256 _buybackUsdcPerDay,
        uint256 _burnTusdPerAction,
        uint256 _burnTusdPerDay,
        uint256 _stakeTusdPerAction,
        uint256 _stakeTusdPerDay
    ) external onlyOwner {
        buybackWethPerAction = _buybackWethPerAction;
        buybackWethPerDay = _buybackWethPerDay;
        buybackUsdcPerAction = _buybackUsdcPerAction;
        buybackUsdcPerDay = _buybackUsdcPerDay;
        burnTusdPerAction = _burnTusdPerAction;
        burnTusdPerDay = _burnTusdPerDay;
        stakeTusdPerAction = _stakeTusdPerAction;
        stakeTusdPerDay = _stakeTusdPerDay;
        emit LimitsUpdated();
    }

    /// @notice Update operator cooldown and slippage
    function setOperatorConfig(uint256 _cooldown, uint256 _slippageBps) external onlyOwner {
        if (_slippageBps > 1000) revert SlippageTooHigh(); // Max 10%
        operatorCooldown = _cooldown;
        operatorSlippageBps = _slippageBps;
        emit LimitsUpdated();
    }

    /// @notice Update normal rebalance WETH caps
    function setRebalanceLimits(uint256 _perAction, uint256 _perDay) external onlyOwner {
        rebalanceWethPerAction = _perAction;
        rebalanceWethPerDay = _perDay;
        emit LimitsUpdated();
    }

    /// @notice Update strategic buy WETH caps
    function setBuyStrategicLimits(uint256 _perAction, uint256 _perDay) external onlyOwner {
        buyStrategicWethPerAction = _perAction;
        buyStrategicWethPerDay = _perDay;
        emit LimitsUpdated();
    }

    // ══════════════════════════════════════════════════════════════════
    //                      VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════════════

    /// @notice Get list of all known token addresses (core + strategic)
    function getKnownTokens() external view returns (address[] memory) {
        return knownTokens;
    }

    /// @notice Number of known tokens
    function knownTokenCount() external view returns (uint256) {
        return knownTokens.length;
    }

    // ══════════════════════════════════════════════════════════════════
    //                    INTERNAL: ROLLING WINDOW
    // ══════════════════════════════════════════════════════════════════

    /// @dev Get the effective amount used in the rolling 24h window
    function _getWindowUsed(RollingWindow storage w) internal view returns (uint256) {
        if (w.windowStart == 0) return 0;

        uint256 elapsed = block.timestamp - w.windowStart;

        if (elapsed >= 2 * WINDOW_SIZE) {
            // Both windows fully expired
            return 0;
        }

        if (elapsed >= WINDOW_SIZE) {
            // Current window expired, in next window
            // Previous = old current, weighted by remaining overlap
            uint256 secondWindowElapsed = elapsed - WINDOW_SIZE;
            uint256 overlapWeight = WINDOW_SIZE - secondWindowElapsed;
            return uint256(w.currentAmount) * overlapWeight / WINDOW_SIZE;
        }

        // Still in current window: current + weighted previous
        uint256 prevWeight = WINDOW_SIZE - elapsed;
        return uint256(w.currentAmount) + (uint256(w.previousAmount) * prevWeight / WINDOW_SIZE);
    }

    /// @dev Record an amount in the rolling window and enforce daily cap
    /// @dev [HIGH-5] Added uint104 overflow validation before cast
    function _enforceRollingWindow(RollingWindow storage w, uint256 amount, uint256 dailyCap) internal {
        if (amount > type(uint104).max) revert RollingWindowOverflow(amount);
        _rotateWindow(w);
        uint256 used = _getWindowUsed(w);
        uint256 remaining = dailyCap > used ? dailyCap - used : 0;
        if (amount > remaining) revert ExceedsDailyCap(amount, remaining);
        w.currentAmount += uint104(amount);
    }

    /// @dev Record an amount without enforcing cap (for owner bypass)
    /// @dev [HIGH-5] Added uint104 overflow validation before cast
    function _recordRollingWindow(RollingWindow storage w, uint256 amount) internal {
        if (amount > type(uint104).max) revert RollingWindowOverflow(amount);
        _rotateWindow(w);
        w.currentAmount += uint104(amount);
    }

    /// @dev Rotate window if needed
    function _rotateWindow(RollingWindow storage w) internal {
        if (w.windowStart == 0) {
            w.windowStart = uint48(block.timestamp);
            return;
        }

        uint256 elapsed = block.timestamp - w.windowStart;

        if (elapsed >= 2 * WINDOW_SIZE) {
            // Both expired, full reset
            w.previousAmount = 0;
            w.currentAmount = 0;
            w.windowStart = uint48(block.timestamp);
        } else if (elapsed >= WINDOW_SIZE) {
            // Rotate once
            w.previousAmount = w.currentAmount;
            w.currentAmount = 0;
            w.windowStart = uint48(block.timestamp);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //                  INTERNAL: OPERATOR ENFORCEMENT
    // ══════════════════════════════════════════════════════════════════

    function _callerIsOwner() internal view returns (bool) {
        return msg.sender == owner();
    }

    function _enforceOperatorCooldown() internal {
        if (!_callerIsOwner() && block.timestamp < lastOperatorActionTimestamp + operatorCooldown) {
            revert CooldownActive(lastOperatorActionTimestamp + operatorCooldown - block.timestamp);
        }
        lastOperatorActionTimestamp = block.timestamp;
    }

    function _enforceActionCap(uint256 amount, uint256 cap) internal pure {
        if (amount > cap) revert ExceedsActionCap(amount, cap);
    }

    // ══════════════════════════════════════════════════════════════════
    //                  INTERNAL: UNLOCK CALCULATIONS
    // ══════════════════════════════════════════════════════════════════

    /// @dev Compute the effective unlock BPS from ROI and market cap checks
    function _effectiveUnlockBps(StrategicTokenConfig storage cfg, address token) internal view returns (uint256) {
        uint256 currentPrice = _getStrategicTokenPrice(cfg, token);

        // ROI unlock: 10x = 25%, +5% per integer multiple
        uint256 roiBps = _computeRoiUnlockBps(currentPrice, cfg.buyPriceUsd);

        // [HIGH-4] Market cap unlock: using assumed 100B supply — use FullMath to prevent overflow
        uint256 currentMarketCap = FullMath.mulDiv(currentPrice, ASSUMED_SUPPLY, 1);
        uint256 mcapBps = _computeMarketCapUnlockBps(currentMarketCap);

        // Use max of the two
        return roiBps > mcapBps ? roiBps : mcapBps;
    }

    /// @dev ROI unlock: >= 10x => 25%, >= 11x => 30%, ..., capped at 100%
    function _computeRoiUnlockBps(uint256 currentPrice, uint256 buyPrice) internal pure returns (uint256) {
        if (buyPrice == 0 || currentPrice < buyPrice * 10) return 0;

        uint256 multiplier = currentPrice / buyPrice;
        // 10x = 2500, 11x = 3000, 12x = 3500, ...
        uint256 bps = 2500 + (multiplier - 10) * 500;
        return bps > BPS ? BPS : bps;
    }

    /// @dev Market cap unlock: >= 100M = 25%, >= 110M = 30%, ..., capped at 100%
    function _computeMarketCapUnlockBps(uint256 currentMarketCap) internal pure returns (uint256) {
        // currentMarketCap has 18 decimals, thresholds in raw USD
        uint256 threshold = 100_000_000e18;
        if (currentMarketCap < threshold) return 0;

        uint256 stepsAbove = (currentMarketCap - threshold) / 10_000_000e18;
        uint256 bps = 2500 + stepsAbove * 500;
        return bps > BPS ? BPS : bps;
    }

    /// @dev Normal available = (trackedDeposits * unlockBps / 10000) - totalSold
    function _normalUnlockedAvailable(StrategicTokenConfig storage cfg, address token) internal view returns (uint256) {
        uint256 unlockBps = _effectiveUnlockBps(cfg, token);
        uint256 totalUnlocked = cfg.trackedDeposits * unlockBps / BPS;
        if (totalUnlocked <= cfg.totalSold) return 0;
        return totalUnlocked - cfg.totalSold;
    }

    /// @dev Permissionless available = (trackedDeposits * fallbackBps / 10000) - fallbackSold
    function _permissionlessUnlockedAvailable(StrategicTokenConfig storage cfg) internal view returns (uint256) {
        uint256 totalUnlocked = cfg.trackedDeposits * uint256(cfg.fallbackUnlockedBps) / BPS;
        if (totalUnlocked <= cfg.fallbackSold) return 0;
        return totalUnlocked - cfg.fallbackSold;
    }

    // ══════════════════════════════════════════════════════════════════
    //                 INTERNAL: FALLBACK WINDOW LOGIC
    // ══════════════════════════════════════════════════════════════════

    /// @dev Evaluate whether a new fallback window has completed and advance state
    function _evaluateAndAdvanceFallbackWindow(StrategicTokenConfig storage cfg) internal {
        if (cfg.firstValidDepositTimestamp == 0) revert FallbackNotReady();

        uint256 windowLength;
        uint256 windowStart;

        if (!cfg.fallbackActivatedOnce) {
            windowLength = FALLBACK_INITIAL_DELAY;
            windowStart = cfg.firstValidDepositTimestamp;
        } else {
            windowLength = FALLBACK_RECURRING_DELAY;
            windowStart = cfg.fallbackWindowStart;
        }

        // Window must have fully elapsed
        if (block.timestamp < windowStart + windowLength) revert FallbackNotReady();

        // Check if privileged activity was below 1% threshold
        uint256 threshold = cfg.trackedDeposits * FALLBACK_ACTIVITY_BPS / BPS;
        if (cfg.fallbackWindowPrivilegedSold < threshold) {
            // Unlock another 2%
            uint256 newBps = uint256(cfg.fallbackUnlockedBps) + FALLBACK_UNLOCK_INCREMENT_BPS;
            cfg.fallbackUnlockedBps = uint16(newBps > BPS ? BPS : newBps);
        }
    }

    /// @dev Record privileged (owner/operator) rebalance activity for fallback tracking
    function _recordPrivilegedActivity(StrategicTokenConfig storage cfg, uint256 amount) internal {
        cfg.fallbackWindowPrivilegedSold += amount;
    }

    // ══════════════════════════════════════════════════════════════════
    //              INTERNAL: STRATEGIC SELL + SPLIT
    // ══════════════════════════════════════════════════════════════════

    /// @dev [HIGH-3] Sell strategic token -> WETH, then split 75% WETH->TUSD + 25% WETH->USDC->owner
    ///      Combined slippage validation: pre-compute expected outputs for both legs and validate
    ///      the total received against a single slippage threshold to prevent compounded loss.
    function _executeStrategicSellAndSplit(
        StrategicTokenConfig storage cfg,
        address token,
        uint256 amount
    ) internal returns (uint256 wethReceived, uint256 tusdBought, uint256 usdcToOwner) {
        // Step 1: Sell strategic token -> WETH
        wethReceived = _swapStrategic(cfg, token, WETH, amount);

        // Step 2: Split WETH 75/25
        uint256 wethForTusd = wethReceived * 75 / 100;
        uint256 wethForUsdc = wethReceived - wethForTusd;

        uint256 slippage = _getActiveSlippage();
        bool ownerBypass = (slippage == 0);

        // Owner bypasses slippage entirely (minOut=0); operator uses TWAP + configured slippage
        uint256 minTusd;
        uint256 minUsdc;
        uint256 expectedTusd;
        uint256 expectedUsdc;

        if (!ownerBypass) {
            // [HIGH-3] Pre-compute expected outputs for combined validation
            expectedTusd = _estimateSwapOutput(wethForTusd, TUSD_POOL, WETH);
            expectedUsdc = _estimateSwapOutput(wethForUsdc, USDC_WETH_POOL, WETH);
            minTusd = SwapLib.applySlippage(expectedTusd, slippage);
            minUsdc = SwapLib.applySlippage(expectedUsdc, slippage);
        }

        // Step 3: Buy TUSD with 75% WETH
        tusdBought = SwapLib.swapV3ExactInput(
            SWAP_ROUTER, WETH, TUSD, TUSD_POOL_FEE, wethForTusd, minTusd, address(this)
        );

        // Step 4: Buy USDC with 25% WETH and send to owner
        usdcToOwner = SwapLib.swapV3ExactInput(
            SWAP_ROUTER, WETH, USDC, USDC_WETH_POOL_FEE, wethForUsdc, minUsdc, owner()
        );

        // [HIGH-3] Combined slippage check (skipped for owner bypass)
        if (!ownerBypass) {
            // USDC has 6 decimals, TUSD has 18 decimals. Convert USDC to 18-dec equivalent.
            uint256 usdcIn18Dec = usdcToOwner * 1e12;
            uint256 combinedReceived = tusdBought + usdcIn18Dec;
            uint256 combinedExpected = expectedTusd + (expectedUsdc * 1e12);
            uint256 combinedMin = SwapLib.applySlippage(combinedExpected, slippage);

            if (combinedReceived < combinedMin) {
                revert SwapLib.InsufficientOutput(combinedReceived, combinedMin);
            }
        }
    }

    /// @dev Unified swap for strategic tokens — handles both sell (token→WETH) and buy (WETH→token).
    ///      swapV4ExactInput is direction-agnostic — same encoding, just swap tokenIn/tokenOut.
    ///      Verified via David's real buy tx 0xa786... and sell tx 0x088a9684 on Base mainnet.
    /// @param tokenIn The input token (strategic token for sell, WETH for buy)
    /// @param tokenOut The output token (WETH for sell, strategic token for buy)
    function _swapStrategic(
        StrategicTokenConfig storage cfg,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) internal returns (uint256 received) {
        uint256 slippage = _getActiveSlippage();
        bool ownerBypass = (slippage == 0);

        if (!cfg.isV4) {
            uint256 minOut;
            if (!ownerBypass) {
                uint256 expected = _estimateSwapOutput(amountIn, cfg.v3Pool, tokenIn);
                minOut = SwapLib.applySlippage(expected, slippage);
            }
            received = SwapLib.swapV3ExactInput(
                SWAP_ROUTER, tokenIn, tokenOut, cfg.v3Fee, amountIn, minOut, address(this)
            );
        } else {
            uint256 minOut;
            if (!ownerBypass) {
                uint256 priceInOut = SwapLib.getV4SpotPrice(
                    IStateView(STATE_VIEW), cfg.v4PoolId, cfg.v4Currency0, tokenIn
                );
                uint256 expected = FullMath.mulDiv(amountIn, priceInOut, 1e18);
                minOut = SwapLib.applySlippage(expected, slippage);
            }

            SwapLib.V4PoolKey memory poolKey = SwapLib.V4PoolKey({
                currency0: cfg.v4Currency0,
                currency1: cfg.v4Currency1,
                fee: cfg.v4Fee,
                tickSpacing: cfg.v4TickSpacing,
                hooks: cfg.v4Hooks
            });

            received = SwapLib.swapV4ExactInput(
                UNIVERSAL_ROUTER, PERMIT2, tokenIn, tokenOut, poolKey, amountIn, minOut
            );
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //                   INTERNAL: PRICE HELPERS
    // ══════════════════════════════════════════════════════════════════

    /// @dev [CRIT-1] Get current price of a strategic token in USD (18 decimals)
    ///      Uses TWAP for V3 pools (30-min window) to resist flash-loan manipulation.
    ///      V4 tokens use spot price (no V4 TWAP available), but WETH/USD leg uses V3 TWAP.
    function _getStrategicTokenPrice(StrategicTokenConfig storage cfg, address token) internal view returns (uint256) {
        // Price of token in WETH
        uint256 tokenPriceInWeth;
        if (!cfg.isV4) {
            // [CRIT-1] V3 tokens: use TWAP for manipulation resistance
            tokenPriceInWeth = SwapLib.getV3TwapPrice(IUniswapV3Pool(cfg.v3Pool), token);
        } else {
            // V4 tokens: spot only (no observe() in V4 StateView)
            tokenPriceInWeth = SwapLib.getV4SpotPrice(IStateView(STATE_VIEW), cfg.v4PoolId, cfg.v4Currency0, token);
        }

        // [CRIT-1] Price of WETH in USD (using USDC as proxy) — TWAP for manipulation resistance
        uint256 wethPriceUsd = SwapLib.getV3TwapPrice(IUniswapV3Pool(USDC_WETH_POOL), WETH);

        // token price in USD = tokenPriceInWeth * wethPriceUsd / 1e18
        return FullMath.mulDiv(tokenPriceInWeth, wethPriceUsd, 1e18);
    }

    /// @dev [HIGH-9] Quote WETH output for a strategic token sell (for cap enforcement)
    ///      V4 path now uses FullMath.mulDiv for precision and accounts for token decimals.
    function _quoteStrategicToWeth(
        StrategicTokenConfig storage cfg,
        address token,
        uint256 amount
    ) internal view returns (uint256) {
        if (!cfg.isV4) {
            return _estimateSwapOutput(amount, cfg.v3Pool, token);
        } else {
            uint256 priceInWeth = SwapLib.getV4SpotPrice(
                IStateView(STATE_VIEW), cfg.v4PoolId, cfg.v4Currency0, token
            );
            // [HIGH-9] Use FullMath.mulDiv for precision instead of priceInWeth * amount / 1e18
            return FullMath.mulDiv(amount, priceInWeth, 1e18);
        }
    }

    /// @dev [CRIT-1] Estimate swap output from a V3 pool using TWAP.
    ///      Uses 2-hour TWAP for TUSD pool (low volume) and 30-min TWAP for liquid pools.
    function _estimateSwapOutput(uint256 amountIn, address pool, address tokenIn) internal view returns (uint256) {
        uint256 price;
        if (pool == TUSD_POOL) {
            // Low-volume pool: use extended 2-hour TWAP for better manipulation resistance
            price = SwapLib.getV3TwapPriceLong(IUniswapV3Pool(pool), tokenIn);
        } else {
            // Liquid pools (USDC/WETH, strategic tokens): 30-min TWAP
            price = SwapLib.getV3TwapPrice(IUniswapV3Pool(pool), tokenIn);
        }
        // price = amount of quoteToken per 1 baseToken (18 dec)
        // output = amountIn * price / 1e18
        return FullMath.mulDiv(amountIn, price, 1e18);
    }

    /// @dev Calculate minimum output with slippage for V3 swaps
    function _calcMinOut(uint256 amountIn, address pool, address tokenIn, uint256 slippageBps)
        internal
        view
        returns (uint256)
    {
        uint256 expected = _estimateSwapOutput(amountIn, pool, tokenIn);
        return SwapLib.applySlippage(expected, slippageBps);
    }

    /// @dev Get active slippage: owner bypasses (0), operator uses configured, permissionless uses constant
    function _getActiveSlippage() internal view returns (uint256) {
        if (msg.sender == owner()) return 0;
        if (msg.sender == authorizedOperator) return operatorSlippageBps;
        return FALLBACK_SLIPPAGE_BPS;
    }

    // ══════════════════════════════════════════════════════════════════
    //                        RECEIVE
    // ══════════════════════════════════════════════════════════════════

    // ══════════════════════════════════════════════════════════════════
    //                   OWNERSHIP OVERRIDE
    // ══════════════════════════════════════════════════════════════════

    /// @dev [HIGH-12] Disable renounceOwnership to prevent bricking the contract.
    ///      Use transferOwnership + acceptOwnership (Ownable2Step) instead.
    function renounceOwnership() public view override onlyOwner {
        revert("Ownership renunciation disabled");
    }

    /// @dev Accept ETH (needed if WETH unwraps during operations)
    receive() external payable {}
}

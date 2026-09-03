// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface for the Clanker v3.1 factory (0x2A787b2362021cC3eEa3C24C4748a6cD5B687382 on Base).
/// @dev Despite the name, this is NOT a fee-locker with claimable balances: `claimRewards(token)` makes
///      the LpLockerv2 collect the fees accrued inside the Uniswap V3 position and forward the
///      creator/interfacer shares directly. There is no view to query pending fees — simulate
///      NonfungiblePositionManager.collect() from the locker instead.
interface IClankerFeeLocker {
    function claimRewards(address token) external;
}

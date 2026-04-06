// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal StateView interface for reading Uniswap V4 pool state
interface IStateView {
    /// @notice Get the current slot0 data for a V4 pool
    /// @param poolId The pool's identifier
    /// @return sqrtPriceX96 The current sqrt price
    /// @return tick The current tick
    /// @return protocolFee The protocol fee
    /// @return lpFee The LP fee
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

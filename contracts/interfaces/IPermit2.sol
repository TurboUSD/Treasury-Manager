// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPermit2 {
    /// @notice Approve a spender to access a given token for the given amount and expiration
    /// @param token The token to approve
    /// @param spender The spender address
    /// @param amount The approved amount
    /// @param expiration The expiration timestamp
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    /// @notice Transfer tokens from owner to recipient using permit2 allowance
    /// @param from The source address
    /// @param to The destination address
    /// @param amount The amount to transfer
    /// @param token The token to transfer
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

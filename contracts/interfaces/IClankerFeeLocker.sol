// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IClankerFeeLocker {
    /// @notice Claim accumulated fees for msg.sender
    /// @param recipient Address to receive the claimed tokens
    /// @param token Token address to claim
    function claim(address recipient, address token) external;

    /// @notice Check claimable balance for a fee owner
    /// @param feeOwner The fee owner address
    /// @param token The token address
    /// @return balance The claimable balance
    function feesToClaim(address feeOwner, address token) external view returns (uint256 balance);
}

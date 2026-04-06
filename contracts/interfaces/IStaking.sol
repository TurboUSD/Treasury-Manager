// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStaking {
    function deposit(uint256 amount, uint256 poolId) external;
    function withdraw(uint256 amount, uint256 poolId) external;
}

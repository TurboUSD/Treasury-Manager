// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Deployed on Base at 0x2c857A891338fe17D86651B7B78C59c96e274246 (source verified on Sourcify).
///      claimLegacyAndBurn() is the permissionless entrypoint used by the dashboard's "Claim & Burn" button:
///      pulls the legacy (Clanker v0) ₸USD fees out of the Safe via the legacy factory and then runs
///      BurnEngine.executeFullCycle(), which also collects the Clanker v3.1 LP fees.
interface IClankerFactory {
    function tokenCreatorTransfer(address safe, address token, address recipient) external;
    function updateTokenCreator(address token, address newCreator) external;
}

interface IBurnEngine {
    function executeFullCycle() external;
}

contract LegacyFeeBurner is ReentrancyGuard {
    address public immutable clankerFactory;
    address public immutable burnEngine;
    address public immutable safe;
    address public immutable token;

    address public owner;
    address public pendingOwner;
    address public operator;

    event LegacyFeesClaimed(address indexed caller, address indexed token, address indexed burnEngine, uint256 timestamp);
    event CreatorTransferred(address indexed token, address indexed newCreator);
    event CreatorRecovered(address indexed token, address indexed owner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(
        address _owner,
        address _operator,
        address _burnEngine,
        address _token,
        address _safe
    ) {
        require(_owner != address(0), "Zero address");
        require(_operator != address(0), "Zero address");
        require(_burnEngine != address(0), "Zero address");
        require(_token != address(0), "Zero address");
        require(_safe != address(0), "Zero address");
        owner = _owner;
        operator = _operator;
        burnEngine = _burnEngine;
        token = _token;
        safe = _safe;
        clankerFactory = 0x10F4485d6f90239B72c6A5eaD2F2320993D285E4;
    }

    function claimLegacyAndBurn() external nonReentrant {
        IClankerFactory(clankerFactory).tokenCreatorTransfer(safe, token, burnEngine);
        IBurnEngine(burnEngine).executeFullCycle();
        emit LegacyFeesClaimed(msg.sender, token, burnEngine, block.timestamp);
    }

    function recoverCreator() external {
        require(msg.sender == operator || msg.sender == owner, "Not authorized");
        IClankerFactory(clankerFactory).updateTokenCreator(token, owner);
        emit CreatorRecovered(token, owner);
    }

    function transferCreator(address newCreator) external {
        require(msg.sender == owner, "Not owner");
        require(newCreator != address(0), "Zero address");
        IClankerFactory(clankerFactory).updateTokenCreator(token, newCreator);
        emit CreatorTransferred(token, newCreator);
    }

    function setOperator(address newOperator) external {
        require(msg.sender == owner, "Not owner");
        require(newOperator != address(0), "Zero address");
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "Not owner");
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferStarted(owner, newOwner);
        pendingOwner = newOwner;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

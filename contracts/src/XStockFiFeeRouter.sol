// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title XStockFiFeeRouter
/// @notice Receives protocol fees from the options desk, binaries, Liquidity Vaults and credit lines and
///         forwards them to BuyBurn. Anyone may call `route`. Changing the destination takes CHANGE_DELAY on top of the owner's own
///         timelock, so holders see it in advance.
contract XStockFiFeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant CHANGE_DELAY = 48 hours;

    address public buyBurn;
    address public pendingBuyBurn;
    uint64 public pendingSince;

    mapping(address token => uint256) public totalRouted;

    event Routed(address indexed token, address indexed to, uint256 amount);
    event DestinationProposed(address indexed next, uint256 executableAt);
    event DestinationChanged(address indexed previous, address indexed next);
    event DestinationProposalCancelled(address indexed next);

    error InvalidAddress();
    error NotReady();
    error NothingPending();

    constructor(address owner_, address buyBurn_) Ownable(owner_) {
        if (buyBurn_ == address(0)) revert InvalidAddress();
        buyBurn = buyBurn_;
    }

    function route(IERC20 token) external nonReentrant returns (uint256 amount) {
        amount = _route(token);
    }

    function routeMany(IERC20[] calldata tokens) external nonReentrant {
        for (uint256 i; i < tokens.length; ++i) {
            _route(tokens[i]);
        }
    }

    function _route(IERC20 token) private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        totalRouted[address(token)] += amount;
        token.safeTransfer(buyBurn, amount);
        emit Routed(address(token), buyBurn, amount);
    }

    function proposeDestination(address next) external onlyOwner {
        if (next == address(0) || next == buyBurn) revert InvalidAddress();
        pendingBuyBurn = next;
        pendingSince = uint64(block.timestamp);
        emit DestinationProposed(next, block.timestamp + CHANGE_DELAY);
    }

    function executeDestination() external onlyOwner {
        address next = pendingBuyBurn;
        if (next == address(0)) revert NothingPending();
        if (block.timestamp < uint256(pendingSince) + CHANGE_DELAY) revert NotReady();
        emit DestinationChanged(buyBurn, next);
        buyBurn = next;
        delete pendingBuyBurn;
        delete pendingSince;
    }

    function cancelDestination() external onlyOwner {
        address next = pendingBuyBurn;
        if (next == address(0)) revert NothingPending();
        delete pendingBuyBurn;
        delete pendingSince;
        emit DestinationProposalCancelled(next);
    }
}

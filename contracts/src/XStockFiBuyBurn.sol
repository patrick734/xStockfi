// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title XStockFiBuyBurn
/// @notice Spends the protocol's fees on the xStockFi token and burns everything it buys.
/// @dev Nothing can be withdrawn from here: assets leave only as burned tokens. Keeper runs are capped per
///      input token and spaced by `minInterval`, which bounds what a bad quote can cost. When deployed before
///      the token exists, `tokenSetter` sets it once and it can never change; until then fees simply
///      accumulate here.
contract XStockFiBuyBurn is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    ERC20Burnable public token;
    /// @notice The one address allowed to set `token`, once. Zero if the token was fixed at deployment.
    address public immutable tokenSetter;
    ISwapAdapter public immutable swapAdapter;

    uint32 public minInterval;
    uint64 public lastRun;
    bool public halted;
    uint256 public totalBurned;
    mapping(address input => uint256) public maxInputPerRun;
    mapping(address input => uint256) public totalSpent;

    event Bought(address indexed input, uint256 amountIn, uint256 tokensOut);
    event Burned(uint256 amount, uint256 totalBurned);
    event InputLimitSet(address indexed input, uint256 maxPerRun);
    event MinIntervalSet(uint32 minInterval);
    event HaltSet(bool halted);
    event TokenSet(address indexed token);

    error InvalidConfig();
    error Unauthorized();
    error TokenAlreadySet();
    error TokenNotSet();
    error IsHalted();
    error OverLimit();
    error TooSoon();
    error SwapShortfall(uint256 received, uint256 minimum);

    constructor(
        ERC20Burnable token_,
        ISwapAdapter swapAdapter_,
        address admin,
        address guardian,
        address keeper,
        uint32 minInterval_,
        address tokenSetter_
    ) {
        if (
            (address(token_) == address(0) && tokenSetter_ == address(0)) || address(swapAdapter_) == address(0)
                || admin == address(0) || guardian == address(0) || keeper == address(0)
        ) revert InvalidConfig();
        token = token_;
        tokenSetter = address(token_) == address(0) ? tokenSetter_ : address(0);
        swapAdapter = swapAdapter_;
        minInterval = minInterval_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
        if (address(token_) != address(0)) emit TokenSet(address(token_));
    }

    /// @notice Sets the token for a deployment that went out before it launched. Once, by `tokenSetter`.
    function setToken(ERC20Burnable token_) external {
        if (msg.sender != tokenSetter) revert Unauthorized();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (address(token_) == address(0)) revert InvalidConfig();
        token = token_;
        emit TokenSet(address(token_));
    }

    /// @notice Swaps `amountIn` of a fee token for the xStockFi token and burns it.
    function buyAndBurn(IERC20 input, uint256 amountIn, uint256 minOut, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 bought)
    {
        if (halted) revert IsHalted();
        ERC20Burnable t = token;
        if (address(t) == address(0)) revert TokenNotSet();
        if (address(input) == address(t) || amountIn == 0 || minOut == 0 || amountIn > maxInputPerRun[address(input)]) {
            revert OverLimit();
        }
        if (block.timestamp < uint256(lastRun) + minInterval) revert TooSoon();
        lastRun = uint64(block.timestamp);

        uint256 before = t.balanceOf(address(this));
        input.forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swap(address(input), address(t), amountIn, minOut, address(this), route);
        input.forceApprove(address(swapAdapter), 0);
        bought = t.balanceOf(address(this)) - before;
        if (bought < minOut) revert SwapShortfall(bought, minOut);

        totalSpent[address(input)] += amountIn;
        emit Bought(address(input), amountIn, bought);
        _burn(t.balanceOf(address(this)));
    }

    /// @notice Burns any xStockFi tokens sent here directly. Anyone can call; does nothing before the token is set.
    function burnHeld() external nonReentrant {
        if (address(token) == address(0)) return;
        _burn(token.balanceOf(address(this)));
    }

    function _burn(uint256 amount) private {
        if (amount == 0) return;
        token.burn(amount);
        totalBurned += amount;
        emit Burned(amount, totalBurned);
    }

    function setInputLimit(address input, uint256 maxPerRun) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxInputPerRun[input] = maxPerRun;
        emit InputLimitSet(input, maxPerRun);
    }

    function setMinInterval(uint32 interval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minInterval = interval;
        emit MinIntervalSet(interval);
    }

    function halt() external onlyRole(GUARDIAN_ROLE) {
        halted = true;
        emit HaltSet(true);
    }

    function resume() external onlyRole(DEFAULT_ADMIN_ROLE) {
        halted = false;
        emit HaltSet(false);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

/// @title XStockFiSwapAdapter
/// @notice Exact-input swaps through owner-registered Uniswap v4 pools, directly on the PoolManager.
///         Routes default to the direct pool, or two hops through the hub token (USDG).
/// @dev Pools with hooks are rejected unless the owner has allowlisted that exact hook (the launchpad
///      hook of the xStockFi token pool). Revoking a hook blocks every route through its pools. Native ETH
///      (address(0)) may be an intermediate hop but never the input or output, since its deltas must
///      net to zero inside the unlock.
contract XStockFiSwapAdapter is ISwapAdapter, IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    uint256 public constant MAX_HOPS = 3;

    IPoolManager public immutable poolManager;
    address public immutable hub;

    mapping(bytes32 pair => PoolKey) private _pools;
    mapping(address hook => bool) public hookAllowed;

    event PoolSet(address indexed token0, address indexed token1, uint24 fee, int24 tickSpacing);
    event HookAllowed(address indexed hook, bool allowed);

    error InvalidPool();
    error InvalidRoute();
    error Unauthorized();
    error PartialFill();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);

    constructor(address owner_, IPoolManager poolManager_, address hub_) Ownable(owner_) {
        poolManager = poolManager_;
        hub = hub_;
    }

    function setHookAllowed(address hook, bool allowed) external onlyOwner {
        if (hook == address(0)) revert InvalidPool();
        hookAllowed[hook] = allowed;
        emit HookAllowed(hook, allowed);
    }

    function setPool(PoolKey calldata key) external onlyOwner {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (c0 >= c1 || !_hookOk(address(key.hooks))) revert InvalidPool();
        _pools[_pairId(c0, c1)] = key;
        emit PoolSet(c0, c1, key.fee, key.tickSpacing);
    }

    function poolFor(address a, address b) public view returns (PoolKey memory key, bool exists) {
        key = _pools[_pairId(a, b)];
        exists = key.tickSpacing != 0;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata route
    ) external nonReentrant returns (uint256 amountOut) {
        address[] memory path = route.length == 0 ? _defaultPath(tokenIn, tokenOut) : abi.decode(route, (address[]));
        if (
            path.length < 2 || path.length > MAX_HOPS + 1 || path[0] != tokenIn
                || path[path.length - 1] != tokenOut || tokenIn == address(0) || tokenOut == address(0)
                || amountIn == 0 || amountIn > uint256(type(int256).max)
        ) revert InvalidRoute();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        amountOut = abi.decode(poolManager.unlock(abi.encode(path, amountIn, recipient)), (uint256));
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert Unauthorized();
        (address[] memory path, uint256 amountIn, address recipient) =
            abi.decode(data, (address[], uint256, address));

        uint256 amount = amountIn;
        for (uint256 i; i + 1 < path.length; ++i) {
            (PoolKey memory key, bool exists) = poolFor(path[i], path[i + 1]);
            if (!exists || !_hookOk(address(key.hooks))) revert InvalidRoute();
            bool zeroForOne = path[i] == Currency.unwrap(key.currency0);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                bytes("")
            );
            int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
            int128 received = zeroForOne ? delta.amount1() : delta.amount0();
            if (paid >= 0 || uint256(uint128(-paid)) != amount || received <= 0) revert PartialFill();
            amount = uint256(uint128(received));
        }

        Currency input = Currency.wrap(path[0]);
        poolManager.sync(input);
        IERC20(path[0]).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(Currency.wrap(path[path.length - 1]), recipient, amount);
        return abi.encode(amount);
    }

    function _defaultPath(address tokenIn, address tokenOut) private view returns (address[] memory path) {
        (, bool direct) = poolFor(tokenIn, tokenOut);
        if (direct || tokenIn == hub || tokenOut == hub) {
            path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
        } else {
            path = new address[](3);
            path[0] = tokenIn;
            path[1] = hub;
            path[2] = tokenOut;
        }
    }

    function _hookOk(address hook) private view returns (bool) {
        return hook == address(0) || hookAllowed[hook];
    }

    function _pairId(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}

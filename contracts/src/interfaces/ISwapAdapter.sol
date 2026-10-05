// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Swap venue used by the vaults and BuyBurn. Callers never trust the returned amount: each one sets
///         its own minimum and measures what actually arrived.
interface ISwapAdapter {
    /// @notice Pulls `amountIn` of `tokenIn` from the caller and sends at least `minOut` of `tokenOut` to
    ///         `recipient`. An empty `route` takes the adapter's default path.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata route
    ) external returns (uint256 amountOut);
}

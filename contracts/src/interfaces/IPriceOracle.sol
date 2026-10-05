// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Chainlink prices for Stock Tokens, quoted in USDG base units.
interface IPriceOracle {
    /// @notice False if the feed is missing or stale, the USDG feed is stale, the sequencer is down, or the
    ///         token reports a corporate action in progress. Never reverts.
    function isFresh(address token) external view returns (bool);

    /// @notice USDG value of `amount` of `token`. Reverts unless `isFresh(token)`.
    function usdgValue(address token, uint256 amount) external view returns (uint256);

    /// @notice Amount of `token` worth `usdgAmount`. Reverts unless `isFresh(token)`.
    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256);

    /// @notice The Chainlink aggregator configured for `token`, or zero.
    function feedOf(address token) external view returns (address);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One Liquidity Vault's range in a Uniswap v4 Stock Token / USDG pool. Only the bound vault can
///         change it, and everything it releases goes to that vault.
/// @dev Removing liquidity in v4 also pays out accrued fees, so the vault calls `collectFees` first in the
///      same transaction; otherwise the fees would be counted as principal.
interface IPoolPosition {
    /// @notice Principal in the range, valued at the oracle price instead of pool spot, so a swap in the
    ///         same block cannot move the vault's share price.
    function balances() external view returns (uint256 stockAmount, uint256 usdgAmount);

    /// @notice USDG value of `stockAmount` at the pool's spot price.
    function spotUsdgValue(uint256 stockAmount) external view returns (uint256);

    /// @notice Opens the range from tokens already sent in. Leftovers go back to the vault.
    function enter(int24 tickLower, int24 tickUpper) external returns (uint128 liquidity);

    function exitAll() external returns (uint256 stockAmount, uint256 usdgAmount);

    /// @notice Removes `numerator / denominator` of the liquidity.
    function withdrawPortion(uint256 numerator, uint256 denominator)
        external
        returns (uint256 stockAmount, uint256 usdgAmount);

    function collectFees() external returns (uint256 stockFees, uint256 usdgFees);
}

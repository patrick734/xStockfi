// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @notice Pool reads and liquidity math for Liquidity Vaults, kept free of v4-core's BUSL-licensed files.
library V4PoolMath {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant Q192 = 1 << 192;
    /// @dev Storage slot of `PoolManager.pools`; matches v4-core StateLibrary.POOLS_SLOT.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    function slot0(IPoolManager manager, PoolId id) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bytes32 data = manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(id), POOLS_SLOT)));
        sqrtPriceX96 = uint160(uint256(data));
        tick = int24(int256(uint256(data) >> 160));
    }

    /// @notice sqrt(amount1 / amount0) in Q64.96 for two amounts of equal value, clamped to v4 bounds.
    function sqrtPriceFromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 root = Math.sqrt(Math.mulDiv(amount1, Q192, amount0));
        if (root < TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE;
        if (root >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        return uint160(root);
    }

    function amountsForLiquidity(uint160 sqrtP, uint160 sqrtA, uint160 sqrtB, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        if (liquidity == 0) return (0, 0);
        if (sqrtP <= sqrtA) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, false);
        } else if (sqrtP < sqrtB) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtB, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtP, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, false);
        }
    }

    function liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtP <= sqrtA) return _liquidity0(sqrtA, sqrtB, amount0);
        if (sqrtP < sqrtB) {
            uint128 l0 = _liquidity0(sqrtP, sqrtB, amount0);
            uint128 l1 = _liquidity1(sqrtA, sqrtP, amount1);
            return l0 < l1 ? l0 : l1;
        }
        return _liquidity1(sqrtA, sqrtB, amount1);
    }

    function _liquidity0(uint160 a, uint160 b, uint256 amount0) private pure returns (uint128) {
        return SafeCast.toUint128(Math.mulDiv(amount0, Math.mulDiv(a, b, Q96), b - a));
    }

    function _liquidity1(uint160 a, uint160 b, uint256 amount1) private pure returns (uint128) {
        return SafeCast.toUint128(Math.mulDiv(amount1, Q96, b - a));
    }
}

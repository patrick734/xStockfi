// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Transfers that never revert. A payment the token refuses (a frozen or blocked recipient, say)
///         is reported back so the caller can book it as owed instead of failing the whole action, which
///         would let one party trap the other's funds.
library Payouts {
    function tryTransfer(IERC20 token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return address(token).code.length != 0;
        return ret.length >= 32 && abi.decode(ret, (bool));
    }
}

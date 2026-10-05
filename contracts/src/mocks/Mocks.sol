// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolPosition} from "../interfaces/IPoolPosition.sol";
import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";

// Test doubles for the unit tests and the local demo. Never deployed to a live network.

contract MockERC20 is ERC20Burnable {
    uint8 private immutable _decimals;
    mapping(address => bool) public blocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Like a stablecoin freeze: a blocked address can neither send nor receive.
    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        require(!blocked[from] && !blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @dev Robinhood Stock Token stand-in with the corporate-action flag.
contract MockStockToken is MockERC20 {
    bool public oraclePaused;

    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_, 18) {}

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
    }
}

/// @dev Keeps every round so historical lookups work. Round ids follow Chainlink's phase layout.
contract MockAggregator {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    uint16 public phase = 1;
    uint64 public last;
    mapping(uint80 => Round) private _rounds;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        _push(answer_, block.timestamp, block.timestamp);
    }

    function setAnswer(int256 answer_) external {
        _push(answer_, block.timestamp, block.timestamp);
    }

    /// @dev Pushes a round with explicit times, e.g. to make the feed stale.
    function set(int256 answer_, uint256 startedAt_, uint256 updatedAt_) external {
        _push(answer_, startedAt_, updatedAt_);
    }

    /// @dev Starts a new phase, as when Chainlink swaps the aggregator behind a proxy.
    function newPhase(int256 answer_) external {
        phase += 1;
        last = 0;
        _push(answer_, block.timestamp, block.timestamp);
    }

    /// @dev A phase that never reports, as when an aggregator is replaced before its first round.
    function skipPhase() external {
        phase += 1;
        last = 0;
    }

    function latestRoundData() external view returns (uint80 id, int256, uint256, uint256, uint80) {
        id = _id(phase, last);
        Round memory r = _rounds[id];
        return (id, r.answer, r.startedAt, r.updatedAt, id);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[id];
        require(r.updatedAt != 0, "no round");
        return (id, r.answer, r.startedAt, r.updatedAt, id);
    }

    function latestId() external view returns (uint80) {
        return _id(phase, last);
    }

    function _push(int256 answer_, uint256 startedAt_, uint256 updatedAt_) private {
        last += 1;
        _rounds[_id(phase, last)] = Round(answer_, startedAt_, updatedAt_);
    }

    function _id(uint16 p, uint64 n) private pure returns (uint80) {
        return uint80((uint256(p) << 64) | n);
    }
}

/// @dev Holds tokens as "the range". Principal is its balance minus fees waiting to be collected.
contract MockPosition is IPoolPosition {
    MockERC20 public immutable stock;
    MockERC20 public immutable usdg;
    uint256 private immutable stockUnit;
    address public vault;
    uint256 public spotUsdgPerUnit;
    uint256 public pendingStockFees;
    uint256 public pendingUsdgFees;
    uint256 public entries;

    constructor(MockERC20 stock_, MockERC20 usdg_, uint256 spotUsdgPerUnit_) {
        stock = stock_;
        usdg = usdg_;
        stockUnit = 10 ** stock_.decimals();
        spotUsdgPerUnit = spotUsdgPerUnit_;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    function bind(address vault_) external {
        require(vault == address(0), "bound");
        vault = vault_;
    }

    function setSpot(uint256 spot) external {
        spotUsdgPerUnit = spot;
    }

    function accrueFees(uint256 stockFees, uint256 usdgFees) external {
        stock.mint(address(this), stockFees);
        usdg.mint(address(this), usdgFees);
        pendingStockFees += stockFees;
        pendingUsdgFees += usdgFees;
    }

    function balances() public view returns (uint256, uint256) {
        return (stock.balanceOf(address(this)) - pendingStockFees, usdg.balanceOf(address(this)) - pendingUsdgFees);
    }

    function spotUsdgValue(uint256 stockAmount) external view returns (uint256) {
        return Math.mulDiv(stockAmount, spotUsdgPerUnit, stockUnit);
    }

    function enter(int24, int24) external onlyVault returns (uint128) {
        ++entries;
        return 1;
    }

    function exitAll() external onlyVault returns (uint256 s, uint256 u) {
        (s, u) = balances();
        stock.transfer(vault, s);
        usdg.transfer(vault, u);
    }

    function withdrawPortion(uint256 numerator, uint256 denominator) external onlyVault returns (uint256 s, uint256 u) {
        (uint256 bs, uint256 bu) = balances();
        if (numerator >= denominator) numerator = denominator;
        s = Math.mulDiv(bs, numerator, denominator);
        u = Math.mulDiv(bu, numerator, denominator);
        stock.transfer(vault, s);
        usdg.transfer(vault, u);
    }

    function collectFees() external onlyVault returns (uint256 s, uint256 u) {
        s = pendingStockFees;
        u = pendingUsdgFees;
        pendingStockFees = 0;
        pendingUsdgFees = 0;
        if (s != 0) stock.transfer(vault, s);
        if (u != 0) usdg.transfer(vault, u);
    }
}

/// @dev Swaps at a fixed rate out of its own inventory: out = in * rate / 1e18.
contract MockSwapAdapter is ISwapAdapter {
    mapping(address => mapping(address => uint256)) public rate;

    function setRate(address tokenIn, address tokenOut, uint256 rateWad) external {
        rate[tokenIn][tokenOut] = rateWad;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient, bytes calldata)
        external
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        amountOut = Math.mulDiv(amountIn, rate[tokenIn][tokenOut], 1e18);
        require(amountOut >= minOut, "min out");
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}

/// @dev Takes a cut of every transfer, to check that collateral is never booked at face value.
contract MockFeeToken is MockERC20 {
    constructor() MockERC20("Fee Token", "FEE", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 cut = value / 100;
            super._update(from, address(0xdead), cut);
            value -= cut;
        }
        super._update(from, to, value);
    }
}

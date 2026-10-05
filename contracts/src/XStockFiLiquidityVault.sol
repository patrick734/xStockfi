// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {IPoolPosition} from "./interfaces/IPoolPosition.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title XStockFiLiquidityVault
/// @notice ERC-4626 vault over one Stock Token / USDG Uniswap v4 pool. Deposits are in USDG.
///         The keeper places idle balances in a concentrated range, and swap fees compound for
///         holders after the protocol share is sent to the FeeRouter.
/// @dev Pausing blocks deposits and rebalancing only. `redeemInKind` needs no price and stays open
///      while paused or while the oracle is stale.
contract XStockFiLiquidityVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 3_000;
    uint16 public constant MAX_SWAP_LOSS_BPS = 300;
    uint16 public constant MAX_POOL_DEVIATION_BPS = 500;
    uint16 private constant BPS = 10_000;

    IERC20 public immutable stock;
    IPoolPosition public immutable position;
    IPriceOracle public immutable oracle;
    ISwapAdapter public immutable swapAdapter;
    address public immutable feeRouter;
    uint256 private immutable stockUnit;

    uint256 public heldValueCap;
    uint16 public protocolShareBps = 3_000;
    uint16 public maxPoolDeviationBps = 200;
    uint16 public maxSwapLossBps = 100;

    uint256 public grossStockFees;
    uint256 public grossUsdgFees;

    event FeesHarvested(uint256 stockFees, uint256 usdgFees, uint256 protocolStock, uint256 protocolUsdg);
    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event RedeemedInKind(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 shares,
        uint256 stockAmount,
        uint256 usdgAmount
    );
    event HeldValueCapSet(uint256 cap);
    event ProtocolShareSet(uint16 bps);
    event RiskLimitsSet(uint16 maxPoolDeviationBps, uint16 maxSwapLossBps);

    error InvalidConfig();
    error PoolDeviation(uint256 spotValue, uint256 oracleValue);
    error SwapLoss(uint256 received, uint256 minimum);
    error Slippage();

    struct Config {
        IERC20 usdg;
        IERC20 stock;
        IPoolPosition position;
        IPriceOracle oracle;
        ISwapAdapter swapAdapter;
        address feeRouter;
        address admin;
        address guardian;
        address keeper;
        uint256 heldValueCap;
    }

    constructor(Config memory c, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(c.usdg)
    {
        if (
            address(c.stock) == address(0) || address(c.position) == address(0)
                || address(c.oracle) == address(0) || address(c.swapAdapter) == address(0)
                || c.feeRouter == address(0) || c.admin == address(0) || c.guardian == address(0)
                || c.keeper == address(0) || c.guardian == c.admin
        ) revert InvalidConfig();
        stock = c.stock;
        position = c.position;
        oracle = c.oracle;
        swapAdapter = c.swapAdapter;
        feeRouter = c.feeRouter;
        stockUnit = 10 ** IERC20Metadata(address(c.stock)).decimals();
        heldValueCap = c.heldValueCap;
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(GUARDIAN_ROLE, c.guardian);
        _grantRole(KEEPER_ROLE, c.keeper);
    }

    /*//////////////////////////////////////////////////////////////
                               ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    function totalAssets() public view override returns (uint256) {
        (uint256 e, uint256 u) = holdings();
        return u + (e == 0 ? 0 : oracle.usdgValue(address(stock), e));
    }

    /// @notice Stock Token and USDG backing all shares: idle balances plus the range's principal.
    function holdings() public view returns (uint256 stockAmount, uint256 usdgAmount) {
        (stockAmount, usdgAmount) = position.balances();
        stockAmount += stock.balanceOf(address(this));
        usdgAmount += IERC20(asset()).balanceOf(address(this));
    }

    function priceFresh() public view returns (bool) {
        return oracle.isFresh(address(stock));
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused() || !priceFresh()) return 0;
        uint256 held = totalAssets();
        return heldValueCap > held ? heldValueCap - held : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : _convertToShares(assets, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return priceFresh() ? super.maxWithdraw(owner) : 0;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return priceFresh() ? super.maxRedeem(owner) : 0;
    }

    /*//////////////////////////////////////////////////////////////
                           DEPOSITS AND EXITS
    //////////////////////////////////////////////////////////////*/

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        _harvest();
        _checkPool();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        _harvest();
        _checkPool();
        return super.mint(shares, receiver);
    }

    /// @notice Exits to exactly `assets` USDG. Any loss from selling Stock Token to raise the USDG is
    ///         paid in extra shares, so `previewWithdraw` is a lower bound on the shares burned.
    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _harvest();
        _checkPool();
        uint256 maxAssets = maxWithdraw(owner);
        if (assets > maxAssets) revert ERC4626ExceededMaxWithdraw(owner, assets, maxAssets);
        uint256 valueBefore = totalAssets();
        uint256 supply = totalSupply();
        uint256 loss = _raiseUsdg(assets);
        shares = Math.mulDiv(assets + loss, supply + 10 ** _decimalsOffset(), valueBefore + 1, Math.Rounding.Ceil);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
    }

    /// @notice Burns exactly `shares` for USDG. Any loss from selling Stock Token to raise the USDG is
    ///         deducted from the payout, so `previewRedeem` is an upper bound on the USDG received.
    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        _harvest();
        _checkPool();
        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        uint256 gross = previewRedeem(shares);
        assets = gross - _raiseUsdg(gross);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
    }

    /// @notice Burns shares for their pro-rata Stock Token and USDG without any swap or price check.
    function redeemInKind(
        uint256 shares,
        address receiver,
        address owner,
        uint256 minStock,
        uint256 minUsdg
    ) external nonReentrant returns (uint256 stockOut, uint256 usdgOut) {
        if (shares == 0) revert InvalidConfig();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _harvest();
        IERC20 usdg = IERC20(asset());
        uint256 supply = totalSupply();
        stockOut = Math.mulDiv(stock.balanceOf(address(this)), shares, supply);
        usdgOut = Math.mulDiv(usdg.balanceOf(address(this)), shares, supply);
        _burn(owner, shares);
        (uint256 pe, uint256 pu) = position.withdrawPortion(shares, supply);
        stockOut += pe;
        usdgOut += pu;
        if (stockOut < minStock || usdgOut < minUsdg) revert Slippage();
        stock.safeTransfer(receiver, stockOut);
        usdg.safeTransfer(receiver, usdgOut);
        emit RedeemedInKind(msg.sender, receiver, owner, shares, stockOut, usdgOut);
    }

    /// @dev Tops the USDG balance up to `target`, first from the range (sized for the worst allowed
    ///      swap loss) and then by selling Stock Token. Returns the resulting drop in Held Value,
    ///      which the exiting holder bears.
    function _raiseUsdg(uint256 target) private returns (uint256 loss) {
        IERC20 usdg = IERC20(asset());
        uint256 held = usdg.balanceOf(address(this));
        if (held >= target) return 0;
        uint256 valueBefore = totalAssets();
        _pullUsdg(usdg, target, held);
        uint256 valueAfter = totalAssets();
        loss = valueBefore > valueAfter ? valueBefore - valueAfter : 0;
    }

    function _pullUsdg(IERC20 usdg, uint256 target, uint256 held) private {
        (uint256 pe, uint256 pu) = position.balances();
        uint256 positionValue = pu + oracle.usdgValue(address(stock), pe);
        if (positionValue != 0) {
            uint256 needed = Math.mulDiv(target - held, BPS, BPS - maxSwapLossBps, Math.Rounding.Ceil);
            position.withdrawPortion(Math.min(needed, positionValue), positionValue);
        }
        held = usdg.balanceOf(address(this));
        if (held >= target) return;
        uint256 toSell = Math.min(
            stock.balanceOf(address(this)),
            oracle.fromUsdgValue(
                address(stock), Math.mulDiv(target - held, BPS, BPS - maxSwapLossBps, Math.Rounding.Ceil)
            ) + 1
        );
        if (toSell != 0) _swapChecked(stock, usdg, toSell, "");
    }

    /*//////////////////////////////////////////////////////////////
                                 KEEPER
    //////////////////////////////////////////////////////////////*/

    /// @notice Moves the whole range to `[tickLower, tickUpper]`, optionally swapping first so idle
    ///         balances match the new range's ratio.
    function rebalance(
        int24 tickLower,
        int24 tickUpper,
        bool sellUsdg,
        uint256 swapAmount,
        bytes calldata route
    ) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        _harvest();
        _checkPool();
        position.exitAll();
        IERC20 usdg = IERC20(asset());
        if (swapAmount != 0) {
            if (sellUsdg) _swapChecked(usdg, stock, swapAmount, route);
            else _swapChecked(stock, usdg, swapAmount, route);
        }
        stock.safeTransfer(address(position), stock.balanceOf(address(this)));
        usdg.safeTransfer(address(position), usdg.balanceOf(address(this)));
        uint128 liquidity = position.enter(tickLower, tickUpper);
        emit Rebalanced(tickLower, tickUpper, liquidity);
    }

    /// @notice Collects swap fees. The protocol share goes to the FeeRouter and the rest compounds.
    function harvest() external nonReentrant {
        _harvest();
    }

    function _harvest() private {
        (uint256 fe, uint256 fu) = position.collectFees();
        if (fe == 0 && fu == 0) return;
        grossStockFees += fe;
        grossUsdgFees += fu;
        uint256 pe = Math.mulDiv(fe, protocolShareBps, BPS);
        uint256 pu = Math.mulDiv(fu, protocolShareBps, BPS);
        if (pe != 0) stock.safeTransfer(feeRouter, pe);
        if (pu != 0) IERC20(asset()).safeTransfer(feeRouter, pu);
        emit FeesHarvested(fe, fu, pe, pu);
    }

    function _checkPool() private view {
        uint256 fair = oracle.usdgValue(address(stock), stockUnit);
        uint256 spot = position.spotUsdgValue(stockUnit);
        uint256 diff = spot > fair ? spot - fair : fair - spot;
        if (diff * BPS > fair * maxPoolDeviationBps) revert PoolDeviation(spot, fair);
    }

    function _swapChecked(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, bytes memory route)
        private
        returns (uint256 amountOut)
    {
        uint256 minOut = _fromUsdg(
            tokenOut, Math.mulDiv(_toUsdg(tokenIn, amountIn), BPS - maxSwapLossBps, BPS)
        );
        uint256 before = tokenOut.balanceOf(address(this));
        tokenIn.forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swap(address(tokenIn), address(tokenOut), amountIn, minOut, address(this), route);
        tokenIn.forceApprove(address(swapAdapter), 0);
        amountOut = tokenOut.balanceOf(address(this)) - before;
        if (amountOut < minOut) revert SwapLoss(amountOut, minOut);
    }

    function _toUsdg(IERC20 token, uint256 amount) private view returns (uint256) {
        return address(token) == asset() ? amount : oracle.usdgValue(address(token), amount);
    }

    function _fromUsdg(IERC20 token, uint256 usdgAmount) private view returns (uint256) {
        return address(token) == asset() ? usdgAmount : oracle.fromUsdgValue(address(token), usdgAmount);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function lowerHeldValueCap(uint256 cap) external onlyRole(GUARDIAN_ROLE) {
        if (cap > heldValueCap) revert InvalidConfig();
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function setHeldValueCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function setProtocolShareBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (bps > MAX_PROTOCOL_SHARE_BPS) revert InvalidConfig();
        _harvest();
        protocolShareBps = bps;
        emit ProtocolShareSet(bps);
    }

    function setRiskLimits(uint16 poolDeviationBps, uint16 swapLossBps)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (
            poolDeviationBps == 0 || poolDeviationBps > MAX_POOL_DEVIATION_BPS || swapLossBps == 0
                || swapLossBps > MAX_SWAP_LOSS_BPS
        ) revert InvalidConfig();
        maxPoolDeviationBps = poolDeviationBps;
        maxSwapLossBps = swapLossBps;
        emit RiskLimitsSet(poolDeviationBps, swapLossBps);
    }
}

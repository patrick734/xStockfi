// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {XStockFiLiquidityVault} from "./XStockFiLiquidityVault.sol";

/// @title XStockFiCreditDesk
/// @notice One isolated Credit Line: lenders supply USDG and hold ERC-4626 lender shares; borrowers
///         pledge shares of one Liquidity Vault and borrow USDG against them. Bad debt stays in this market.
/// @dev Collateral is valued with `convertToAssets` on the Liquidity Vault, which prices the Stock Token leg from
///      Chainlink, never from pool spot. Borrowing, releasing collateral against debt and liquidating
///      all require a fresh price. Pausing blocks supplying, pledging and borrowing only.
contract XStockFiCreditDesk is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;
    uint256 private constant YEAR = 365 days;

    XStockFiLiquidityVault public immutable vault;
    address public immutable feeRouter;

    struct RiskParams {
        uint16 ltvBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint16 closeFactorBps;
        uint16 maxCollateralShareBps;
        uint16 reserveFactorBps;
    }

    struct RateModel {
        uint64 baseRatePerYear;
        uint64 slope1PerYear;
        uint64 slope2PerYear;
        uint64 kinkUtilization;
    }

    struct Account {
        uint256 collateralShares;
        uint256 debtScaled;
    }

    RiskParams public risk;
    RateModel public rates;
    uint256 public supplyCap;
    uint256 public borrowCap;

    uint256 public totalDebt;
    uint256 public borrowIndex = WAD;
    uint256 public reserves;
    uint256 public badDebt;
    uint256 public totalCollateralShares;
    uint64 public lastAccrual;

    mapping(address => Account) public accounts;

    event Pledged(address indexed account, uint256 shares);
    event Released(address indexed account, address indexed receiver, uint256 shares);
    event Borrowed(address indexed account, address indexed receiver, uint256 amount);
    event Repaid(address indexed payer, address indexed account, uint256 amount);
    event Liquidated(
        address indexed liquidator, address indexed account, uint256 repaid, uint256 sharesSeized, uint256 badDebt
    );
    event ReservesClaimed(uint256 amount);
    event RiskParamsSet(RiskParams params);
    event RateModelSet(RateModel model);
    event CapsSet(uint256 supplyCap, uint256 borrowCap);

    error InvalidConfig();
    error StalePrice();
    error Unhealthy();
    error Healthy();
    error InsufficientCash();
    error CapExceeded();
    error ZeroAmount();

    constructor(
        XStockFiLiquidityVault vault_,
        address feeRouter_,
        address admin,
        address guardian,
        RiskParams memory risk_,
        RateModel memory rates_,
        uint256 supplyCap_,
        uint256 borrowCap_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) ERC4626(IERC20(vault_.asset())) {
        if (feeRouter_ == address(0) || admin == address(0) || guardian == address(0) || admin == guardian) {
            revert InvalidConfig();
        }
        vault = vault_;
        feeRouter = feeRouter_;
        _setRisk(risk_);
        _setRates(rates_);
        supplyCap = supplyCap_;
        borrowCap = borrowCap_;
        lastAccrual = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /*//////////////////////////////////////////////////////////////
                                INTEREST
    //////////////////////////////////////////////////////////////*/

    function cash() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    function utilization() public view returns (uint256) {
        (uint256 debt, uint256 res,) = _projected();
        return _utilization(cash(), debt, res);
    }

    function borrowRatePerYear() public view returns (uint256) {
        (uint256 debt, uint256 res,) = _projected();
        return _borrowRate(_utilization(cash(), debt, res));
    }

    function supplyRatePerYear() external view returns (uint256) {
        (uint256 debt, uint256 res,) = _projected();
        uint256 u = _utilization(cash(), debt, res);
        return Math.mulDiv(Math.mulDiv(_borrowRate(u), u, WAD), BPS - risk.reserveFactorBps, BPS);
    }

    function accrue() public {
        (totalDebt, reserves, borrowIndex) = _projected();
        lastAccrual = uint64(block.timestamp);
    }

    function _projected() private view returns (uint256 debt, uint256 res, uint256 index) {
        debt = totalDebt;
        res = reserves;
        index = borrowIndex;
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0 || debt == 0) return (debt, res, index);
        uint256 factor = Math.mulDiv(_borrowRate(_utilization(cash(), debt, res)), dt, YEAR);
        uint256 interest = Math.mulDiv(debt, factor, WAD);
        debt += interest;
        res += Math.mulDiv(interest, risk.reserveFactorBps, BPS);
        index += Math.mulDiv(index, factor, WAD);
    }

    function _utilization(uint256 c, uint256 debt, uint256 res) private pure returns (uint256) {
        uint256 supplied = c + debt;
        supplied = supplied > res ? supplied - res : 0;
        return supplied == 0 ? 0 : Math.min(WAD, Math.mulDiv(debt, WAD, supplied));
    }

    function _borrowRate(uint256 u) private view returns (uint256) {
        RateModel memory m = rates;
        if (u <= m.kinkUtilization) {
            return m.baseRatePerYear + Math.mulDiv(u, m.slope1PerYear, m.kinkUtilization);
        }
        return m.baseRatePerYear + m.slope1PerYear
            + Math.mulDiv(u - m.kinkUtilization, m.slope2PerYear, WAD - m.kinkUtilization);
    }

    /*//////////////////////////////////////////////////////////////
                                LENDERS
    //////////////////////////////////////////////////////////////*/

    function totalAssets() public view override returns (uint256) {
        (uint256 debt, uint256 res,) = _projected();
        uint256 gross = cash() + debt;
        return gross > res ? gross - res : 0;
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 supplied = totalAssets();
        return supplyCap > supplied ? supplyCap - supplied : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : _convertToShares(assets, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), _freeCash());
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), _convertToShares(_freeCash(), Math.Rounding.Floor));
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        accrue();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        accrue();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        accrue();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        accrue();
        return super.redeem(shares, receiver, owner);
    }

    function _freeCash() private view returns (uint256) {
        (, uint256 res,) = _projected();
        uint256 c = cash();
        return c > res ? c - res : 0;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /*//////////////////////////////////////////////////////////////
                               BORROWERS
    //////////////////////////////////////////////////////////////*/

    function debtOf(address account) public view returns (uint256) {
        (,, uint256 index) = _projected();
        return Math.mulDiv(accounts[account].debtScaled, index, WAD, Math.Rounding.Ceil);
    }

    /// @notice USDG value of the account's pledged vault shares. Reverts while the price is stale.
    function collateralValue(address account) public view returns (uint256) {
        uint256 shares = accounts[account].collateralShares;
        return shares == 0 ? 0 : vault.convertToAssets(shares);
    }

    /// @notice Extra USDG the account can borrow now; zero while the price is stale.
    function borrowable(address account) external view returns (uint256) {
        if (!vault.priceFresh()) return 0;
        uint256 limit = Math.mulDiv(collateralValue(account), risk.ltvBps, BPS);
        uint256 debt = debtOf(account);
        return Math.min(limit > debt ? limit - debt : 0, _freeCash());
    }

    /// @notice Health factor in WAD; below 1e18 the account can be liquidated.
    function healthFactor(address account) public view returns (uint256) {
        uint256 debt = debtOf(account);
        if (debt == 0) return type(uint256).max;
        return Math.mulDiv(
            Math.mulDiv(collateralValue(account), risk.liquidationThresholdBps, BPS), WAD, debt
        );
    }

    function pledge(uint256 shares) external nonReentrant whenNotPaused {
        if (shares == 0) revert ZeroAmount();
        uint256 limit = Math.mulDiv(vault.totalSupply(), risk.maxCollateralShareBps, BPS);
        if (totalCollateralShares + shares > limit) revert CapExceeded();
        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        accounts[msg.sender].collateralShares += shares;
        totalCollateralShares += shares;
        emit Pledged(msg.sender, shares);
    }

    function release(uint256 shares, address receiver) external nonReentrant {
        accrue();
        Account storage a = accounts[msg.sender];
        if (shares == 0 || shares > a.collateralShares) revert ZeroAmount();
        a.collateralShares -= shares;
        totalCollateralShares -= shares;
        if (a.debtScaled != 0) _requireWithinLtv(msg.sender);
        IERC20(address(vault)).safeTransfer(receiver, shares);
        emit Released(msg.sender, receiver, shares);
    }

    function borrow(uint256 amount, address receiver) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        accrue();
        if (amount > _freeCash()) revert InsufficientCash();
        if (totalDebt + amount > borrowCap) revert CapExceeded();
        accounts[msg.sender].debtScaled += Math.mulDiv(amount, WAD, borrowIndex, Math.Rounding.Ceil);
        totalDebt += amount;
        _requireWithinLtv(msg.sender);
        IERC20(asset()).safeTransfer(receiver, amount);
        emit Borrowed(msg.sender, receiver, amount);
    }

    /// @notice Repays up to `amount` of `account`'s debt; pass type(uint256).max to repay in full.
    function repay(uint256 amount, address account) external nonReentrant returns (uint256 paid) {
        accrue();
        paid = Math.min(amount, debtOf(account));
        if (paid == 0) revert ZeroAmount();
        _reduceDebt(account, paid);
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), paid);
        emit Repaid(msg.sender, account, paid);
    }

    /// @notice Repays part of an unhealthy account's debt and seizes vault shares worth the repayment
    ///         plus the liquidation bonus. Any debt left once collateral runs out is written off.
    function liquidate(address account, uint256 repayAmount, address receiver)
        external
        nonReentrant
        returns (uint256 repaid, uint256 seized)
    {
        accrue();
        if (!vault.priceFresh()) revert StalePrice();
        if (healthFactor(account) >= WAD) revert Healthy();

        Account storage a = accounts[account];
        uint256 debt = debtOf(account);
        uint256 maxRepay = Math.mulDiv(debt, risk.closeFactorBps, BPS, Math.Rounding.Ceil);
        repaid = Math.min(repayAmount, maxRepay);
        if (repaid == 0) revert ZeroAmount();

        seized = vault.convertToShares(Math.mulDiv(repaid, BPS + risk.liquidationBonusBps, BPS));
        if (seized > a.collateralShares) {
            seized = a.collateralShares;
            repaid = Math.min(
                repaid, Math.mulDiv(vault.convertToAssets(seized), BPS, BPS + risk.liquidationBonusBps)
            );
        }

        IERC20(asset()).safeTransferFrom(msg.sender, address(this), repaid);
        _reduceDebt(account, repaid);
        a.collateralShares -= seized;
        totalCollateralShares -= seized;

        uint256 written;
        if (a.collateralShares == 0) {
            written = debtOf(account);
            if (written != 0) {
                _reduceDebt(account, written);
                badDebt += written;
                // Part of the written-off debt is interest already booked as reserves. Writing reserves
                // down first keeps them backed, so `claimReserves` can never pay out lender deposits.
                reserves -= Math.min(reserves, written);
            }
        }
        IERC20(address(vault)).safeTransfer(receiver, seized);
        emit Liquidated(msg.sender, account, repaid, seized, written);
    }

    function _reduceDebt(address account, uint256 amount) private {
        Account storage a = accounts[account];
        uint256 scaled = Math.mulDiv(amount, WAD, borrowIndex);
        if (amount >= debtOf(account) || scaled >= a.debtScaled) {
            a.debtScaled = 0;
        } else {
            a.debtScaled -= scaled;
        }
        totalDebt = totalDebt > amount ? totalDebt - amount : 0;
    }

    function _requireWithinLtv(address account) private view {
        if (!vault.priceFresh()) revert StalePrice();
        uint256 limit = Math.mulDiv(collateralValue(account), risk.ltvBps, BPS);
        if (debtOf(account) > limit) revert Unhealthy();
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function claimReserves() external nonReentrant {
        accrue();
        uint256 amount = Math.min(reserves, cash());
        if (amount == 0) revert ZeroAmount();
        reserves -= amount;
        IERC20(asset()).safeTransfer(feeRouter, amount);
        emit ReservesClaimed(amount);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setRiskParams(RiskParams calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        accrue();
        _setRisk(p);
    }

    function setRateModel(RateModel calldata m) external onlyRole(DEFAULT_ADMIN_ROLE) {
        accrue();
        _setRates(m);
    }

    function setCaps(uint256 supplyCap_, uint256 borrowCap_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        supplyCap = supplyCap_;
        borrowCap = borrowCap_;
        emit CapsSet(supplyCap_, borrowCap_);
    }

    function lowerCaps(uint256 supplyCap_, uint256 borrowCap_) external onlyRole(GUARDIAN_ROLE) {
        if (supplyCap_ > supplyCap || borrowCap_ > borrowCap) revert InvalidConfig();
        supplyCap = supplyCap_;
        borrowCap = borrowCap_;
        emit CapsSet(supplyCap_, borrowCap_);
    }

    function _setRisk(RiskParams memory p) private {
        if (
            p.ltvBps == 0 || p.ltvBps >= p.liquidationThresholdBps || p.liquidationThresholdBps > 9_000
                || uint256(p.liquidationThresholdBps) * (BPS + p.liquidationBonusBps) >= BPS * BPS
                || p.closeFactorBps == 0 || p.closeFactorBps > BPS || p.maxCollateralShareBps > BPS
                || p.reserveFactorBps > 5_000
        ) revert InvalidConfig();
        risk = p;
        emit RiskParamsSet(p);
    }

    function _setRates(RateModel memory m) private {
        if (m.kinkUtilization == 0 || m.kinkUtilization >= WAD) revert InvalidConfig();
        rates = m;
        emit RateModelSet(m);
    }
}

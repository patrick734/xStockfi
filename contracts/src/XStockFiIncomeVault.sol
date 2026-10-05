// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {XStockFiOptions} from "./XStockFiOptions.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title XStockFiIncomeVault
/// @notice Deposit USDG and earn option premiums on one Stock Token. The vault runs the wheel through the
///         xStockFi options desk, in rounds that each end on a single expiry:
///         - holding USDG, it sells cash-secured puts below the market;
///         - holding Stock Tokens (after a put was exercised), it sells covered calls above the market, or the
///           keeper sells the tokens back to USDG between rounds.
///         Premiums are paid to the vault the moment an option is bought.
///
///         Exits are always a pro-rata share of what the vault holds (USDG, and Stock Tokens if a put was
///         exercised), so they never need a price. Between rounds they pay out at once; during a round they are
///         queued and paid when it closes. Deposits mint shares at once only between rounds while the vault holds
///         nothing but USDG. Otherwise they are queued and priced later: by anyone at a close while the vault holds
///         only USDG, and by the keeper while it holds Stock Tokens, which are then marked up by `entrySpreadBps`
///         so that a feed lagging the market cannot be used to buy in cheaply. A queued deposit can be taken back
///         until its round expires. Once a round has expired anyone can close it, so exits never depend on the
///         keeper.
///
/// @dev The keeper picks strikes, sizes and premiums inside limits enforced here: strikes at least
///      `minOtmBps` out of the money against Chainlink, a premium of at least `minPremiumBps` of the
///      collateral, at most `maxCommitBps` of the vault committed, and each offer buyable only for a short
///      window and only while the price stays within `quoteBandBps` of where it was quoted.
contract XStockFiIncomeVault is ERC20, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint256 public constant MAX_OPTIONS_PER_ROUND = 20;
    uint256 private constant BPS = 10_000;
    /// @dev Virtual shares: 1 USDG base unit starts at 1e12 shares (18-decimal shares over 6-decimal USDG),
    ///      and the offset makes donation attacks on the share price unprofitable.
    uint256 private constant OFFSET = 1e12;

    struct Limits {
        uint16 minOtmBps;
        uint16 minPremiumBps;
        uint16 maxCommitBps;
        uint16 quoteBandBps;
        uint16 maxSwapLossBps;
        uint16 entrySpreadBps;
        uint32 maxBuyWindow;
        uint32 minRound;
        uint32 maxRound;
    }

    struct Pending {
        uint128 amount;
        uint64 epoch;
    }

    struct Queued {
        uint128 shares;
        uint64 round;
    }

    struct Exit {
        uint128 shares;
        uint128 usdg;
        uint128 stock;
    }

    IERC20 public immutable usdg;
    IERC20 public immutable stock;
    XStockFiOptions public immutable desk;
    IPriceOracle public immutable oracle;
    ISwapAdapter public immutable swapAdapter;
    uint256 private immutable stockUnit;

    Limits public limits;
    uint256 public depositCap;

    uint64 public round;
    bool public live;
    uint40 public roundExpiry;
    uint256 public roundStartValue;
    uint256 public committed;
    uint256[] private _roundOptions;
    mapping(uint256 optionId => uint256) private _exposure;

    uint64 public depositEpoch;
    uint256 public pendingUsdg;
    uint256 public unclaimedShares;
    mapping(address account => Pending) public pendingOf;
    mapping(uint64 epoch => uint256[2]) private _epochPrice;

    uint256 public queuedShares;
    uint256 public reservedUsdg;
    uint256 public reservedStock;
    mapping(address account => uint256[2]) private _owed;
    mapping(address account => Queued) public queuedOf;
    mapping(uint64 round => Exit) public exits;

    event Deposited(address indexed account, uint256 amount, uint256 shares);
    event DepositQueued(address indexed account, uint256 amount, uint64 epoch);
    event DepositCancelled(address indexed account, uint256 amount);
    event DepositsPriced(uint64 indexed epoch, uint256 amount, uint256 shares);
    event Withdrawn(address indexed account, uint256 shares, uint256 usdgOut, uint256 stockOut);
    event ExitQueued(address indexed account, uint256 shares, uint64 round);
    event ExitCancelled(address indexed account, uint256 shares);
    event Claimed(address indexed account, uint256 shares, uint256 usdgOut, uint256 stockOut);
    event Owed(address indexed account, address indexed token, uint256 amount);
    event RoundStarted(uint64 indexed round, uint256 expiry, uint256 value);
    event OptionSold(uint64 indexed round, uint256 indexed optionId, uint8 kind, uint256 strike, uint256 size, uint256 premium);
    event RoundClosed(uint64 indexed round, uint256 exitShares, uint256 exitUsdg, uint256 exitStock);
    event StockSold(uint256 amountIn, uint256 usdgOut);
    event LimitsSet(Limits limits);
    event DepositCapSet(uint256 cap);

    error InvalidConfig();
    error ZeroAmount();
    error CapExceeded();
    error RoundLive();
    error NoRound();
    error OutsideLimits();
    error NotSettled(uint256 optionId);
    error TooEarly();
    error NothingToCancel();
    error TooLate();
    error NothingOwed();
    error SwapLoss(uint256 received, uint256 minimum);

    struct Config {
        IERC20 usdg;
        IERC20 stock;
        XStockFiOptions desk;
        IPriceOracle oracle;
        ISwapAdapter swapAdapter;
        address admin;
        address guardian;
        address keeper;
        uint256 depositCap;
        Limits limits;
    }

    constructor(Config memory c, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (
            address(c.usdg) == address(0) || address(c.stock) == address(0) || address(c.desk) == address(0)
                || address(c.oracle) == address(0) || address(c.swapAdapter) == address(0) || c.admin == address(0)
                || c.guardian == address(0) || c.keeper == address(0) || c.guardian == c.admin
                || c.desk.usdg() != c.usdg
        ) revert InvalidConfig();
        usdg = c.usdg;
        stock = c.stock;
        desk = c.desk;
        oracle = c.oracle;
        swapAdapter = c.swapAdapter;
        stockUnit = 10 ** IERC20Metadata(address(c.stock)).decimals();
        depositCap = c.depositCap;
        _setLimits(c.limits);
        _grantRole(DEFAULT_ADMIN_ROLE, c.admin);
        _grantRole(GUARDIAN_ROLE, c.guardian);
        _grantRole(KEEPER_ROLE, c.keeper);
        c.usdg.forceApprove(address(c.desk), type(uint256).max);
        c.stock.forceApprove(address(c.desk), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                               ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    /// @notice USDG that belongs to current shares: excludes queued deposits and what exited shares are owed.
    ///         Includes anything the desk is holding for the vault because a transfer to it failed.
    function freeUsdg() public view returns (uint256) {
        return _held(usdg) - pendingUsdg - reservedUsdg;
    }

    function freeStock() public view returns (uint256) {
        return _held(stock) - reservedStock;
    }

    function _held(IERC20 token) private view returns (uint256) {
        return token.balanceOf(address(this)) + desk.owed(address(token), address(this));
    }

    /// @notice Value behind the shares between rounds, in USDG. During a round collateral sits on the desk, so
    ///         this undercounts; `roundStartValue` is the figure for the round. Reverts if Stock Tokens are held
    ///         and the price is stale.
    function totalValue() public view returns (uint256) {
        uint256 s = freeStock();
        return freeUsdg() + (s == 0 ? 0 : oracle.usdgValue(address(stock), s));
    }

    /// @notice True when the vault can put a price on its holdings right now.
    function priced() public view returns (bool) {
        return freeStock() == 0 || oracle.isFresh(address(stock));
    }

    /// @notice Shares a deposit of `amount` would get between rounds.
    function previewDeposit(uint256 amount) external view returns (uint256) {
        return Math.mulDiv(amount, totalSupply() + OFFSET, totalValue() + 1);
    }

    /// @notice USDG and Stock Tokens `shares` would get between rounds.
    function previewWithdraw(uint256 shares) public view returns (uint256 usdgOut, uint256 stockOut) {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);
        usdgOut = Math.mulDiv(freeUsdg(), shares, supply);
        stockOut = Math.mulDiv(freeStock(), shares, supply);
    }

    function roundOptions() external view returns (uint256[] memory) {
        return _roundOptions;
    }

    /// @notice Shares a queued deposit has turned into, and what a queued exit is owed, ready to claim.
    function claimable(address account)
        public
        view
        returns (uint256 shares, uint256 usdgOut, uint256 stockOut)
    {
        Pending memory p = pendingOf[account];
        if (p.amount != 0 && p.epoch < depositEpoch) {
            uint256[2] memory px = _epochPrice[p.epoch];
            shares = Math.mulDiv(p.amount, px[1], px[0]);
        }
        Queued memory q = queuedOf[account];
        if (q.shares != 0 && q.round < round) {
            Exit memory e = exits[q.round];
            usdgOut = Math.mulDiv(e.usdg, q.shares, e.shares);
            stockOut = Math.mulDiv(e.stock, q.shares, e.shares);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HOLDERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposits USDG. Between rounds, while the vault holds only USDG, shares are minted at once;
    ///         otherwise the deposit waits to be priced at the next close and can be cancelled until its round
    ///         expires.
    function deposit(uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        _claim(msg.sender);

        if (!live && freeStock() == 0) {
            uint256 value = freeUsdg();
            if (value + pendingUsdg + amount > depositCap) revert CapExceeded();
            shares = Math.mulDiv(amount, totalSupply() + OFFSET, value + 1);
            if (shares == 0) revert ZeroAmount();
            usdg.safeTransferFrom(msg.sender, address(this), amount);
            _mint(msg.sender, shares);
            emit Deposited(msg.sender, amount, shares);
            return shares;
        }

        if (roundStartValue + pendingUsdg + amount > depositCap) revert CapExceeded();
        Pending storage p = pendingOf[msg.sender];
        p.amount += amount.toUint128();
        p.epoch = depositEpoch;
        pendingUsdg += amount;
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit DepositQueued(msg.sender, amount, depositEpoch);
    }

    function cancelDeposit() external nonReentrant {
        Pending memory p = pendingOf[msg.sender];
        if (p.amount == 0 || p.epoch < depositEpoch) revert NothingToCancel();
        if (live && block.timestamp >= roundExpiry) revert TooLate();
        delete pendingOf[msg.sender];
        pendingUsdg -= p.amount;
        usdg.safeTransfer(msg.sender, p.amount);
        emit DepositCancelled(msg.sender, p.amount);
    }

    /// @notice Exits `shares`. Between rounds this pays out at once, pro rata in USDG and any Stock Tokens held;
    ///         during a round the shares are queued and paid when it closes. Works while paused.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 usdgOut, uint256 stockOut) {
        if (shares == 0) revert ZeroAmount();
        _claim(msg.sender);

        if (!live) {
            (usdgOut, stockOut) = previewWithdraw(shares);
            _burn(msg.sender, shares);
            reservedUsdg += usdgOut;
            reservedStock += stockOut;
            _deliver(msg.sender, usdgOut, stockOut);
            emit Withdrawn(msg.sender, shares, usdgOut, stockOut);
            return (usdgOut, stockOut);
        }

        _transfer(msg.sender, address(this), shares);
        Queued storage q = queuedOf[msg.sender];
        q.shares += shares.toUint128();
        q.round = round;
        queuedShares += shares;
        emit ExitQueued(msg.sender, shares, round);
    }

    function cancelWithdraw() external nonReentrant {
        Queued memory q = queuedOf[msg.sender];
        if (q.shares == 0 || q.round < round) revert NothingToCancel();
        delete queuedOf[msg.sender];
        queuedShares -= q.shares;
        _transfer(address(this), msg.sender, q.shares);
        emit ExitCancelled(msg.sender, q.shares);
    }

    /// @notice Delivers the shares of a deposit and the payout of an exit once their round has closed.
    function claim() external nonReentrant {
        _claim(msg.sender);
    }

    /// @notice Prices deposits waiting between rounds, for example because the price was stale at the close.
    function processDeposits() external onlyRole(KEEPER_ROLE) nonReentrant {
        if (live) revert RoundLive();
        _priceDeposits();
    }

    function _claim(address account) private {
        uint256 shares;
        uint256 usdgOut;
        uint256 stockOut;

        Pending memory p = pendingOf[account];
        if (p.amount != 0 && p.epoch < depositEpoch) {
            uint256[2] memory px = _epochPrice[p.epoch];
            shares = Math.min(Math.mulDiv(p.amount, px[1], px[0]), unclaimedShares);
            delete pendingOf[account];
            unclaimedShares -= shares;
            _transfer(address(this), account, shares);
        }

        Queued memory q = queuedOf[account];
        if (q.shares != 0 && q.round < round) {
            Exit memory e = exits[q.round];
            usdgOut = Math.mulDiv(e.usdg, q.shares, e.shares);
            stockOut = Math.mulDiv(e.stock, q.shares, e.shares);
            delete queuedOf[account];
            _deliver(account, usdgOut, stockOut);
        }

        if (shares != 0 || usdgOut != 0 || stockOut != 0) emit Claimed(account, shares, usdgOut, stockOut);
    }

    /// @dev Pays out amounts already counted in the reserves. A transfer the token refuses stays reserved and is
    ///      booked to the account, so one frozen asset never holds up the other or anyone else's exit.
    function _deliver(address account, uint256 usdgOut, uint256 stockOut) private {
        if (usdgOut != 0) {
            if (Payouts.tryTransfer(usdg, account, usdgOut)) reservedUsdg -= usdgOut;
            else _book(account, 0, usdgOut);
        }
        if (stockOut != 0) {
            if (Payouts.tryTransfer(stock, account, stockOut)) reservedStock -= stockOut;
            else _book(account, 1, stockOut);
        }
    }

    function _book(address account, uint256 i, uint256 amount) private {
        _owed[account][i] += amount;
        emit Owed(account, i == 0 ? address(usdg) : address(stock), amount);
    }

    /// @notice USDG and Stock Tokens that could not be delivered to `account` when they were due.
    function owed(address account) external view returns (uint256 usdgOwed, uint256 stockOwed) {
        return (_owed[account][0], _owed[account][1]);
    }

    /// @notice Retries a payout that could not be delivered earlier.
    function claimOwed() external nonReentrant {
        (uint256 u, uint256 s) = (_owed[msg.sender][0], _owed[msg.sender][1]);
        if (u == 0 && s == 0) revert NothingOwed();
        delete _owed[msg.sender];
        if (u != 0) {
            reservedUsdg -= u;
            usdg.safeTransfer(msg.sender, u);
        }
        if (s != 0) {
            reservedStock -= s;
            stock.safeTransfer(msg.sender, s);
        }
        emit Claimed(msg.sender, 0, u, s);
    }

    /*//////////////////////////////////////////////////////////////
                                 KEEPER
    //////////////////////////////////////////////////////////////*/

    function startRound(uint256 expiry) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        if (live) revert RoundLive();
        Limits memory l = limits;
        if (expiry < block.timestamp + l.minRound || expiry > block.timestamp + l.maxRound) revert OutsideLimits();
        if (pendingUsdg != 0) _priceDeposits();
        uint256 value = totalValue();
        live = true;
        roundExpiry = uint40(expiry);
        roundStartValue = value;
        committed = 0;
        emit RoundStarted(round, expiry, value);
    }

    /// @notice Offers a cash-secured put from free USDG.
    function sellPut(uint256 strike, uint256 size, uint256 premium, uint256 buyWindow)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        uint256 spot = _openForSales();
        Limits memory l = limits;
        if (strike * BPS > spot * (BPS - l.minOtmBps)) revert OutsideLimits();
        uint256 collateral = Math.mulDiv(size, strike, stockUnit, Math.Rounding.Ceil);
        if (collateral == 0 || collateral > freeUsdg()) revert OutsideLimits();
        _commit(collateral, premium, l);
        id = _offer(desk.PUT(), strike, size, premium, buyWindow, spot, l);
        _exposure[id] = collateral;
    }

    /// @notice Offers a covered call from free Stock Tokens.
    function sellCall(uint256 strike, uint256 size, uint256 premium, uint256 buyWindow)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        uint256 spot = _openForSales();
        Limits memory l = limits;
        if (strike * BPS < spot * (BPS + l.minOtmBps)) revert OutsideLimits();
        if (size == 0 || size > freeStock()) revert OutsideLimits();
        uint256 exposure = Math.mulDiv(size, spot, stockUnit);
        _commit(exposure, premium, l);
        id = _offer(desk.CALL(), strike, size, premium, buyWindow, spot, l);
        _exposure[id] = exposure;
    }

    /// @notice Withdraws an unsold offer of this round, for example after the market moved, and frees its share
    ///         of the commitment limit for a new quote.
    function withdrawOffer(uint256 id) external onlyRole(KEEPER_ROLE) nonReentrant {
        if (!live || !_inRound(id)) revert OutsideLimits();
        desk.cancel(id);
        committed -= Math.min(committed, _exposure[id]);
    }

    /// @notice Sells Stock Tokens back to USDG between rounds, at no worse than `maxSwapLossBps` under Chainlink.
    function sellStock(uint256 amount, bytes calldata route)
        external
        onlyRole(KEEPER_ROLE)
        nonReentrant
        returns (uint256 received)
    {
        if (live) revert RoundLive();
        if (amount == 0 || amount > freeStock()) revert OutsideLimits();
        uint256 minOut = Math.mulDiv(oracle.usdgValue(address(stock), amount), BPS - limits.maxSwapLossBps, BPS);
        uint256 before = usdg.balanceOf(address(this));
        stock.forceApprove(address(swapAdapter), amount);
        swapAdapter.swap(address(stock), address(usdg), amount, minOut, address(this), route);
        stock.forceApprove(address(swapAdapter), 0);
        received = usdg.balanceOf(address(this)) - before;
        if (received < minOut) revert SwapLoss(received, minOut);
        emit StockSold(amount, received);
    }

    /// @notice Ends the round once every option in it is settled: expires what ran out, takes back unsold offers
    ///         whose buying window has closed, pays queued exits and prices queued deposits. Anyone can call
    ///         once the round has expired; the keeper can close earlier when nothing is left open.
    function closeRound() external nonReentrant {
        if (!live) revert NoRound();
        bool early = block.timestamp < roundExpiry;
        if (early && !hasRole(KEEPER_ROLE, msg.sender)) revert TooEarly();

        uint256[] memory ids = _roundOptions;
        for (uint256 i; i < ids.length; ++i) {
            XStockFiOptions.Option memory o = desk.get(ids[i]);
            if (o.state == XStockFiOptions.State.Offered) {
                if (block.timestamp < o.buyBy && !hasRole(KEEPER_ROLE, msg.sender)) revert NotSettled(ids[i]);
                desk.cancel(ids[i]);
            } else if (o.state == XStockFiOptions.State.Active) {
                if (block.timestamp < o.expiry) revert NotSettled(ids[i]);
                desk.expire(ids[i]);
            }
        }
        _collectOwed();

        uint64 r = round;
        uint256 q = queuedShares;
        uint256 outUsdg;
        uint256 outStock;
        if (q != 0) {
            uint256 supply = totalSupply();
            outUsdg = Math.mulDiv(freeUsdg(), q, supply);
            outStock = Math.mulDiv(freeStock(), q, supply);
            exits[r] = Exit(q.toUint128(), outUsdg.toUint128(), outStock.toUint128());
            reservedUsdg += outUsdg;
            reservedStock += outStock;
            queuedShares = 0;
            _burn(address(this), q);
        }

        delete _roundOptions;
        live = false;
        roundExpiry = 0;
        committed = 0;
        round = r + 1;
        emit RoundClosed(r, q, outUsdg, outStock);

        // With Stock Tokens on hand the price comes from Chainlink, so only the keeper picks that moment.
        if (pendingUsdg != 0 && (freeStock() == 0 || (hasRole(KEEPER_ROLE, msg.sender) && priced()))) {
            _priceDeposits();
        }
    }

    /// @notice Pulls any payment the desk could not deliver to the vault. Anyone can call.
    function collectOwed() external nonReentrant {
        _collectOwed();
    }

    function _openForSales() private view returns (uint256 spot) {
        if (!live) revert NoRound();
        if (block.timestamp + desk.MIN_LIFE() > roundExpiry || _roundOptions.length >= MAX_OPTIONS_PER_ROUND) {
            revert OutsideLimits();
        }
        spot = oracle.usdgValue(address(stock), stockUnit);
    }

    function _commit(uint256 exposure, uint256 premium, Limits memory l) private {
        if (premium * BPS < exposure * l.minPremiumBps) revert OutsideLimits();
        committed += exposure;
        if (committed * BPS > roundStartValue * l.maxCommitBps) revert OutsideLimits();
    }

    function _offer(
        uint8 kind,
        uint256 strike,
        uint256 size,
        uint256 premium,
        uint256 buyWindow,
        uint256 spot,
        Limits memory l
    ) private returns (uint256 id) {
        if (buyWindow == 0 || buyWindow > l.maxBuyWindow) revert OutsideLimits();
        uint256 buyBy = Math.min(block.timestamp + buyWindow, roundExpiry);
        uint256 band = Math.mulDiv(spot, l.quoteBandBps, BPS);
        id = desk.write(kind, address(stock), size, strike, premium, roundExpiry, buyBy, spot - band, spot + band);
        _roundOptions.push(id);
        emit OptionSold(round, id, kind, strike, size, premium);
    }

    function _inRound(uint256 id) private view returns (bool) {
        uint256[] storage ids = _roundOptions;
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == id) return true;
        }
        return false;
    }

    function _priceDeposits() private {
        uint256 amount = pendingUsdg;
        if (amount == 0) return;
        uint256 held = freeStock();
        uint256 value = freeUsdg();
        if (held != 0) {
            value += Math.mulDiv(oracle.usdgValue(address(stock), held), BPS + limits.entrySpreadBps, BPS);
        }
        uint256 supply = totalSupply();
        uint64 e = depositEpoch;
        _epochPrice[e] = [value + 1, supply + OFFSET];
        uint256 shares = Math.mulDiv(amount, supply + OFFSET, value + 1);
        pendingUsdg = 0;
        depositEpoch = e + 1;
        unclaimedShares += shares;
        _mint(address(this), shares);
        emit DepositsPriced(e, amount, shares);
    }

    /// @dev Best effort: a token that still refuses the transfer must not hold up the close.
    function _collectOwed() private {
        if (desk.owed(address(usdg), address(this)) != 0) try desk.claim(usdg) {} catch {}
        if (desk.owed(address(stock), address(this)) != 0) try desk.claim(stock) {} catch {}
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

    function setDepositCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function lowerDepositCap(uint256 cap) external onlyRole(GUARDIAN_ROLE) {
        if (cap > depositCap) revert InvalidConfig();
        depositCap = cap;
        emit DepositCapSet(cap);
    }

    function setLimits(Limits calldata l) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setLimits(l);
    }

    function _setLimits(Limits memory l) private {
        if (
            l.minOtmBps < 50 || l.minOtmBps > 5_000 || l.minPremiumBps < 5 || l.maxCommitBps == 0
                || l.maxCommitBps > 9_000 || l.quoteBandBps == 0 || l.quoteBandBps > 300 || l.maxSwapLossBps == 0
                || l.maxSwapLossBps > 300 || l.entrySpreadBps > 500 || l.maxBuyWindow == 0 || l.maxBuyWindow > 1 days || l.minRound < 12 hours
                || l.maxRound < l.minRound || l.maxRound > 35 days
        ) revert InvalidConfig();
        limits = l;
        emit LimitsSet(l);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title XStockFiOptions
/// @notice Peer-to-peer covered calls and cash-secured puts on Stock Tokens, priced and paid in USDG.
///
///         A writer locks the full collateral up front: the Stock Tokens for a call, strike x size in USDG for
///         a put. Anyone can then buy the option for the writer's premium. Until expiry the holder may
///         exercise: a call pays the strike in USDG and receives the tokens, a put delivers the tokens and
///         receives the USDG. Settlement is physical and needs no price feed, so no oracle can move anyone's
///         collateral. The oracle is only consulted when a writer limits the price range in which the
///         option may be bought, which protects a quote from going stale.
///
/// @dev Strikes are USDG per whole token (10**decimals). Robinhood's Chainlink feeds price the raw token
///      including its split multiplier, so strikes stay comparable to the feed across corporate actions.
///      The guardian can pause new writes and purchases; exercising, expiring and cancelling never pause.
contract XStockFiOptions is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint8 public constant CALL = 0;
    uint8 public constant PUT = 1;

    uint16 public constant MAX_FEE_BPS = 300;
    uint32 public constant MIN_LIFE = 1 hours;
    uint32 public constant MAX_LIFE = 180 days;

    enum State {
        None,
        Offered,
        Active,
        Exercised,
        Expired,
        Cancelled
    }

    struct Option {
        address writer;
        uint40 expiry;
        uint40 buyBy;
        uint8 kind;
        State state;
        address holder;
        uint16 feeBps;
        address token;
        uint128 size;
        uint128 strike;
        uint128 premium;
        uint128 collateral;
        uint128 minPrice;
        uint128 maxPrice;
    }

    struct Market {
        bool listed;
        bool known;
        uint8 decimals;
    }

    IERC20 public immutable usdg;
    IPriceOracle public immutable oracle;
    address public immutable feeRouter;

    uint16 public feeBps = 100;
    uint256 public minNotional;

    mapping(address token => Market) public markets;
    address[] private _tokens;

    Option[] private _options;
    mapping(address account => uint256[]) private _ids;
    mapping(address token => mapping(address account => uint256)) public owed;

    event MarketSet(address indexed token, bool listed);
    event FeeSet(uint16 feeBps);
    event MinNotionalSet(uint256 minNotional);
    event Written(
        uint256 indexed id,
        address indexed writer,
        address indexed token,
        uint8 kind,
        uint256 size,
        uint256 strike,
        uint256 premium,
        uint256 expiry,
        uint256 buyBy
    );
    event Bought(uint256 indexed id, address indexed holder, uint256 premium, uint256 fee);
    event Exercised(uint256 indexed id, address indexed holder);
    event Expired(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event Transferred(uint256 indexed id, address indexed from, address indexed to);
    event Owed(address indexed token, address indexed account, uint256 amount);
    event Claimed(address indexed token, address indexed account, uint256 amount);

    error InvalidConfig();
    error BadTerms();
    error UnknownMarket();
    error UnknownOption();
    error WrongState();
    error NotAllowed();
    error TooLate();
    error TooEarly();
    error OutsideBand(uint256 price);
    error ShortTransfer();
    error NothingOwed();

    constructor(IERC20 usdg_, IPriceOracle oracle_, address feeRouter_, address admin, address guardian, uint256 minNotional_) {
        if (
            address(usdg_) == address(0) || address(oracle_) == address(0) || feeRouter_ == address(0)
                || admin == address(0) || guardian == address(0)
        ) revert InvalidConfig();
        usdg = usdg_;
        oracle = oracle_;
        feeRouter = feeRouter_;
        minNotional = minNotional_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /*//////////////////////////////////////////////////////////////
                                WRITERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Offers an option for sale and locks its collateral.
    /// @param size Stock Token amount, in the token's own units.
    /// @param strike USDG per whole token.
    /// @param premium Total USDG the buyer pays, of which the fee goes to the protocol.
    /// @param buyBy Last moment it can be bought; zero means until expiry.
    /// @param minPrice Lowest oracle price at which it can be bought; zero for no limit.
    /// @param maxPrice Highest oracle price at which it can be bought; zero for no limit.
    function write(
        uint8 kind,
        address token,
        uint256 size,
        uint256 strike,
        uint256 premium,
        uint256 expiry,
        uint256 buyBy,
        uint256 minPrice,
        uint256 maxPrice
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        Market memory m = markets[token];
        if (!m.listed) revert UnknownMarket();
        if (buyBy == 0) buyBy = expiry;
        if (
            kind > PUT || size == 0 || strike == 0 || premium == 0 || expiry < block.timestamp + MIN_LIFE
                || expiry > block.timestamp + MAX_LIFE || buyBy <= block.timestamp || buyBy > expiry
                || (maxPrice != 0 && minPrice > maxPrice)
        ) revert BadTerms();

        uint256 notional = Math.mulDiv(size, strike, 10 ** m.decimals, Math.Rounding.Ceil);
        if (notional < minNotional) revert BadTerms();
        uint256 collateral = kind == CALL ? size : notional;

        id = _options.length;
        _options.push(
            Option({
                writer: msg.sender,
                expiry: uint40(expiry),
                buyBy: uint40(buyBy),
                kind: kind,
                state: State.Offered,
                holder: address(0),
                feeBps: feeBps,
                token: token,
                size: size.toUint128(),
                strike: strike.toUint128(),
                premium: premium.toUint128(),
                collateral: collateral.toUint128(),
                minPrice: minPrice.toUint128(),
                maxPrice: maxPrice.toUint128()
            })
        );
        _ids[msg.sender].push(id);

        _pullExact(kind == CALL ? IERC20(token) : usdg, msg.sender, collateral);
        emit Written(id, msg.sender, token, kind, size, strike, premium, expiry, buyBy);
    }

    /// @notice Takes an unsold offer off the market and returns its collateral.
    function cancel(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (o.state != State.Offered) revert WrongState();
        if (msg.sender != o.writer) revert NotAllowed();
        o.state = State.Cancelled;
        _pay(_collateralToken(o), o.writer, o.collateral);
        emit Cancelled(id);
    }

    /*//////////////////////////////////////////////////////////////
                                HOLDERS
    //////////////////////////////////////////////////////////////*/

    function buy(uint256 id) external nonReentrant whenNotPaused {
        Option storage o = _get(id);
        if (o.state != State.Offered) revert WrongState();
        if (block.timestamp >= o.buyBy) revert TooLate();
        if (msg.sender == o.writer) revert NotAllowed();
        if (o.minPrice != 0 || o.maxPrice != 0) _checkBand(o);

        o.state = State.Active;
        o.holder = msg.sender;
        _ids[msg.sender].push(id);

        uint256 premium = o.premium;
        uint256 fee = Math.mulDiv(premium, o.feeBps, 10_000);
        _pullExact(usdg, msg.sender, premium);
        if (fee != 0) usdg.safeTransfer(feeRouter, fee);
        _pay(usdg, o.writer, premium - fee);
        emit Bought(id, msg.sender, premium, fee);
    }

    /// @notice Exercises before expiry. A call pays the strike value in USDG for the tokens; a put hands over
    ///         the tokens for the locked USDG. Approve the contract for what you pay in first.
    function exercise(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (o.state != State.Active) revert WrongState();
        if (msg.sender != o.holder) revert NotAllowed();
        if (block.timestamp >= o.expiry) revert TooLate();
        o.state = State.Exercised;

        IERC20 stock = IERC20(o.token);
        if (o.kind == CALL) {
            uint256 due = Math.mulDiv(o.size, o.strike, 10 ** markets[o.token].decimals, Math.Rounding.Ceil);
            _pullExact(usdg, msg.sender, due);
            _pay(usdg, o.writer, due);
            _pay(stock, msg.sender, o.size);
        } else {
            _pullExact(stock, msg.sender, o.size);
            _pay(stock, o.writer, o.size);
            _pay(usdg, msg.sender, o.collateral);
        }
        emit Exercised(id, msg.sender);
    }

    /// @notice After expiry anyone can return the collateral of an option that was not exercised, or of an
    ///         offer nobody bought.
    function expire(uint256 id) external nonReentrant {
        Option storage o = _get(id);
        if (block.timestamp < o.expiry) revert TooEarly();
        if (o.state == State.Active) {
            o.state = State.Expired;
            emit Expired(id);
        } else if (o.state == State.Offered) {
            o.state = State.Cancelled;
            emit Cancelled(id);
        } else {
            revert WrongState();
        }
        _pay(_collateralToken(o), o.writer, o.collateral);
    }

    function transfer(uint256 id, address to) external {
        Option storage o = _get(id);
        if (o.state != State.Active) revert WrongState();
        if (msg.sender != o.holder) revert NotAllowed();
        if (to == address(0) || to == msg.sender) revert BadTerms();
        o.holder = to;
        _ids[to].push(id);
        emit Transferred(id, msg.sender, to);
    }

    /// @notice Collects a payment that could not be delivered when it was due.
    function claim(IERC20 token) external nonReentrant {
        uint256 amount = owed[address(token)][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[address(token)][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(address(token), msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function count() external view returns (uint256) {
        return _options.length;
    }

    function get(uint256 id) external view returns (Option memory) {
        return _get(id);
    }

    /// @notice Options `from` up to, not including, `to` (clamped to the count).
    function list(uint256 from, uint256 to) external view returns (Option[] memory out) {
        if (to > _options.length) to = _options.length;
        if (from >= to) return out;
        out = new Option[](to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = _options[from + i];
        }
    }

    /// @notice Every option the account has written, bought or received. Entries can repeat and include
    ///         options the account no longer holds; check `get` for the current holder.
    function idsOf(address account) external view returns (uint256[] memory) {
        return _ids[account];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice USDG a call holder pays on exercise, or a put holder receives.
    function strikeValue(uint256 id) external view returns (uint256) {
        Option storage o = _get(id);
        return Math.mulDiv(o.size, o.strike, 10 ** markets[o.token].decimals, Math.Rounding.Ceil);
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setMarket(address token, bool listed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0) || token == address(usdg)) revert InvalidConfig();
        Market storage m = markets[token];
        if (!m.known) {
            m.known = true;
            m.decimals = IERC20Metadata(token).decimals();
            _tokens.push(token);
        }
        m.listed = listed;
        emit MarketSet(token, listed);
    }

    /// @notice Applies to options written from now on; existing options keep the fee they were written with.
    function setFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidConfig();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setMinNotional(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minNotional = amount;
        emit MinNotionalSet(amount);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _get(uint256 id) private view returns (Option storage) {
        if (id >= _options.length) revert UnknownOption();
        return _options[id];
    }

    function _collateralToken(Option storage o) private view returns (IERC20) {
        return o.kind == CALL ? IERC20(o.token) : usdg;
    }

    function _checkBand(Option storage o) private view {
        uint256 price = oracle.usdgValue(o.token, 10 ** markets[o.token].decimals);
        if (price < o.minPrice || (o.maxPrice != 0 && price > o.maxPrice)) revert OutsideBand(price);
    }

    /// @dev Refuses tokens that deliver less than the amount sent, since collateral is booked at face value.
    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - before != amount) revert ShortTransfer();
    }

    function _pay(IERC20 token, address to, uint256 amount) private {
        if (amount == 0 || Payouts.tryTransfer(token, to, amount)) return;
        owed[address(token)][to] += amount;
        emit Owed(address(token), to, amount);
    }
}

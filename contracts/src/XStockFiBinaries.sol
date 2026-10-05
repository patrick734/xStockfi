// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ChainlinkRounds} from "./libraries/ChainlinkRounds.sol";
import {Payouts} from "./libraries/Payouts.sol";

/// @title XStockFiBinaries
/// @notice Peer-to-peer binary calls on Stock Token prices, staked in USDG.
///
///         A maker stakes on the price finishing above or below a strike at expiry. A taker matches the same
///         stake on the other side, up to the maker's join deadline (at most halfway to expiry). After expiry
///         the bet settles on the Chainlink price that was current at expiry and the winner takes both stakes,
///         less the fee. Every bet is fully funded by its two stakes, so the contract never owes more than it
///         holds and there is no house to drain.
///
///         Both stakes are refunded, with no fee, when the price lands exactly on the strike, when the last
///         update before expiry is older than MAX_PRICE_AGE, when expiry fell inside a recorded corporate action
///         on the token, or when nobody could settle for VOID_AFTER.
///
/// @dev Strikes are USD with 6 decimals. The feed is copied into the bet when it opens, so a later oracle
///      change cannot alter how an open bet settles.
contract XStockFiBinaries is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint8 public constant ABOVE = 0;
    uint8 public constant BELOW = 1;

    uint16 public constant MAX_FEE_BPS = 300;
    uint32 public constant MIN_LIFE = 15 minutes;
    uint32 public constant MAX_LIFE = 30 days;
    uint32 public constant MAX_PRICE_AGE = 4 days;
    uint32 public constant VOID_AFTER = 7 days;
    /// @notice Settlement waits this long after expiry, so a round reported a little late still counts.
    uint32 public constant SETTLE_DELAY = 5 minutes;

    enum State {
        None,
        Open,
        Matched,
        Settled,
        Void,
        Cancelled
    }

    struct Bet {
        address maker;
        uint40 expiry;
        uint40 joinBy;
        uint8 side;
        State state;
        address taker;
        uint16 feeBps;
        bool makerWon;
        address token;
        address feed;
        uint128 stake;
        uint128 strike;
        uint128 settlePrice;
    }

    IERC20 public immutable usdg;
    IPriceOracle public immutable oracle;
    address public immutable feeRouter;

    uint16 public feeBps = 100;
    uint256 public minStake;
    mapping(address token => bool) public listed;
    address[] private _tokens;

    Bet[] private _bets;
    mapping(address account => uint256[]) private _ids;
    mapping(address account => uint256) public owed;

    struct Window {
        uint40 start;
        uint40 end;
    }

    /// @notice Periods during which a token reported a corporate action (`oraclePaused`), as recorded by
    ///         `notePause` and `noteResume`. A bet expiring inside one is refunded rather than settled.
    mapping(address token => Window[]) private _pauses;

    event MarketSet(address indexed token, bool listed);
    event FeeSet(uint16 feeBps);
    event MinStakeSet(uint256 minStake);
    event Opened(
        uint256 indexed id, address indexed maker, address indexed token, uint8 side, uint256 strike, uint256 stake, uint256 expiry, uint256 joinBy
    );
    event Joined(uint256 indexed id, address indexed taker);
    event Settled(uint256 indexed id, address indexed winner, uint256 price, uint256 payout, uint256 fee);
    event Voided(uint256 indexed id);
    event Cancelled(uint256 indexed id);
    event Owed(address indexed account, uint256 amount);
    event PauseNoted(address indexed token, uint256 start);
    event ResumeNoted(address indexed token, uint256 end);
    event Claimed(address indexed account, uint256 amount);

    error InvalidConfig();
    error BadTerms();
    error UnknownMarket();
    error UnknownBet();
    error WrongState();
    error NotAllowed();
    error TooLate();
    error TooEarly();
    error CorporateAction();
    error NothingOwed();

    constructor(IERC20 usdg_, IPriceOracle oracle_, address feeRouter_, address admin, address guardian, uint256 minStake_) {
        if (
            address(usdg_) == address(0) || address(oracle_) == address(0) || feeRouter_ == address(0)
                || admin == address(0) || guardian == address(0)
        ) revert InvalidConfig();
        usdg = usdg_;
        oracle = oracle_;
        feeRouter = feeRouter_;
        minStake = minStake_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    /*//////////////////////////////////////////////////////////////
                                 BETS
    //////////////////////////////////////////////////////////////*/

    /// @param side ABOVE wins if the price at expiry is higher than `strike`, BELOW if it is lower.
    /// @param joinBy Last moment a taker can match; zero means halfway to expiry, which is also the limit.
    function open(address token, uint8 side, uint256 strike, uint256 stake, uint256 expiry, uint256 joinBy)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (!listed[token]) revert UnknownMarket();
        address feed = oracle.feedOf(token);
        if (feed == address(0) || !oracle.isFresh(token)) revert UnknownMarket();
        if (side > BELOW || strike == 0 || stake < minStake || stake == 0) revert BadTerms();
        if (expiry < block.timestamp + MIN_LIFE || expiry > block.timestamp + MAX_LIFE) revert BadTerms();
        uint256 halfway = block.timestamp + (expiry - block.timestamp) / 2;
        if (joinBy == 0) joinBy = halfway;
        if (joinBy <= block.timestamp || joinBy > halfway) revert BadTerms();

        id = _bets.length;
        _bets.push(
            Bet({
                maker: msg.sender,
                expiry: uint40(expiry),
                joinBy: uint40(joinBy),
                side: side,
                state: State.Open,
                taker: address(0),
                feeBps: feeBps,
                makerWon: false,
                token: token,
                feed: feed,
                stake: stake.toUint128(),
                strike: strike.toUint128(),
                settlePrice: 0
            })
        );
        _ids[msg.sender].push(id);
        usdg.safeTransferFrom(msg.sender, address(this), stake);
        emit Opened(id, msg.sender, token, side, strike, stake, expiry, joinBy);
    }

    function join(uint256 id) external nonReentrant whenNotPaused {
        Bet storage b = _get(id);
        if (b.state != State.Open) revert WrongState();
        if (block.timestamp >= b.joinBy) revert TooLate();
        if (msg.sender == b.maker) revert NotAllowed();
        b.state = State.Matched;
        b.taker = msg.sender;
        _ids[msg.sender].push(id);
        usdg.safeTransferFrom(msg.sender, address(this), b.stake);
        emit Joined(id, msg.sender);
    }

    /// @notice Refunds an unmatched bet. The maker can cancel at any time; once the join deadline has passed,
    ///         so can anyone.
    function cancel(uint256 id) external nonReentrant {
        Bet storage b = _get(id);
        if (b.state != State.Open) revert WrongState();
        if (msg.sender != b.maker && block.timestamp < b.joinBy) revert NotAllowed();
        b.state = State.Cancelled;
        _pay(b.maker, b.stake);
        emit Cancelled(id);
    }

    /// @notice Settles a matched bet after expiry. Anyone can call.
    /// @param roundHint The feed round that was current at expiry; zero if that is still the latest round.
    function settle(uint256 id, uint80 roundHint) external nonReentrant {
        Bet storage b = _get(id);
        if (b.state != State.Matched) revert WrongState();
        if (block.timestamp <= uint256(b.expiry) + SETTLE_DELAY) revert TooEarly();
        if (_corporateAction(b.token)) revert CorporateAction();
        if (_pausedAt(b.token, b.expiry)) return _void(id, b);

        (int256 answer, uint256 updatedAt) = ChainlinkRounds.at(AggregatorV3Interface(b.feed), b.expiry, roundHint);
        if (answer <= 0 || b.expiry - updatedAt > MAX_PRICE_AGE) return _void(id, b);

        uint256 price = _toUsd6(uint256(answer), AggregatorV3Interface(b.feed).decimals());
        if (price == b.strike) return _void(id, b);

        bool above = price > b.strike;
        bool makerWon = above == (b.side == ABOVE);
        address winner = makerWon ? b.maker : b.taker;
        uint256 pot = uint256(b.stake) * 2;
        uint256 fee = Math.mulDiv(pot, b.feeBps, 10_000);

        b.state = State.Settled;
        b.makerWon = makerWon;
        b.settlePrice = price.toUint128();
        if (fee != 0) usdg.safeTransfer(feeRouter, fee);
        _pay(winner, pot - fee);
        emit Settled(id, winner, price, pot - fee, fee);
    }

    /// @notice Refunds both sides of a matched bet nobody managed to settle within VOID_AFTER of expiry.
    function voidStale(uint256 id) external nonReentrant {
        Bet storage b = _get(id);
        if (b.state != State.Matched) revert WrongState();
        if (block.timestamp <= uint256(b.expiry) + VOID_AFTER) revert TooEarly();
        _void(id, b);
    }

    /// @notice Records that `token` is in a corporate action. Anyone can call while its flag is up; the keeper
    ///         does so every cycle.
    function notePause(address token) external {
        if (!_corporateAction(token)) revert WrongState();
        Window[] storage w = _pauses[token];
        if (w.length != 0 && w[w.length - 1].end == 0) return;
        w.push(Window(uint40(block.timestamp), 0));
        emit PauseNoted(token, block.timestamp);
    }

    /// @notice Closes the recorded corporate action once the token's flag is down.
    function noteResume(address token) external {
        if (_corporateAction(token)) revert WrongState();
        Window[] storage w = _pauses[token];
        if (w.length == 0 || w[w.length - 1].end != 0) revert WrongState();
        w[w.length - 1].end = uint40(block.timestamp);
        emit ResumeNoted(token, block.timestamp);
    }

    function pauses(address token) external view returns (Window[] memory) {
        return _pauses[token];
    }

    function claim() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function count() external view returns (uint256) {
        return _bets.length;
    }

    function get(uint256 id) external view returns (Bet memory) {
        return _get(id);
    }

    function list(uint256 from, uint256 to) external view returns (Bet[] memory out) {
        if (to > _bets.length) to = _bets.length;
        if (from >= to) return out;
        out = new Bet[](to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = _bets[from + i];
        }
    }

    function idsOf(address account) external view returns (uint256[] memory) {
        return _ids[account];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    /// @notice Current Chainlink price of `token` in USD with 6 decimals, the unit strikes use.
    function spot(address token) external view returns (uint256 price, uint256 updatedAt) {
        AggregatorV3Interface feed = AggregatorV3Interface(oracle.feedOf(token));
        if (address(feed) == address(0)) revert UnknownMarket();
        (, int256 answer,, uint256 at,) = feed.latestRoundData();
        if (answer <= 0) revert UnknownMarket();
        return (_toUsd6(uint256(answer), feed.decimals()), at);
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setMarket(address token, bool isListed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidConfig();
        if (isListed && !listed[token]) {
            bool seen;
            for (uint256 i; i < _tokens.length; ++i) {
                if (_tokens[i] == token) seen = true;
            }
            if (!seen) _tokens.push(token);
        }
        listed[token] = isListed;
        emit MarketSet(token, isListed);
    }

    function setFee(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_FEE_BPS) revert InvalidConfig();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setMinStake(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minStake = amount;
        emit MinStakeSet(amount);
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

    function _get(uint256 id) private view returns (Bet storage) {
        if (id >= _bets.length) revert UnknownBet();
        return _bets[id];
    }

    function _void(uint256 id, Bet storage b) private {
        b.state = State.Void;
        _pay(b.maker, b.stake);
        _pay(b.taker, b.stake);
        emit Voided(id);
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0 || Payouts.tryTransfer(usdg, to, amount)) return;
        owed[to] += amount;
        emit Owed(to, amount);
    }

    function _pausedAt(address token, uint256 t) private view returns (bool) {
        Window[] storage w = _pauses[token];
        for (uint256 i = w.length; i > 0; --i) {
            Window memory x = w[i - 1];
            if (x.start <= t && (x.end == 0 || x.end >= t)) return true;
            if (x.end != 0 && x.end < t) break;
        }
        return false;
    }

    function _toUsd6(uint256 answer, uint8 decimals) private pure returns (uint256) {
        return decimals >= 6 ? answer / 10 ** (decimals - 6) : answer * 10 ** (6 - decimals);
    }

    function _corporateAction(address token) private view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}

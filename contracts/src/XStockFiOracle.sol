// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title XStockFiOracle
/// @notice Chainlink prices for Stock Tokens in USDG. Every stock feed quotes USD and is converted through the
///         USDG / USD feed, so a USDG depeg is priced in rather than assumed away.
/// @dev Owned by the timelock once governance is handed over.
contract XStockFiOracle is IPriceOracle, Ownable2Step {
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    AggregatorV3Interface public immutable usdgFeed;
    uint32 public immutable usdgMaxAge;
    uint8 public immutable usdgDecimals;
    uint256 private immutable usdgFeedOne;

    /// @notice L2 sequencer uptime feed. Zero skips the check; Chainlink has not published one for Robinhood
    ///         Chain yet.
    AggregatorV3Interface public sequencerFeed;

    struct Feed {
        AggregatorV3Interface aggregator;
        uint32 maxAge;
        uint256 scale;
    }

    mapping(address token => Feed) public feeds;

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge);
    event SequencerFeedSet(address indexed feed);

    error InvalidFeed();
    error Unpriced(address token);

    constructor(
        address owner_,
        AggregatorV3Interface sequencerFeed_,
        AggregatorV3Interface usdgFeed_,
        uint32 usdgMaxAge_,
        uint8 usdgDecimals_
    ) Ownable(owner_) {
        if (address(usdgFeed_) == address(0) || usdgMaxAge_ == 0) revert InvalidFeed();
        sequencerFeed = sequencerFeed_;
        usdgFeed = usdgFeed_;
        usdgMaxAge = usdgMaxAge_;
        usdgDecimals = usdgDecimals_;
        usdgFeedOne = 10 ** usdgFeed_.decimals();
    }

    /// @param maxAge Longest gap accepted since the feed's last update. Stock feeds beat every 24h and pause over
    ///        weekends and holidays, so this also decides when a weekend price goes stale.
    function setFeed(address token, AggregatorV3Interface aggregator, uint32 maxAge) external onlyOwner {
        uint256 exp = uint256(IERC20Metadata(token).decimals()) + aggregator.decimals();
        if (maxAge == 0 || exp < usdgDecimals) revert InvalidFeed();
        feeds[token] = Feed(aggregator, maxAge, 10 ** (exp - usdgDecimals));
        emit FeedSet(token, address(aggregator), maxAge);
    }

    function setSequencerFeed(AggregatorV3Interface feed) external onlyOwner {
        sequencerFeed = feed;
        emit SequencerFeedSet(address(feed));
    }

    function feedOf(address token) external view returns (address) {
        return address(feeds[token].aggregator);
    }

    function isFresh(address token) external view returns (bool ok) {
        (ok,) = _price(token);
    }

    function usdgValue(address token, uint256 amount) external view returns (uint256) {
        (bool ok, uint256 p) = _price(token);
        if (!ok) revert Unpriced(token);
        return Math.mulDiv(amount, p, feeds[token].scale);
    }

    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256) {
        (bool ok, uint256 p) = _price(token);
        if (!ok) revert Unpriced(token);
        return Math.mulDiv(usdgAmount, feeds[token].scale, p);
    }

    /// @dev Price of one whole token in USDG, at the stock feed's decimals.
    function _price(address token) private view returns (bool, uint256) {
        Feed memory f = feeds[token];
        if (address(f.aggregator) == address(0) || !_sequencerUp() || _corporateAction(token)) return (false, 0);
        (bool ok, uint256 usd) = _latest(f.aggregator, f.maxAge);
        if (!ok) return (false, 0);
        (bool ok2, uint256 usdgUsd) = _latest(usdgFeed, usdgMaxAge);
        if (!ok2) return (false, 0);
        return (true, Math.mulDiv(usd, usdgFeedOne, usdgUsd));
    }

    function _latest(AggregatorV3Interface feed, uint32 maxAge) private view returns (bool, uint256) {
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > maxAge) return (false, 0);
            return (true, uint256(answer));
        } catch {
            return (false, 0);
        }
    }

    function _sequencerUp() private view returns (bool) {
        AggregatorV3Interface feed = sequencerFeed;
        if (address(feed) == address(0)) return true;
        try feed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && block.timestamp - startedAt > SEQUENCER_GRACE;
        } catch {
            return false;
        }
    }

    /// @dev Robinhood Stock Tokens raise `oraclePaused()` while a split or dividend multiplier is applied.
    ///      Tokens without the function are treated as never paused.
    function _corporateAction(address token) private view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Finds the Chainlink round that was current at a past moment: the last round updated at or before
///         `time`. Chainlink round ids are `phase << 64 | n`, with `n` counting up from 1 inside a phase.
library ChainlinkRounds {
    error NeedHint();
    error BadHint();

    /// @param hint A round id believed to be the answer. Zero is enough when the latest round is already at or
    ///        before `time`; otherwise the caller must name the round, and it is checked here.
    function at(AggregatorV3Interface feed, uint256 time, uint80 hint)
        internal
        view
        returns (int256 answer, uint256 updatedAt)
    {
        (uint80 latestId, int256 latestAnswer,, uint256 latestAt,) = feed.latestRoundData();
        if (hint == 0 || hint == latestId) {
            // Rounds only move forward, so a latest round at or before `time` is the one.
            if (latestAt != 0 && latestAt <= time) return (latestAnswer, latestAt);
            if (hint == 0) revert NeedHint();
            revert BadHint();
        }

        uint256 phase = uint256(hint) >> 64;
        uint256 latestPhase = uint256(latestId) >> 64;
        if (phase == 0 || phase > latestPhase) revert BadHint();

        bool found;
        (found, answer, updatedAt) = _round(feed, hint);
        if (!found || updatedAt == 0 || updatedAt > time) revert BadHint();

        // Nothing newer may have existed by `time`: neither the next round of the same phase nor, when a later
        // phase exists, its first round. Checking both keeps the answer unique while an old aggregator and its
        // replacement overlap.
        (bool hasNext,, uint256 nextAt) = _round(feed, hint + 1);
        bool proven = hasNext && nextAt != 0;
        if (proven && nextAt <= time) revert BadHint();
        if (phase < latestPhase) {
            // The first later phase that ever reported must have started after `time`. Phases that never
            // reported (an aggregator replaced before its first round) are skipped.
            for (uint256 p = phase + 1; p <= latestPhase; ++p) {
                (bool hasFirst,, uint256 firstAt) = _round(feed, uint80((p << 64) | 1));
                if (!hasFirst || firstAt == 0) continue;
                if (firstAt <= time) revert BadHint();
                proven = true;
                break;
            }
        }
        if (!proven) revert BadHint();
    }

    function _round(AggregatorV3Interface feed, uint80 id) private view returns (bool, int256, uint256) {
        try feed.getRoundData(id) returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return (true, answer, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }
}

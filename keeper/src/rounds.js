// Finds the Chainlink round that was current at a past moment, for settling binaries. Round ids are
// `phase << 64 | n` with n counting up from 1, and updatedAt only grows within a phase, so each phase is
// binary-searched. The answer matches what XStockFiBinaries accepts: the newest phase with a round at or before
// `time`, and in it the last such round.
const MASK = (1n << 64n) - 1n;

async function readRound(feed, id) {
  try {
    const r = await feed.getRoundData(id);
    const updatedAt = BigInt(r[3]);
    return updatedAt === 0n ? null : { id, updatedAt, answer: BigInt(r[1]) };
  } catch {
    return null;
  }
}

/** Highest n with a round in `phase` (rounds 1..n exist). */
async function lastIndex(feed, phase) {
  const base = BigInt(phase) << 64n;
  if (!(await readRound(feed, base | 1n))) return 0n;
  let lo = 1n;
  let hi = 2n;
  while (await readRound(feed, base | hi)) {
    lo = hi;
    hi *= 2n;
    if (hi > MASK) break;
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await readRound(feed, base | mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Returns the hint to pass to `settle`: 0n when the latest round is already at or before `time`, otherwise the
 * round id. Returns null when no round at or before `time` exists.
 */
async function roundHint(feed, time) {
  const t = BigInt(time);
  const latest = await feed.latestRoundData();
  const latestId = BigInt(latest[0]);
  if (BigInt(latest[3]) !== 0n && BigInt(latest[3]) <= t) return 0n;

  for (let phase = latestId >> 64n; phase >= 1n; phase--) {
    const base = phase << 64n;
    const first = await readRound(feed, base | 1n);
    if (!first || first.updatedAt > t) continue;
    let lo = 1n;
    let hi = phase === latestId >> 64n ? latestId & MASK : await lastIndex(feed, phase);
    // Invariant: round lo is at or before t; find the last one that is.
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const r = await readRound(feed, base | mid);
      if (r && r.updatedAt <= t) lo = mid;
      else hi = mid - 1n;
    }
    return base | lo;
  }
  return null;
}

module.exports = { roundHint, lastIndex };

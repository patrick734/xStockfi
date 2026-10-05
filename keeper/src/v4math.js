// Floating-point Uniswap v4 tick math. Precision is ample for choosing a range and sizing a swap;
// every value the keeper submits is re-checked on-chain by Vault.rebalance.
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const LN_BASE = Math.log(1.0001);
const Q96 = 2 ** 96;

// Tick of a raw price (token1 base units per token0 base unit).
function tickFromPrice(price) {
  return Math.floor(Math.log(price) / LN_BASE);
}

function sqrtAtTick(tick) {
  return Math.sqrt(1.0001 ** tick);
}

function sqrtFromX96(sqrtPriceX96) {
  return Number(sqrtPriceX96) / Q96;
}

// Range of about +-halfWidth ticks around `center`, snapped outwards to `spacing`.
function rangeAround(center, halfWidth, spacing) {
  const minUsable = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxUsable = Math.floor(MAX_TICK / spacing) * spacing;
  let lower = Math.floor((center - halfWidth) / spacing) * spacing;
  let upper = Math.ceil((center + halfWidth) / spacing) * spacing;
  if (upper - lower < 2 * spacing) upper = lower + 2 * spacing;
  lower = Math.max(lower, minUsable);
  upper = Math.min(upper, maxUsable);
  return { lower, upper };
}

// Share of a position's value held in token1 at pool price sqrtP (plain float, not X96).
function token1ValueShare(sqrtP, lower, upper) {
  const a = sqrtAtTick(lower);
  const b = sqrtAtTick(upper);
  if (sqrtP <= a) return 0;
  if (sqrtP >= b) return 1;
  const amt0 = (b - sqrtP) / (sqrtP * b);
  const amt1 = sqrtP - a;
  return amt1 / (amt0 * sqrtP * sqrtP + amt1);
}

module.exports = { MIN_TICK, MAX_TICK, tickFromPrice, sqrtFromX96, rangeAround, token1ValueShare };

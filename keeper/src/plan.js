// Pure rebalance decision: given on-chain readings, decide whether to move the range, where to, and
// how much to swap first. No I/O, so it is unit-tested in scripts/unit.js.
const v4 = require("./v4math");

/**
 * @param {object} p
 * @param {object} p.cfg           rebalance config (halfWidthTicks, edgeThresholdPct, minSwapUsdg, minIdleUsdg, maxIdlePct)
 * @param {bigint} p.fair          oracle USDG value (6 dp) of one whole Stock Token
 * @param {bigint} p.stockUnit    10 ** stock decimals
 * @param {boolean} p.stockIsToken0
 * @param {number} p.spacing       pool tick spacing
 * @param {bigint} p.sqrtPriceX96  pool price
 * @param {number} p.poolTick
 * @param {bigint} p.liquidity     current range liquidity (0 = no range)
 * @param {number} p.lower         current range
 * @param {number} p.upper
 * @param {bigint} p.heldS         Vault.holdings(): Stock Token backing all shares
 * @param {bigint} p.heldU         Vault.holdings(): USDG backing all shares
 * @param {bigint} p.idleS         Stock Token sitting in the Vault outside the range
 * @param {bigint} p.idleU         USDG sitting in the Vault outside the range
 */
function planRebalance(p) {
  const { cfg } = p;
  const usdg = (x) => BigInt(Math.round(Number(x) * 1e6));
  const value = (e, u) => u + (e * p.fair) / p.stockUnit;

  // Oracle price as a raw token1/token0 ratio, then as a tick.
  const usdgPerRawUnit = Number(p.fair) / Number(p.stockUnit);
  const oracleTick = v4.tickFromPrice(p.stockIsToken0 ? usdgPerRawUnit : 1 / usdgPerRawUnit);
  const target = v4.rangeAround(oracleTick, cfg.halfWidthTicks, p.spacing);
  const totalValue = value(p.heldS, p.heldU);
  const idleValue = value(p.idleS, p.idleU);
  const minIdle = usdg(cfg.minIdleUsdg || 0);
  const status = { poolTick: p.poolTick, oracleTick, range: `[${p.lower},${p.upper}]`, liquidity: p.liquidity };

  let why;
  if (p.liquidity === 0n) {
    if (totalValue < minIdle) return { action: "none", note: "no range and nothing worth placing", status };
    why = "no active range";
  } else {
    const margin = Math.floor(((p.upper - p.lower) * cfg.edgeThresholdPct) / 100);
    if (p.poolTick < p.lower || p.poolTick >= p.upper) why = "pool tick out of range";
    else if (p.poolTick < p.lower + margin || p.poolTick >= p.upper - margin) why = "pool tick near range edge";
    else if (cfg.maxIdlePct && totalValue > 0n && idleValue >= minIdle && idleValue * 100n > totalValue * BigInt(cfg.maxIdlePct)) {
      why = "idle balance above maxIdlePct";
    }
  }
  if (!why) return { action: "none", note: "in range, nothing to do", status };
  if (p.liquidity !== 0n && target.lower === p.lower && target.upper === p.upper && why !== "idle balance above maxIdlePct") {
    // The oracle says the current range is right; the pool is the one off-centre. Moving would not help.
    return { action: "skip", note: "oracle-centred range equals the current range but the pool sits at its edge", status };
  }

  // Size the swap so balances match the new range's value split at the pool price (Position.enter
  // mints at pool price). Values use the oracle, which Vault._swapChecked also uses.
  const share1 = v4.token1ValueShare(v4.sqrtFromX96(p.sqrtPriceX96), target.lower, target.upper);
  const usdgShare = p.stockIsToken0 ? share1 : 1 - share1;
  const targetU = BigInt(Math.floor(Number(totalValue) * usdgShare));
  let sellUsdg;
  let amount;
  let swapValue;
  if (p.heldU > targetU) {
    sellUsdg = true;
    swapValue = p.heldU - targetU;
    amount = swapValue;
  } else {
    sellUsdg = false;
    swapValue = targetU - p.heldU;
    amount = (swapValue * p.stockUnit) / p.fair;
    if (amount > p.heldS) amount = p.heldS;
  }
  if (swapValue < usdg(cfg.minSwapUsdg || 0)) amount = 0n;
  return { action: "rebalance", why, target, sellUsdg, amount, swapValue, usdgShare, status };
}

module.exports = { planRebalance };

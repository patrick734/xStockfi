// Liquidity Vault duties: keep the range around the oracle price (rebalance) and collect fees (harvest).
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason } = require("../chain");
const { logger } = require("../log");
const { planRebalance } = require("../plan");
const { encodeRoute } = require("../routes");

const BPS = 10_000n;

// Reads the static facts about each Vault once at startup.
async function setupVaults(ctx) {
  const only = (ctx.cfg.liquidityVaults.only || []).map((t) => t.toUpperCase());
  const out = [];
  for (const [ticker, w] of Object.entries(ctx.dep.liquidityVaults || {})) {
    if (only.length && !only.includes(ticker.toUpperCase())) continue;
    const log = logger("setup", `${ticker} liquidity`);
    try {
      const vault = new ethers.Contract(w.vault, abis.LiquidityVault, ctx.runner);
      const position = new ethers.Contract(w.position, abis.Position, ctx.runner);
      const oracle = new ethers.Contract(await vault.oracle(), abis.Oracle, ctx.runner);
      const stock = await vault.stock();
      const decimals = await new ethers.Contract(stock, abis.ERC20, ctx.provider).decimals();
      const info = { ticker, vault, position, oracle, stock, stockUnit: 10n ** BigInt(decimals), v4: false };
      try {
        const key = await position.poolKey();
        info.spacing = Number(key.tickSpacing);
        info.stockIsToken0 = await position.stockIsToken0();
        info.v4 = true;
      } catch {
        log.info("position exposes no Uniswap v4 pool views (mock?); rebalance checks disabled for this Vault");
      }
      const isKeeper = await vault.hasRole(await vault.KEEPER_ROLE(), ctx.keeper);
      if (!isKeeper) log.warn("keeper address lacks KEEPER_ROLE on this Vault; rebalance will not work", { keeper: ctx.keeper });
      info.isKeeper = isKeeper;
      out.push(info);
    } catch (e) {
      log.error("could not read Vault; it will be skipped", { reason: reason(e) });
    }
  }
  return out;
}

async function runVault(ctx, w) {
  const state = (ctx.state.vaults[w.ticker] ||= { lastHarvest: 0 });
  if (ctx.cfg.rebalance.enabled) {
    try {
      const done = await rebalance(ctx, w);
      if (done) state.lastHarvest = Date.now(); // rebalance harvests first
    } catch (e) {
      logger("rebalance", w.ticker).error("check failed", { reason: reason(e) });
    }
  }
  if (ctx.cfg.harvest.enabled) {
    try {
      await harvest(ctx, w, state);
    } catch (e) {
      logger("harvest", w.ticker).error("check failed", { reason: reason(e) });
    }
  }
}

// ---------------------------------------------------------------- harvest

async function harvest(ctx, w, state) {
  const log = logger("harvest", w.ticker);
  const interval = ctx.cfg.harvest.intervalSeconds * 1000;
  if (state.lastHarvest && Date.now() - state.lastHarvest < interval) {
    log.debug("interval not elapsed", { nextInSec: Math.round((state.lastHarvest + interval - Date.now()) / 1000) });
    return;
  }
  // There is no pending-fee view. The position's collectFees is Vault-only, so simulate it as the Vault:
  // eth_call does not check signatures. It returns exactly what harvest() would collect.
  let fees = null;
  try {
    // Read through the provider: a signer-backed contract refuses a `from` other than the signer.
    const [e, u] = await w.position.connect(ctx.provider).collectFees.staticCall({ from: w.vault.target });
    fees = { stockFees: e, usdgFees: u };
  } catch (e) {
    log.debug("pending fee simulation failed; harvesting unconditionally", { reason: reason(e) });
  }
  if (fees && fees.stockFees === 0n && fees.usdgFees === 0n) {
    log.info("no pending fees");
    state.lastHarvest = Date.now();
    return;
  }
  const minFees = ethers.parseUnits(String(ctx.cfg.harvest.minFeesUsdg || "0"), 6);
  if (fees && minFees > 0n) {
    let value = fees.usdgFees;
    if (fees.stockFees > 0n && (await w.oracle.isFresh(w.stock))) value += await w.oracle.usdgValue(w.stock, fees.stockFees);
    if (value < minFees) {
      log.info("pending fees below minFeesUsdg, waiting", { valueUsdg: ethers.formatUnits(value, 6) });
      return;
    }
  }
  const r = await exec(ctx, log, w.vault, "harvest", [], "harvest");
  if (r.ok) {
    state.lastHarvest = Date.now();
    if (fees) log.info("harvested", { stockFees: fees.stockFees, usdgFees: fees.usdgFees, dryRun: !!r.simulated });
  }
}

// ---------------------------------------------------------------- rebalance

// Returns true when a rebalance was sent (or would have been, in dry run).
async function rebalance(ctx, w) {
  const log = logger("rebalance", w.ticker);
  const cfg = ctx.cfg.rebalance;
  if (!w.v4) return false;
  if (!w.isKeeper) return false;
  if (await w.vault.paused()) {
    log.info("Vault paused, skipping");
    return false;
  }
  if (!(await w.vault.priceFresh())) {
    log.info("oracle price stale (market closed, corporate action or feed down), skipping");
    return false;
  }

  const [slot, liquidity, curLower, curUpper, maxDevBps, fair, spot] = await Promise.all([
    w.position.slot0(),
    w.position.liquidity(),
    w.position.tickLower(),
    w.position.tickUpper(),
    w.vault.maxPoolDeviationBps(),
    w.oracle.usdgValue(w.stock, w.stockUnit),
    w.position.spotUsdgValue(w.stockUnit),
  ]);
  // Vault._checkPool: |spot - fair| * 10000 <= fair * maxPoolDeviationBps, or the call reverts.
  const diff = spot > fair ? spot - fair : fair - spot;
  const devBps = Number((diff * BPS) / fair);
  if (diff * BPS > fair * BigInt(maxDevBps)) {
    log.warn("pool price too far from oracle; rebalance would revert PoolDeviation. Skipping", {
      spot,
      oracle: fair,
      deviationBps: devBps,
      maxBps: Number(maxDevBps),
    });
    return false;
  }

  const [[heldS, heldU], idleS, idleU] = await Promise.all([
    w.vault.holdings(),
    new ethers.Contract(w.stock, abis.ERC20, ctx.provider).balanceOf(w.vault.target),
    new ethers.Contract(ctx.dep.usdg, abis.ERC20, ctx.provider).balanceOf(w.vault.target),
  ]);
  const plan = planRebalance({
    cfg,
    fair,
    stockUnit: w.stockUnit,
    stockIsToken0: w.stockIsToken0,
    spacing: w.spacing,
    sqrtPriceX96: slot[0],
    poolTick: Number(slot[1]),
    liquidity,
    lower: Number(curLower),
    upper: Number(curUpper),
    heldS,
    heldU,
    idleS,
    idleU,
  });
  const status = { ...plan.status, deviationBps: devBps };
  if (plan.action === "none") {
    log.info(plan.note, status);
    return false;
  }
  if (plan.action === "skip") {
    log.warn(`${plan.note}; skipping`, status);
    return false;
  }
  const { target, sellUsdg, amount, swapValue, why } = plan;

  // A configured rebalance route is written USDG -> ... -> stock and reversed for stock sales.
  const spec = cfg.routes[w.ticker];
  const route =
    Array.isArray(spec) && spec.length && amount !== 0n
      ? sellUsdg
        ? encodeRoute(ctx, spec, ctx.dep.usdg, w.stock)
        : encodeRoute(ctx, [...spec].reverse(), w.stock, ctx.dep.usdg)
      : "0x";
  log.info(`rebalancing: ${why}`, {
    ...status,
    newRange: `[${target.lower},${target.upper}]`,
    swap: amount === 0n ? "none" : `${sellUsdg ? "USDG->stock" : "stock->USDG"} ${amount}`,
    swapValueUsdg: ethers.formatUnits(swapValue, 6),
  });

  // The swap must clear Vault.maxSwapLossBps against the oracle; if the full size fails, try smaller.
  const sizes = [...new Set([amount, amount / 2n, amount / 4n, 0n].map(String))].map(BigInt);
  for (const size of sizes) {
    const args = [target.lower, target.upper, sellUsdg, size, route];
    try {
      await w.vault.rebalance.staticCall(...args, { from: ctx.keeper });
    } catch (e) {
      log.warn("rebalance simulation reverted", { swapAmount: size, reason: reason(e) });
      continue;
    }
    const r = await exec(ctx, log, w.vault, "rebalance", args, "rebalance");
    return r.ok;
  }
  log.warn("no swap size passed simulation; not rebalancing this cycle");
  return false;
}

module.exports = { setupVaults, runVault };

// Income Vault duties: start weekly rounds, quote puts (and covered calls on assigned stock), pull quotes that went
// stale, sell assigned stock back to USDG if configured, and close rounds at expiry.
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const pricing = require("../pricing");

const BPS = 10_000n;
const OFFERED = 1n;

async function setupIncome(ctx) {
  const only = (ctx.cfg.incomeVaults.only || []).map((t) => t.toUpperCase());
  const out = [];
  if (!ctx.dep.options) return out;
  const desk = new ethers.Contract(ctx.dep.options, abis.Options, ctx.runner);
  for (const [ticker, v] of Object.entries(ctx.dep.incomeVaults || {})) {
    if (only.length && !only.includes(ticker.toUpperCase())) continue;
    const log = logger("setup", `${ticker} income`);
    try {
      const vault = new ethers.Contract(v.vault, abis.IncomeVault, ctx.runner);
      const oracle = new ethers.Contract(await vault.oracle(), abis.Oracle, ctx.provider);
      const decimals = await new ethers.Contract(v.stock, abis.ERC20, ctx.provider).decimals();
      const isKeeper = await vault.hasRole(await vault.KEEPER_ROLE(), ctx.keeper);
      if (!isKeeper) log.warn("keeper address lacks KEEPER_ROLE on this Income Vault; it will only be closed, never quoted", { keeper: ctx.keeper });
      out.push({ ticker, vault, desk, oracle, stock: v.stock, decimals: Number(decimals), unit: 10n ** decimals, isKeeper });
    } catch (e) {
      log.error("could not read Income Vault; it will be skipped", { reason: reason(e) });
    }
  }
  return out;
}

async function runIncome(ctx, v) {
  const log = logger("income", v.ticker);
  const cfg = ctx.cfg.incomeVaults;
  const now = Number(await blockTime(ctx.provider));
  const [live, expiry, paused] = await Promise.all([v.vault.live(), v.vault.roundExpiry(), v.vault.paused()]);

  if (live && now >= Number(expiry)) {
    log.info("round expired, closing");
    await exec(ctx, log, v.vault, "closeRound", [], "closeRound");
    return;
  }
  if (!v.isKeeper) return;
  if (paused) return log.info("paused by the guardian");
  if (!(await v.oracle.isFresh(v.stock))) return log.info("price stale (market closed, corporate action or feed down); waiting");
  if (cfg.marketHoursOnly && !pricing.marketOpen(now)) return log.info("outside US market hours; quoting waits");

  const spot = Number(await v.oracle.usdgValue(v.stock, v.unit)) / 1e6;
  if (live) return quote(ctx, log, v, now, Number(expiry), spot);
  const started = await between(ctx, log, v, now, spot);
  // A round just opened: quote it in the same cycle (a dry run has nothing on-chain to quote against).
  if (started && !ctx.dryRun) return quote(ctx, log, v, now, started, spot);
}

async function between(ctx, log, v, now, spot) {
  const cfg = ctx.cfg.incomeVaults;
  const held = await v.vault.freeStock();
  if (held > 0n && cfg.sellAssignedStock) {
    const r = await exec(ctx, log, v.vault, "sellStock", [held, "0x"], `sellStock ${ethers.formatUnits(held, v.decimals)}`);
    if (!r.ok) log.warn("could not sell the assigned stock within the swap-loss limit; writing calls on it instead");
  }
  const [freeUsdg, stockLeft, pending] = await Promise.all([v.vault.freeUsdg(), v.vault.freeStock(), v.vault.pendingUsdg()]);
  const value = Number(freeUsdg + pending) / 1e6 + (Number(stockLeft) / Number(v.unit)) * spot;
  if (value < Number(cfg.minVaultUsdg)) {
    log.info("too little in the vault to run a round", { valueUsdg: value.toFixed(2) });
    return 0;
  }

  const limits = await v.vault.limits();
  const expiry = pricing.nextExpiry(now, { weekday: cfg.expiryWeekday, hourUtc: cfg.expiryHourUtc, minSeconds: Number(limits.minRound) });
  if (expiry > now + Number(limits.maxRound)) {
    log.warn("next expiry is beyond maxRound; check expiryWeekday", { expiry });
    return 0;
  }
  log.info("starting a round", { expiry: new Date(expiry * 1000).toISOString(), valueUsdg: value.toFixed(2) });
  const r = await exec(ctx, log, v.vault, "startRound", [expiry], "startRound");
  return r.ok ? expiry : 0;
}

async function quote(ctx, log, v, now, expiry, spot) {
  const cfg = ctx.cfg.incomeVaults;
  const limits = await v.vault.limits();
  const ids = await v.vault.roundOptions();
  const open = { put: false, call: false };
  for (const id of ids) {
    const o = await v.desk.get(id);
    if (o.state !== OFFERED) continue;
    const kind = Number(o.kind) === 0 ? "call" : "put";
    const px = BigInt(Math.round(spot * 1e6));
    const stale = BigInt(now) >= o.buyBy || px < o.minPrice || (o.maxPrice !== 0n && px > o.maxPrice);
    if (stale) {
      log.info(`withdrawing a stale ${kind} offer`, { id });
      await exec(ctx, log, v.vault, "withdrawOffer", [id], "withdrawOffer");
    } else open[kind] = true;
  }

  const MIN_LIFE = 3600;
  const quoteUntil = expiry - Math.max(MIN_LIFE, Number(cfg.stopQuotingHoursBeforeExpiry) * 3600);
  if (now >= quoteUntil) return log.info("too close to expiry to quote");
  if (ids.length >= 20) return log.info("round is full");

  const years = (expiry - now) / pricing.YEAR;
  const vol = Number(cfg.volatility[v.ticker] ?? cfg.volatility.default);
  const window = Math.min(Number(cfg.buyWindowSeconds), Number(limits.maxBuyWindow), expiry - now - 60);
  const [startValue, committed, freeUsdg, freeStock] = await Promise.all([
    v.vault.roundStartValue(),
    v.vault.committed(),
    v.vault.freeUsdg(),
    v.vault.freeStock(),
  ]);
  let budget = (startValue * BigInt(limits.maxCommitBps)) / BPS - committed;
  if (budget < 0n) budget = 0n;

  if (!open.call && freeStock > 0n) {
    const size = Number(freeStock) / Number(v.unit);
    const exposure = size * spot;
    if (BigInt(Math.floor(exposure * 1e6)) <= budget) {
      const strike = pricing.chooseStrike("call", spot, Number(cfg.callOtmPct), Number(limits.minOtmBps));
      const prem = pricing.premium({ kind: "call", spot, strike, size, years, vol, markupPct: Number(cfg.markupPct), minPremiumBps: Number(limits.minPremiumBps), exposure });
      await sell(ctx, log, v, "sellCall", "call", strike, freeStock, prem, window);
      budget -= BigInt(Math.floor(exposure * 1e6));
    } else log.info("not enough commitment room for a covered call this round");
  }

  if (!open.put && cfg.sellPuts) {
    const strike = pricing.chooseStrike("put", spot, Number(cfg.putOtmPct), Number(limits.minOtmBps));
    const room = freeUsdg < budget ? freeUsdg : budget;
    const collateral = (Number(room) / 1e6) * Number(cfg.putSizeFraction);
    if (collateral < Number(cfg.minQuoteUsdg)) return log.info("no room for another put this round", { roomUsdg: (Number(room) / 1e6).toFixed(2) });
    const size = Math.floor((collateral / strike) * 1e4) / 1e4;
    const prem = pricing.premium({ kind: "put", spot, strike, size, years, vol, markupPct: Number(cfg.markupPct), minPremiumBps: Number(limits.minPremiumBps), exposure: size * strike });
    await sell(ctx, log, v, "sellPut", "put", strike, ethers.parseUnits(size.toFixed(4), v.decimals), prem, window);
  }
}

async function sell(ctx, log, v, method, kind, strike, size, prem, window) {
  const args = [ethers.parseUnits(strike.toFixed(6), 6), size, ethers.parseUnits(prem.toFixed(6), 6), window];
  log.info(`quoting a ${kind}`, {
    strike: strike.toFixed(2),
    size: ethers.formatUnits(size, v.decimals),
    premiumUsdg: prem.toFixed(2),
    buyWindowMin: Math.round(window / 60),
  });
  return exec(ctx, log, v.vault, method, args, method);
}

module.exports = { setupIncome, runIncome };

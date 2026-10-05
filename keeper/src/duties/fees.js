// Protocol-fee pipeline: credit line reserves -> FeeRouter -> BuyBurn -> xStockFi token bought and burned.
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { buildRoute } = require("../routes");

const BPS = 10_000n;
const WAD = 10n ** 18n;

// Tokens fees can arrive in: USDG (options, binaries, credit lines) and the Stock Tokens Liquidity Vaults earn.
function feeTokens(ctx) {
  const list = [{ symbol: "USDG", address: ethers.getAddress(ctx.dep.usdg) }];
  for (const [ticker, w] of Object.entries(ctx.dep.liquidityVaults || {})) list.push({ symbol: ticker, address: ethers.getAddress(w.stock) });
  return list;
}

function erc20(ctx, address) {
  return new ethers.Contract(address, abis.ERC20, ctx.provider);
}

// ---------------------------------------------------------------- FeeRouter.routeMany

async function runFeeRouter(ctx) {
  const log = logger("route", "FeeRouter");
  if (!ctx.cfg.feeRouter.enabled || !ctx.dep.feeRouter) return;
  const router = new ethers.Contract(ctx.dep.feeRouter, abis.FeeRouter, ctx.runner);
  const held = [];
  for (const t of feeTokens(ctx)) {
    const bal = await erc20(ctx, t.address).balanceOf(ctx.dep.feeRouter);
    if (bal > 0n) held.push({ ...t, bal });
  }
  if (held.length === 0) return log.info("nothing to route");
  log.info("routing to BuyBurn", { tokens: held.map((t) => `${t.symbol}:${t.bal}`).join(",") });
  await exec(ctx, log, router, "routeMany", [held.map((t) => t.address)], "routeMany");
}

// ---------------------------------------------------------------- BuyBurn.buyAndBurn

async function runBuyBurn(ctx) {
  const log = logger("buyburn", "BuyBurn");
  const cfg = ctx.cfg.buyBurn;
  if (!cfg.enabled || !ctx.dep.buyBurn) return;
  const bb = new ethers.Contract(ctx.dep.buyBurn, abis.BuyBurn, ctx.runner);

  if (!(await bb.hasRole(await bb.KEEPER_ROLE(), ctx.keeper))) {
    return log.warn("keeper address lacks KEEPER_ROLE on BuyBurn; skipping", { keeper: ctx.keeper });
  }
  if (await bb.halted()) return log.info("halted by the guardian, skipping");
  // A deployment made before the token launched records none; set-token.sh sets it on-chain later.
  if (!ctx.dep.token) {
    const t = await bb.token();
    if (t === ethers.ZeroAddress) return log.info("token not set yet; fees wait in BuyBurn");
    ctx.dep.token = t;
  }
  // lastRun and minInterval are shared by every input: at most one buy per interval.
  const [last, interval, now] = await Promise.all([bb.lastRun(), bb.minInterval(), blockTime(ctx.provider)]);
  if (now < last + interval) return log.info("rate limited by minInterval", { nextInSec: last + interval - now });

  const oracle = ctx.dep.oracle ? new ethers.Contract(ctx.dep.oracle, abis.Oracle, ctx.provider) : null;
  const candidates = [];
  for (const t of feeTokens(ctx)) {
    const [bal, cap] = await Promise.all([erc20(ctx, t.address).balanceOf(ctx.dep.buyBurn), bb.maxInputPerRun(t.address)]);
    if (bal === 0n) continue;
    if (cap === 0n) {
      log.warn("fee token held but its maxInputPerRun is 0; governance must set a limit", { token: t.symbol, balance: bal });
      continue;
    }
    const amount = bal < cap ? bal : cap;
    let value = null;
    if (t.symbol === "USDG") value = amount;
    else if (oracle) {
      try {
        if (await oracle.isFresh(t.address)) value = await oracle.usdgValue(t.address, amount);
      } catch {}
    }
    candidates.push({ ...t, bal, cap, amount, value });
  }
  if (candidates.length === 0) return log.info("no fees waiting");
  // Largest known USDG value first; unpriced tokens last.
  candidates.sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : a.value > b.value ? -1 : a.value < b.value ? 1 : 0));

  for (const c of candidates) {
    const tlog = logger("buyburn", c.symbol);
    let route;
    let hops;
    try {
      const spec = cfg.routes[c.symbol] ?? cfg.routes[c.address] ?? cfg.routes[c.address.toLowerCase()] ?? cfg.defaultRoute;
      ({ route, path: hops } = buildRoute(ctx, spec, c.address, ctx.dep.token));
    } catch (e) {
      tlog.error("bad route config", { reason: e.message });
      continue;
    }
    const pathText = hops ? hops.map((a) => symbolOf(ctx, a)).join("->") : "adapter-default";

    // Quote by simulating the real call with minOut = 1: it returns exactly what the swap delivers.
    let quoted;
    try {
      quoted = await bb.buyAndBurn.staticCall(c.address, c.amount, 1n, route, { from: ctx.keeper });
    } catch (e) {
      tlog.warn("quote failed, skipping this token", { amountIn: c.amount, path: pathText, reason: reason(e) });
      continue;
    }
    const minOut = (quoted * (BPS - BigInt(cfg.slippageBps))) / BPS;
    if (minOut === 0n) {
      tlog.warn("quote returned nothing, skipping", { amountIn: c.amount, path: pathText });
      continue;
    }
    tlog.info("buying and burning", {
      amountIn: c.amount,
      valueUsdg: c.value === null ? "unpriced" : ethers.formatUnits(c.value, 6),
      path: pathText,
      quoted: ethers.formatEther(quoted),
      minOut: ethers.formatEther(minOut),
    });
    const r = await exec(ctx, tlog, bb, "buyAndBurn", [c.address, c.amount, minOut, route], "buyAndBurn");
    if (r.ok) return; // the shared minInterval allows one per run
  }
}

function symbolOf(ctx, a) {
  if (a === ethers.ZeroAddress) return "ETH";
  if (a.toLowerCase() === String(ctx.dep.usdg).toLowerCase()) return "USDG";
  if (a.toLowerCase() === String(ctx.dep.token).toLowerCase()) return ctx.dep.tokenSymbol || "XSF";
  for (const [t, m] of Object.entries(ctx.dep.markets || {})) if (a.toLowerCase() === m.token.toLowerCase()) return t;
  return a;
}

// ---------------------------------------------------------------- credit lines

async function runCreditLines(ctx) {
  for (const [ticker, address] of Object.entries(ctx.dep.creditLines || {})) {
    const log = logger("credit", ticker);
    const desk = new ethers.Contract(address, abis.CreditDesk, ctx.runner);
    const state = (ctx.state.desks[address] ||= { lastClaim: 0, accounts: new Set(), scanned: null });
    if (ctx.cfg.creditLines.claimReserves) {
      try {
        await claimReserves(ctx, log, desk, state);
      } catch (e) {
        log.error("claimReserves check failed", { reason: reason(e) });
      }
    }
    if (ctx.cfg.creditLines.logUnhealthy) {
      try {
        await logUnhealthy(ctx, log, desk, state);
      } catch (e) {
        log.error("health scan failed", { reason: reason(e) });
      }
    }
  }
}

async function claimReserves(ctx, log, desk, state) {
  const interval = ctx.cfg.creditLines.claimIntervalSeconds * 1000;
  if (state.lastClaim && Date.now() - state.lastClaim < interval) return;
  const [reserves, debt] = await Promise.all([desk.reserves(), desk.totalDebt()]);
  // claimReserves accrues first, so reserves can grow from outstanding debt even when the stored figure is 0.
  if (reserves === 0n && debt === 0n) {
    log.info("no reserves to claim");
    state.lastClaim = Date.now();
    return;
  }
  // Interest over a short gap can round to zero, which reverts ZeroAmount: not an error.
  const r = await exec(ctx, log, desk, "claimReserves", [], "claimReserves", ["ZeroAmount"]);
  if (r.ok) state.lastClaim = Date.now();
}

// Liquidations are not automated; this only reports accounts below health factor 1.
async function logUnhealthy(ctx, log, desk, state) {
  const latest = await ctx.provider.getBlockNumber();
  let from = state.scanned === null ? Number(ctx.dep.block || ctx.cfg.creditLines.scanFromBlock || 0) : state.scanned + 1;
  const chunk = Number(ctx.cfg.creditLines.scanChunkBlocks || 50_000);
  while (from <= latest) {
    const to = Math.min(from + chunk - 1, latest);
    for (const ev of await desk.queryFilter(desk.filters.Borrowed(), from, to)) state.accounts.add(ev.args.account);
    state.scanned = to;
    from = to + 1;
  }
  const vault = new ethers.Contract(await desk.vault(), abis.LiquidityVault, ctx.provider);
  if (!(await vault.priceFresh())) return log.info("price stale; health factors unavailable", { borrowers: state.accounts.size });
  let unhealthy = 0;
  for (const account of state.accounts) {
    const debt = await desk.debtOf(account);
    if (debt === 0n) continue;
    const hf = await desk.healthFactor(account);
    if (hf < WAD) {
      unhealthy++;
      log.warn("UNHEALTHY account (liquidation is not automated)", { account, healthFactor: ethers.formatEther(hf), debt });
    }
  }
  log.info("health scan done", { borrowers: state.accounts.size, unhealthy });
}

module.exports = { runFeeRouter, runBuyBurn, runCreditLines };

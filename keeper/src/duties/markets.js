// Upkeep any wallet could do, run as a service: record corporate actions for binaries, settle binaries that
// have expired, refund bets nobody joined, and hand writers back the collateral of options that ran out.
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { roundHint } = require("../rounds");

const BET = { Open: 1n, Matched: 2n };
const OPTION = { Offered: 1n, Active: 2n };
const PAGE = 100;

/** Keeps the binaries contract's record of corporate actions in step with each token's `oraclePaused` flag. */
async function notePauses(ctx) {
  if (!ctx.cfg.binaries.notePauses || !ctx.dep.binaries) return;
  const log = logger("pauses");
  const bin = new ethers.Contract(ctx.dep.binaries, abis.Binaries, ctx.runner);
  for (const [ticker, m] of Object.entries(ctx.dep.markets || {})) {
    let paused;
    try {
      paused = await new ethers.Contract(m.token, abis.StockToken, ctx.provider).oraclePaused();
    } catch {
      continue; // a token without the flag never pauses
    }
    const windows = await bin.pauses(m.token);
    const open = windows.length > 0 && windows[windows.length - 1].end === 0n;
    if (paused && !open) await exec(ctx, logger("pauses", ticker), bin, "notePause", [m.token], "notePause");
    else if (!paused && open) await exec(ctx, logger("pauses", ticker), bin, "noteResume", [m.token], "noteResume");
  }
  log.debug("corporate-action flags checked");
}

async function runBinaries(ctx) {
  const cfg = ctx.cfg.binaries;
  if (!ctx.dep.binaries || (!cfg.settle && !cfg.refundUnjoined)) return;
  const log = logger("binaries");
  const bin = new ethers.Contract(ctx.dep.binaries, abis.Binaries, ctx.runner);
  const state = (ctx.state.binaries ||= { cursor: 0 });
  const [count, now, delay] = await Promise.all([bin.count(), blockTime(ctx.provider), bin.SETTLE_DELAY()]);
  let sent = 0;
  let cursor = state.cursor;
  let settledPrefix = true;
  for (let from = state.cursor; from < Number(count) && sent < cfg.maxPerCycle; from += PAGE) {
    const bets = await bin.list(from, from + PAGE);
    for (let i = 0; i < bets.length && sent < cfg.maxPerCycle; i++) {
      const id = from + i;
      const b = bets[i];
      let pending = b.state === BET.Open || b.state === BET.Matched;
      let r = null;
      if (b.state === BET.Matched && cfg.settle && now > b.expiry + delay) {
        const blog = logger("binaries", `#${id}`);
        try {
          const hint = await roundHint(new ethers.Contract(b.feed, abis.Aggregator, ctx.provider), b.expiry);
          if (hint === null) blog.warn("no feed round at or before expiry; anyone can void it after VOID_AFTER");
          else r = await exec(ctx, blog, bin, "settle", [id, hint], "settle", ["CorporateAction"]);
        } catch (e) {
          blog.warn("could not settle", { reason: reason(e) });
        }
      } else if (b.state === BET.Open && cfg.refundUnjoined && now >= b.joinBy) {
        r = await exec(ctx, logger("binaries", `#${id}`), bin, "cancel", [id], "refund unjoined");
      }
      if (r && r.ok) {
        sent++;
        if (!r.simulated) pending = false;
      }
      if (pending) settledPrefix = false;
      if (settledPrefix) cursor = id + 1;
    }
  }
  if (!ctx.dryRun) state.cursor = cursor;
  log.info("checked", { bets: Number(count), from: state.cursor, actions: sent });
}

/** Returns collateral to writers of options that expired unexercised, or offers nobody bought. */
async function runOptions(ctx) {
  const cfg = ctx.cfg.options;
  if (!ctx.dep.options || !cfg.releaseExpired) return;
  const log = logger("options");
  const desk = new ethers.Contract(ctx.dep.options, abis.Options, ctx.runner);
  const vaults = new Set(Object.values(ctx.dep.incomeVaults || {}).map((v) => v.vault.toLowerCase()));
  const state = (ctx.state.options ||= { cursor: 0 });
  const [count, now] = await Promise.all([desk.count(), blockTime(ctx.provider)]);
  let sent = 0;
  let cursor = state.cursor;
  let settledPrefix = true;
  for (let from = state.cursor; from < Number(count) && sent < cfg.maxPerCycle; from += PAGE) {
    const list = await desk.list(from, from + PAGE);
    for (let i = 0; i < list.length && sent < cfg.maxPerCycle; i++) {
      const id = from + i;
      const o = list[i];
      let pending = o.state === OPTION.Offered || o.state === OPTION.Active;
      // Income Vault options are released by their vault's closeRound.
      if (pending && now >= o.expiry && !vaults.has(o.writer.toLowerCase())) {
        const r = await exec(ctx, logger("options", `#${id}`), desk, "expire", [id], "release collateral");
        if (r.ok) {
          sent++;
          if (!r.simulated) pending = false;
        }
      }
      if (pending) settledPrefix = false;
      if (settledPrefix) cursor = id + 1;
    }
  }
  if (!ctx.dryRun) state.cursor = cursor;
  log.info("checked", { options: Number(count), from: state.cursor, released: sent });
}

module.exports = { notePauses, runBinaries, runOptions };

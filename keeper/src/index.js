#!/usr/bin/env node
// xStockFi keeper. See keeper/README.md.
//   node src/index.js           loop until stopped (dry run unless DRY_RUN=0)
//   node src/index.js --once    run one cycle and exit
const { ethers } = require("ethers");
const { loadConfig, loadDeployment, loadEnv } = require("./config");
const { logger } = require("./log");
const { reason } = require("./chain");
const { setupVaults, runVault } = require("./duties/liquidity");
const { setupIncome, runIncome } = require("./duties/income");
const { notePauses, runBinaries, runOptions } = require("./duties/markets");
const { runFeeRouter, runBuyBurn, runCreditLines } = require("./duties/fees");

const log = logger("keeper");
let stopping = false;
const fs = require("fs");
const path = require("path");

// Optional state file (KEEPER_STATE_FILE), so one-shot runs (GitHub Actions, cron) still respect the harvest and
// reserve-claim intervals and resume their scans. Only live runs write it: a dry run must not push back the first
// real harvest.
function loadState(file) {
  const state = { vaults: {}, desks: {}, binaries: { cursor: 0 }, options: { cursor: 0 } };
  if (!file || !fs.existsSync(file)) return state;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(s.vaults || {})) state.vaults[k] = { lastHarvest: Number(v.lastHarvest) || 0 };
    for (const [k, v] of Object.entries(s.desks || {}))
      state.desks[k] = { lastClaim: Number(v.lastClaim) || 0, accounts: new Set(v.accounts || []), scanned: v.scanned ?? null };
    if (s.binaries) state.binaries.cursor = Number(s.binaries.cursor) || 0;
    if (s.options) state.options.cursor = Number(s.options.cursor) || 0;
  } catch (e) {
    log.warn("ignoring unreadable state file", { file, reason: e.message });
  }
  return state;
}

function saveState(file, state) {
  if (!file) return;
  const out = { vaults: state.vaults, desks: {}, binaries: state.binaries, options: state.options };
  for (const [k, v] of Object.entries(state.desks)) out.desks[k] = { lastClaim: v.lastClaim, accounts: [...v.accounts], scanned: v.scanned };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
}

async function init() {
  const env = loadEnv();
  const cfg = loadConfig();
  const dep = loadDeployment(env.network);
  const provider = new ethers.JsonRpcProvider(env.rpcUrl, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (dep.chainId && Number(dep.chainId) !== chainId) {
    throw new Error(`RPC chainId ${chainId} does not match ${dep.file} (chainId ${dep.chainId})`);
  }

  let runner = provider;
  let keeper;
  if (env.privateKey) {
    const wallet = new ethers.Wallet(env.privateKey, provider); // the key itself is never logged
    // NonceManager hands out nonces locally, so back-to-back sends never reuse a stale pending count.
    runner = new ethers.NonceManager(wallet);
    keeper = wallet.address;
    if (env.keeperAddress && env.keeperAddress.toLowerCase() !== keeper.toLowerCase()) {
      log.warn("KEEPER_ADDRESS differs from the key's address; using the key's address", { keeper });
    }
  } else if (!env.dryRun) {
    throw new Error("KEEPER_PRIVATE_KEY is required when DRY_RUN=0");
  } else {
    keeper = env.keeperAddress || (dep.roles && dep.roles.keeper);
    if (!keeper) throw new Error("DRY_RUN without KEEPER_PRIVATE_KEY needs KEEPER_ADDRESS or roles.keeper in the deployment file");
    keeper = ethers.getAddress(keeper);
  }

  const stateFile = process.env.KEEPER_STATE_FILE || null;
  const ctx = { env, cfg, dep, provider, runner, keeper, dryRun: env.dryRun, stateFile, state: loadState(stateFile) };
  log.info("starting", {
    network: env.network,
    chainId,
    rpc: env.rpcUrl.replace(/\/\/([^/@]*@)/, "//***@"),
    keeper,
    mode: env.dryRun ? "DRY_RUN (simulate only)" : "LIVE (sends transactions)",
    deployment: dep.file,
    configOverride: cfg.overrideFile,
    intervalSec: cfg.loopIntervalSeconds,
  });
  if (!env.dryRun) {
    const bal = await provider.getBalance(keeper);
    log.info("keeper gas balance", { eth: ethers.formatEther(bal) });
    if (bal === 0n) log.warn("keeper has no ETH for gas");
  }
  ctx.vaults = await setupVaults(ctx);
  ctx.income = await setupIncome(ctx);
  return ctx;
}

// One pass over every duty. Each step is isolated: a failure is logged and the next step runs.
async function cycle(ctx, n) {
  const started = Date.now();
  log.info(`cycle ${n} start`, { block: await ctx.provider.getBlockNumber().catch(() => "?") });
  const steps = [
    ...ctx.income.map((v) => [`income ${v.ticker}`, () => runIncome(ctx, v)]),
    ...ctx.vaults.map((w) => [`liquidity ${w.ticker}`, () => runVault(ctx, w)]),
    ["pauses", () => notePauses(ctx)],
    ["binaries", () => runBinaries(ctx)],
    ["options", () => runOptions(ctx)],
    // Reserves go to the FeeRouter, the router forwards to BuyBurn, then BuyBurn spends them.
    ["credit", () => runCreditLines(ctx)],
    ["route", () => runFeeRouter(ctx)],
    ["buyburn", () => runBuyBurn(ctx)],
  ];
  for (const [name, fn] of steps) {
    if (stopping) return;
    try {
      await fn();
    } catch (e) {
      logger(name).error("unexpected failure", { reason: reason(e) });
    }
  }
  log.info(`cycle ${n} done`, { ms: Date.now() - started });
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    const check = setInterval(() => {
      if (stopping) {
        clearTimeout(t);
        clearInterval(check);
        resolve();
      }
    }, 500);
    setTimeout(() => clearInterval(check), ms + 10);
  });
}

async function main() {
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (stopping) process.exit(1);
      stopping = true;
      log.info(`${sig} received, stopping after the current step`);
    });
  }
  const ctx = await init();
  for (let n = 1; !stopping; n++) {
    try {
      await cycle(ctx, n);
    } catch (e) {
      log.error("cycle failed", { reason: reason(e) });
    }
    if (!ctx.dryRun) {
      try { saveState(ctx.stateFile, ctx.state); } catch (e) { log.warn("could not save state", { reason: e.message }); }
    }
    if (ctx.env.once) break;
    await sleep(ctx.cfg.loopIntervalSeconds * 1000);
  }
  log.info("stopped");
}

if (require.main === module) {
  main().catch((e) => {
    log.error("fatal", { reason: reason(e) });
    process.exit(1);
  });
}

module.exports = { init, cycle, loadState, saveState };

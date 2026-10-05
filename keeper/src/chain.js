// Simulate-then-send helper and revert decoding shared by all duties.
const { ethers } = require("ethers");
const abis = require("./abis");

// Every custom error across the protocol, so a revert bubbled up from a nested call
// (e.g. the swap adapter inside BuyBurn) still decodes to a name.
const errorIface = new ethers.Interface(
  Object.values(abis)
    .flat()
    .filter((f) => typeof f === "object" && f.type === "error")
    .filter((f, i, all) => all.findIndex((g) => g.name === f.name && JSON.stringify(g.inputs) === JSON.stringify(f.inputs)) === i)
);

function findRevertData(e) {
  for (let x = e, depth = 0; x && depth < 6; x = x.error || x.info?.error || x.cause, depth++) {
    if (typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) return x.data;
    if (typeof x.data?.data === "string") return x.data.data;
  }
  return null;
}

// Short, human-readable reason for a failed call or transaction.
function reason(e) {
  if (e?.revert?.name) return `${e.revert.name}(${e.revert.args.map(String).join(", ")})`;
  const data = findRevertData(e);
  if (data) {
    try {
      const p = errorIface.parseError(data);
      if (p) return `${p.name}(${p.args.map(String).join(", ")})`;
    } catch {}
    try {
      const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
      if (data.startsWith("0x08c379a0")) return `Error(${msg})`;
    } catch {}
    return `revert ${data.slice(0, 10)}`;
  }
  if (e?.reason) return e.reason;
  return (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 300);
}

// Simulates `contract.method(...args)` from the keeper, then sends it unless dry-running.
// Returns { ok, simulated, result, receipt, error }.
// `expected` lists revert names that are routine (e.g. "ZeroAmount") and only logged at info level.
async function exec(ctx, log, contract, method, args, what, expected = []) {
  const fn = contract.getFunction(method);
  let result;
  try {
    result = await fn.staticCall(...args, { from: ctx.keeper });
  } catch (e) {
    const why = reason(e);
    if (expected.some((name) => why.startsWith(name + "("))) log.info(`${what}: nothing to do`, { reason: why });
    else log.warn(`${what}: simulation reverted, skipping`, { reason: why });
    return { ok: false, error: e };
  }
  if (ctx.dryRun) {
    log.info(`${what}: DRY_RUN, would send`, { call: `${method}(${args.map(fmtArg).join(", ")})` });
    return { ok: true, simulated: true, result };
  }
  try {
    const tx = await fn.send(...args);
    log.info(`${what}: sent`, { tx: tx.hash, nonce: tx.nonce });
    const receipt = await tx.wait(ctx.cfg.txConfirmations || 1, (ctx.cfg.txTimeoutSeconds || 180) * 1000);
    log.info(`${what}: confirmed`, { tx: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, status: receipt.status });
    return { ok: receipt.status === 1, result, receipt };
  } catch (e) {
    // Resync the local nonce with the chain after any send failure.
    if (typeof ctx.runner.reset === "function") ctx.runner.reset();
    log.error(`${what}: transaction failed`, { reason: reason(e) });
    return { ok: false, error: e };
  }
}

function fmtArg(a) {
  if (Array.isArray(a)) return `[${a.map(fmtArg).join(",")}]`;
  if (typeof a === "string" && a.length > 66) return a.slice(0, 18) + "..(" + (a.length - 2) / 2 + "B)";
  return String(a);
}

async function blockTime(provider) {
  const b = await provider.getBlock("latest");
  return BigInt(b.timestamp);
}

module.exports = { exec, reason, blockTime };

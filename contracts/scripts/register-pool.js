// Registers the xStockFi token's Pons pool (token / ETH) on the swap adapter once the token has graduated on Pons,
// which is what lets BuyBurn buy and burn it. Checks the pool is live first. Read-only; sends nothing.
// Before the timelock owns the adapter it prints one direct transaction for the deployer; after, the timelock
// proposer's schedule and execute pair.
//   node scripts/register-pool.js [deployments/robinhood.json]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const POOLS_SLOT = 6n;
const ADAPTER_ABI = [
  "function setPool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)",
  "function poolFor(address a, address b) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool exists)",
  "function hookAllowed(address) view returns (bool)",
  "function owner() view returns (address)",
];
const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function getMinDelay() view returns (uint256)",
];

// Inspects the pool and adapter for deployment `d` and builds the registration transaction(s).
// Returns { status, ... } where status is one of: not-initialized, no-liquidity, hook-not-allowed, registered,
// direct (deployer still owns the adapter) or timelock.
async function plan(provider, d) {
  if (!d.token) {
    // The file may predate set-token; the contract is the source of truth.
    const bb = new ethers.Contract(d.buyBurn, ["function token() view returns (address)"], provider);
    const onchain = await bb.token();
    if (onchain === ethers.ZeroAddress) throw new Error("The token is not set yet. Run ./set-token.sh first.");
    d = { ...d, token: onchain };
  }
  const adapter = new ethers.Contract(d.swapAdapter, ADAPTER_ABI, provider);
  const pm = new ethers.Contract(config.uniswap.poolManager, ["function extsload(bytes32) view returns (bytes32)"], provider);
  const key = { currency0: ethers.ZeroAddress, currency1: d.token, fee: config.pons.poolFee, tickSpacing: config.pons.poolTickSpacing, hooks: config.pons.hook };
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const slot = ethers.keccak256(ethers.concat([id, ethers.toBeHex(POOLS_SLOT, 32)]));
  const sqrtP = BigInt(await pm.extsload(slot)) & ((1n << 160n) - 1n);
  const liquidity = BigInt(await pm.extsload(ethers.toBeHex(BigInt(slot) + 3n, 32))) & ((1n << 128n) - 1n);
  const raw = Number(sqrtP) / 2 ** 96;
  const base = { id, key, perEth: raw * raw, liquidity, token: d.token };
  if (sqrtP === 0n) return { status: "not-initialized", ...base };
  if (liquidity === 0n) return { status: "no-liquidity", ...base };
  if (!(await adapter.hookAllowed(config.pons.hook))) return { status: "hook-not-allowed", ...base };
  const [, exists] = await adapter.poolFor(ethers.ZeroAddress, d.token);
  if (exists) return { status: "registered", ...base };

  const setPool = adapter.interface.encodeFunctionData("setPool", [key]);
  const owner = await adapter.owner();
  if (owner.toLowerCase() !== d.timelock.toLowerCase()) {
    return { status: "direct", owner, tx: { to: d.swapAdapter, value: "0", data: setPool }, ...base };
  }
  const timelock = new ethers.Contract(d.timelock, TIMELOCK_ABI, provider);
  const delay = await timelock.getMinDelay();
  const targets = [d.swapAdapter], values = [0n], payloads = [setPool], predecessor = ethers.ZeroHash, salt = ethers.id("xstockfi-register-pool");
  const tl = new ethers.Interface(TIMELOCK_ABI);
  return {
    status: "timelock",
    delay,
    schedule: { to: d.timelock, value: "0", data: tl.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, delay]) },
    execute: { to: d.timelock, value: "0", data: tl.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]) },
    ...base,
  };
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "deployments", "robinhood.json"));
  if (!fs.existsSync(file)) throw new Error(`No deployment file at ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });
  const p = await plan(provider, d);
  console.log(`Token ${p.token}\nPons pool ${p.id}`);
  switch (p.status) {
    case "not-initialized":
      throw new Error("The token / ETH Pons pool is not initialized yet: the token has not graduated. Run this again after graduation.");
    case "no-liquidity":
      throw new Error("The Pons pool exists but has no liquidity yet. Run this again once graduation finishes.");
    case "hook-not-allowed":
      throw new Error(`The adapter does not allow the Pons hook ${config.pons.hook}; allow it first (deploy.js does this on live deploys).`);
  }
  console.log(`  live: ${p.perEth.toFixed(0)} tokens per ETH, liquidity ${p.liquidity}`);
  if (p.status === "registered") return console.log("Already registered on the adapter. Nothing to do.");
  if (p.status === "direct") {
    console.log(`\nThe adapter is still owned by ${p.owner} (handoff not executed yet). ./govern.sh register-pool sends this from it:`);
    return console.log(JSON.stringify(p.tx, null, 2));
  }
  console.log("\nStep 1, schedule (dev wallet, now). ./govern.sh register-pool sends it:");
  console.log(JSON.stringify(p.schedule, null, 2));
  console.log(`\nStep 2, execute (dev wallet, after ${Number(p.delay) / 3600}h):`);
  console.log(JSON.stringify(p.execute, null, 2));
}

module.exports = { plan };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}

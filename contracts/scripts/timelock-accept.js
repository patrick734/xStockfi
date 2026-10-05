// Prints the two timelock transactions that finish the ownership handoff after a live deploy: schedule
// acceptOwnership() on the oracle, registry and swap adapter now, execute it once the delay has passed.
// Also reports where the handoff stands. Read-only; sends nothing. scripts/handoff.js sends them.
//   node scripts/timelock-accept.js [deployments/robinhood.json]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
  "function getTimestamp(bytes32) view returns (uint256)",
];
const OWNABLE_ABI = ["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"];

// Builds the schedule/execute transactions for deployment `d` and reads where the handoff stands.
async function handoff(provider, d) {
  const targets = d.pendingTimelockAcceptances || [];
  if (!targets.length) throw new Error("The deployment lists no pending timelock acceptances.");
  const timelock = new ethers.Contract(d.timelock, TIMELOCK_ABI, provider);
  const ownable = new ethers.Interface(OWNABLE_ABI);
  const payloads = targets.map(() => ownable.encodeFunctionData("acceptOwnership"));
  const values = targets.map(() => 0n);
  const predecessor = ethers.ZeroHash;
  const salt = ethers.id("xstockfi-accept-ownership");
  const delay = await timelock.getMinDelay();
  const id = await timelock.hashOperationBatch(targets, values, payloads, predecessor, salt);

  const owners = [];
  for (const t of targets) {
    const c = new ethers.Contract(t, OWNABLE_ABI, provider);
    const [owner, pending] = await Promise.all([c.owner(), c.pendingOwner()]);
    owners.push({ target: t, owner, pending });
  }

  const [pendingOp, ready, done, ts] = await Promise.all([
    timelock.isOperationPending(id),
    timelock.isOperationReady(id),
    timelock.isOperationDone(id),
    timelock.getTimestamp(id),
  ]);
  const iface = new ethers.Interface(TIMELOCK_ABI);
  const schedule = { to: d.timelock, value: "0", data: iface.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, delay]) };
  const execute = { to: d.timelock, value: "0", data: iface.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]) };
  const status = done ? "done" : ready ? "ready" : pendingOp ? "scheduled" : "unscheduled";
  return { id, delay, owners, status, readyAt: Number(ts), schedule, execute };
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "deployments", "robinhood.json"));
  if (!fs.existsSync(file)) throw new Error(`No deployment file at ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });
  const { id, delay, owners, status, readyAt, schedule, execute } = await handoff(provider, d);
  const hours = Number(delay) / 3600;

  console.log(`Timelock ${d.timelock} (delay ${hours}h), proposer ${d.roles.admin}\n`);
  for (const { target, owner, pending } of owners) {
    const state =
      owner === d.timelock ? "done: owned by the timelock"
      : pending === d.timelock ? "waiting: timelock is pending owner"
      : `UNEXPECTED: owner ${owner}, pending ${pending}`;
    console.log(`  ${target}  ${state}`);
  }

  console.log(`\nOperation ${id}`);
  if (status === "done") console.log("Status: DONE. The handoff is complete.");
  else if (status === "ready") console.log("Status: READY. Run scripts/handoff.js again now.");
  else if (status === "scheduled") console.log(`Status: scheduled, executable after ${new Date(readyAt * 1000).toISOString()}.`);
  else console.log("Status: not scheduled yet. Run scripts/handoff.js to schedule it.");

  console.log("\nStep 1, schedule (sent by scripts/handoff.js from the dev wallet):");
  console.log(JSON.stringify(schedule, null, 2));
  console.log(`\nStep 2, execute (scripts/handoff.js again, after ${hours}h):`);
  console.log(JSON.stringify(execute, null, 2));
}

module.exports = { handoff };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}

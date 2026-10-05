// One-wallet timelock handoff, sent from the dev wallet (the timelock's proposer and executor).
// First run: schedules acceptOwnership() on the oracle, registry and swap adapter. Run again after the 48h delay:
// executes it. Otherwise it reports the status. Sends at most one transaction per run.
//   npx hardhat run scripts/handoff.js --network robinhood
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { handoff } = require("./timelock-accept");

async function main() {
  const label = network.name === "hardhat" ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/xstockfi-dev (or DEPLOYER_ACCOUNT) not found.");
  const h = await handoff(ethers.provider, d);
  console.log(`Timelock ${d.timelock}, operation ${h.id}, status ${h.status}`);
  if (h.status === "done") return console.log("The handoff is complete: the timelock owns every contract. The dev wallet keeps only its timelock and guardian roles, plus the one-time token setter until it is used.");
  if (h.status === "scheduled") return console.log(`Executable after ${new Date(h.readyAt * 1000).toISOString()}. Run this again then.`);
  if (h.status === "unscheduled") {
    const bad = h.owners.filter((o) => o.pending.toLowerCase() !== d.timelock.toLowerCase());
    if (bad.length) throw new Error(`Not scheduling: ${bad.map((o) => o.target).join(", ")} do not have the timelock as pending owner.`);
  }
  const tx = h.status === "ready" ? h.execute : h.schedule;
  const sent = await signer.sendTransaction({ to: tx.to, data: tx.data });
  console.log(`${h.status === "ready" ? "Executing" : "Scheduling"} from ${signer.address}: ${sent.hash}`);
  await sent.wait();
  console.log(h.status === "ready" ? "Done: the timelock owns everything." : `Scheduled. Run this again after ${Math.round(Number(h.delay) / 3600)}h.`);
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});

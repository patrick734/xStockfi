// Registers the token / ETH Pons pool once the token has graduated, sent from the dev wallet.
// Before the timelock handoff: one direct transaction. After: schedule now, run again after 48h to execute.
//   npx hardhat run scripts/register-pool-send.js --network robinhood
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { plan } = require("./register-pool");

const TL = [
  "function isOperationPending(bytes32) view returns (bool)",
  "function isOperationReady(bytes32) view returns (bool)",
  "function isOperationDone(bytes32) view returns (bool)",
  "function hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32) view returns (bytes32)",
];

async function main() {
  const label = network.name === "hardhat" ? "fork" : network.name;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${label}.json`), "utf8"));
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/xstockfi-dev (or DEPLOYER_ACCOUNT) not found.");
  const p = await plan(ethers.provider, d);
  console.log(`Token ${p.token}, Pons pool ${p.id}: ${p.status}`);
  if (["not-initialized", "no-liquidity", "hook-not-allowed"].includes(p.status)) throw new Error(`Not ready: ${p.status}. Run again after the token graduates.`);
  if (p.status === "registered") return console.log("Already registered. Nothing to do.");
  let tx;
  if (p.status === "direct") tx = p.tx;
  else {
    const tl = new ethers.Contract(d.timelock, TL, ethers.provider);
    const iface = new ethers.Interface(["function executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"]);
    const [targets, values, payloads, pred, salt] = iface.decodeFunctionData("executeBatch", p.execute.data);
    const id = await tl.hashOperationBatch(targets, values, payloads, pred, salt);
    if (await tl.isOperationReady(id)) tx = p.execute;
    else if (await tl.isOperationPending(id)) return console.log("Scheduled; run this again once the 48h delay has passed.");
    else tx = p.schedule;
  }
  const sent = await signer.sendTransaction({ to: tx.to, data: tx.data });
  console.log(`Sent from ${signer.address}: ${sent.hash}`);
  await sent.wait();
  console.log(tx === p.schedule ? "Scheduled. Run again after 48h to execute." : "Done: BuyBurn can now buy and burn the token.");
}

main().catch((e) => {
  console.error(e.shortMessage || e.message);
  process.exit(1);
});

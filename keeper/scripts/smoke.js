// End-to-end check of the keeper against a local Hardhat node running the seeded demo deployment.
//
// First terminal:   cd contracts && npx hardhat node --port 8547
// Second terminal:  cd contracts && npx hardhat run scripts/deploy.js --network keeper
//                   cd ../keeper && npm run smoke
//
// Refuses to run on anything but a Hardhat chain (31337): it moves time and pushes mock prices.
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8547";
const NETWORK = process.env.KEEPER_NETWORK || "keeper";
// Hardhat's well-known dev accounts (not secrets): #3 is the keeper deploy.js sets on local chains, #0 pushes
// mock prices.
const HARDHAT_KEEPER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const HARDHAT_ACCOUNT_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

process.env.KEEPER_NETWORK = NETWORK;
const { loadDeployment } = require("../src/config");
const abis = require("../src/abis");

const MOCK_FEED = ["function setAnswer(int256)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${msg}`);
  if (!ok) failures++;
};

function runKeeper(label, extraEnv = {}) {
  console.log(`\n===== keeper --once (${label}) =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), "--once"], {
    env: { ...process.env, RPC_URL, KEEPER_NETWORK: NETWORK, KEEPER_CONFIG: path.join(__dirname, "smoke.config.json"), ...extraEnv },
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out);
  if (r.status !== 0) {
    console.log(`  FAIL keeper exited with ${r.status}`);
    failures++;
  }
  return out;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  if (Number((await provider.getNetwork()).chainId) !== 31337) throw new Error("smoke test only runs against a local Hardhat node");
  const dep = loadDeployment(NETWORK);
  const signer = new ethers.NonceManager(new ethers.Wallet(HARDHAT_ACCOUNT_0, provider));
  const live = { DRY_RUN: "0", KEEPER_PRIVATE_KEY: HARDHAT_KEEPER_KEY };

  const desk = new ethers.Contract(dep.options, abis.Options, provider);
  const bin = new ethers.Contract(dep.binaries, abis.Binaries, provider);
  const vaults = Object.fromEntries(Object.entries(dep.incomeVaults).map(([t, v]) => [t, new ethers.Contract(v.vault, abis.IncomeVault, provider)]));
  const oracle = new ethers.Contract(dep.oracle, abis.Oracle, provider);
  const xsf = new ethers.Contract(dep.token, [...abis.ERC20, "function totalSupply() view returns (uint256)"], provider);

  async function pushPrices(bump = 1) {
    const usdgFeed = new ethers.Contract(await oracle.usdgFeed(), MOCK_FEED, signer);
    await (await usdgFeed.setAnswer(100_000_000n)).wait();
    for (const m of Object.values(dep.markets)) {
      const f = new ethers.Contract(m.feed, MOCK_FEED, signer);
      const [, a] = await f.latestRoundData();
      await (await f.setAnswer((a * BigInt(Math.round(bump * 1000))) / 1000n)).wait();
    }
  }
  async function warp(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  // 1. Dry run: simulates everything, sends nothing.
  const countBefore = await desk.count();
  const dry = runKeeper("dry run");
  check(/DRY_RUN, would send/.test(dry) || /nothing to/.test(dry), "dry run simulates");
  check((await desk.count()) === countBefore, "dry run sent nothing");

  // 2. Live, mid-round: the keeper tops up the round with another put where budget allows.
  await pushPrices();
  runKeeper("live, mid-round", live);
  const quoted = Number(await desk.count()) - Number(countBefore);
  check(quoted > 0, `keeper quoted ${quoted} new option(s) for the Income Vaults`);
  check((await bin.list(0, 10)).some((b) => b.state === 2n), "a matched bet is waiting for expiry");

  // 3. Past the binaries' expiry (3 days) and the rounds' (7 days): settle, refund, close.
  await warp(8 * 24 * 3600);
  await pushPrices(1.01);
  const supplyBefore = await xsf.totalSupply();
  const out = runKeeper("live, after expiry", live);
  const bets = await bin.list(0, 10);
  check(bets[0].state === 3n || bets[0].state === 4n, `matched bet settled (state ${bets[0].state})`);
  check(bets.slice(1).every((b) => b.state === 5n), "unjoined bets refunded");
  for (const [t, v] of Object.entries(vaults)) check(!(await v.live()), `${t} Income Vault round closed`);
  check(/buying and burning|rate limited|no fees waiting/.test(out), "buy and burn ran");
  check((await xsf.totalSupply()) < supplyBefore, "fees bought and burned some XSF");

  // 4. Next cycle starts fresh rounds and quotes them.
  await pushPrices();
  runKeeper("live, new rounds", live);
  for (const [t, v] of Object.entries(vaults)) {
    const opts = await v.roundOptions();
    check((await v.live()) && opts.length > 0, `${t} Income Vault started a new round with ${opts.length} quote(s)`);
  }

  // 5. Past the desk's own 14-day options: their writers get the collateral back.
  await warp(7 * 24 * 3600);
  await pushPrices();
  runKeeper("live, desk expiry", live);
  const all = await desk.list(0, await desk.count());
  const writersBack = all.filter((o) => !Object.values(dep.incomeVaults).some((v) => v.vault === o.writer)).every((o) => o.state !== 1n && o.state !== 2n);
  check(writersBack, "every expired desk option returned its collateral");

  console.log(failures ? `\n${failures} smoke check(s) FAILED` : "\nsmoke test passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

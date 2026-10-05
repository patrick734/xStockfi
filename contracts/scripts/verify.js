// Publishes the source code of every deployed xStockFi contract on the Robinhood Chain explorer.
// Read-only: no wallet, no key, no gas. Run by ../verify.sh. Already-verified contracts are skipped.
//
//   1. Sourcify (sourcify.dev): the open verification database. Scripts are welcome there, and the Robinhood Chain
//      explorer (Blockscout) reads verified sources from it.
//   2. The explorer itself (robinhoodchain.blockscout.com), directly. Its Cloudflare check usually turns scripts
//      away; with VERIFY_API_KEY (free key from dev.blockscout.com) it also tries Blockscout's developer API.
//   Anything still unverified gets an upload file in verify-files/ for verifying in the browser.
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const ROOT = path.join(__dirname, "..", "..");
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const KEY = (process.env.VERIFY_API_KEY || "").trim();
const BROWSER = (process.env.VERIFY_BROWSER_URL || "https://robinhoodchain.blockscout.com").replace(/\/$/, "");
const SOURCIFY = (process.env.VERIFY_SOURCIFY_URL || "https://sourcify.dev/server").replace(/\/$/, "");
const DEPLOYMENT = process.env.VERIFY_DEPLOYMENT || path.join(__dirname, "..", "deployments", "robinhood.json");
const MANUAL_DIR = path.join(ROOT, "verify-files");
const SOLC = "0.8.26+commit.8a97fa7a";
const CHAIN = 4663;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- Sourcify

async function sjson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 120) };
  }
}

async function sourcifyMatch(address) {
  const res = await fetch(`${SOURCIFY}/v2/contract/${CHAIN}/${address}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  const j = await sjson(res);
  if (!res.ok) throw new Error(`Sourcify ${res.status}: ${j.message || j._raw || ""}`);
  return j.match || null;
}

async function sourcifyVerify(c) {
  const res = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${c.address}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ stdJsonInput: c.input, compilerVersion: SOLC, contractIdentifier: c.fqn }),
  });
  const j = await sjson(res);
  if (res.status === 409 || j.customCode === "already_verified") return "already verified";
  if (!res.ok || !j.verificationId) throw new Error(j.message || j._raw || `Sourcify ${res.status}`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    const s = await sjson(await fetch(`${SOURCIFY}/v2/verify/${j.verificationId}`, { headers: { accept: "application/json" } }));
    if (!s.isJobCompleted) continue;
    if (s.error) throw new Error(s.error.message || s.error.customCode || "verification failed");
    const m = s.contract && (s.contract.match || s.contract.runtimeMatch || s.contract.creationMatch);
    if (m) return m === "exact_match" ? "verified (exact match)" : "verified";
    throw new Error("no match");
  }
  throw new Error("Sourcify is still working on it; run ./verify.sh again in a few minutes");
}

// ---------------------------------------------------------------- Blockscout (explorer)

const HOSTS = [
  ...(KEY ? [{ name: "Blockscout developer API", url: process.env.VERIFY_PRO_API_URL || "https://api.blockscout.com/4663/api", key: KEY }] : []),
  { name: "explorer", url: process.env.VERIFY_API_URL || "https://robinhoodchain.blockscout.com/api" },
];
class Blocked extends Error {}
let route = null;

async function request(host, params, post) {
  const url = new URL(host.url);
  if (host.key) url.searchParams.set("apikey", host.key);
  const body = new URLSearchParams(params);
  if (host.key) body.set("apikey", host.key);
  const headers = { "user-agent": UA, accept: "application/json" };
  let res;
  if (post) {
    res = await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body });
  } else {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetch(url, { headers });
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const cf = /just a moment|cf-chl|cloudflare/i.test(text);
    throw new Blocked(`${res.status}${cf ? " (Cloudflare check)" : ""}: ${text.replace(/\s+/g, " ").slice(0, 90)}`);
  }
}

async function findRoute(probe) {
  for (const host of HOSTS) {
    try {
      const j = await request(host, { module: "contract", action: "getsourcecode", address: probe });
      if (/invalid api|api key|unauthori|forbidden/i.test(JSON.stringify(j).slice(0, 400)) && !Array.isArray(j.result)) {
        console.log(`  ${host.name}: ${String(j.message || j.result).slice(0, 120)}`);
        continue;
      }
      return host;
    } catch (e) {
      console.log(`  ${host.name}: ${e.message}`);
    }
  }
  return null;
}

async function explorerVerified(address) {
  const j = await request(route, { module: "contract", action: "getsourcecode", address });
  const r = Array.isArray(j.result) ? j.result[0] : null;
  return Boolean(r && r.SourceCode);
}

async function explorerVerify(c) {
  const sent = await request(
    route,
    {
      module: "contract",
      action: "verifysourcecode",
      codeformat: "solidity-standard-json-input",
      contractaddress: c.address,
      contractname: c.fqn,
      compilerversion: `v${SOLC}`,
      constructorArguements: c.args || "",
      sourceCode: JSON.stringify(c.input),
    },
    true,
  );
  const msg = String(sent.result ?? sent.message ?? "");
  if (/already verified/i.test(msg)) return;
  if (String(sent.status) !== "1") throw new Error(msg || "submission refused");
  for (let i = 0; i < 45; i++) {
    await sleep(4000);
    const st = await request(route, { module: "contract", action: "checkverifystatus", guid: msg });
    const s = String(st.result ?? st.message ?? "");
    if (/pass|already verified/i.test(s)) return;
    if (/fail|unable|error/i.test(s)) throw new Error(s);
  }
  if (await explorerVerified(c.address)) return;
  throw new Error("still in the explorer's queue");
}

// ---------------------------------------------------------------- contracts

async function compiled(label, name, address) {
  const a = await hre.artifacts.readArtifact(name);
  const fqn = `${a.sourceName}:${a.contractName}`;
  const bi = await hre.artifacts.getBuildInfo(fqn);
  // Only the files this contract is built from (listed in its metadata): reproduces the same bytecode.
  const meta = JSON.parse(bi.output.contracts[a.sourceName][a.contractName].metadata);
  const sources = Object.fromEntries(Object.keys(meta.sources).map((k) => [k, bi.input.sources[k]]));
  return { label, address, fqn, input: { language: "Solidity", sources, settings: bi.input.settings }, args: "" };
}

/** Where in a compiler input a path from this computer still appears (the field, never the value). */
function localPathAt(obj, home, at = "input") {
  if (typeof obj === "string") return (home.length > 3 && obj.includes(home)) || /\/Users\/[^/"]+\//.test(obj) ? at : null;
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if ((home.length > 3 && k.includes(home)) || /\/Users\/[^/"]+\//.test(k)) return `${at} (a key)`;
      const hit = localPathAt(v, home, Array.isArray(obj) ? `${at}[${k}]` : k === "content" ? `${at}.content` : `${at}.${k.length > 40 ? k.slice(0, 40) + "…" : k}`);
      if (hit) return hit;
    }
  }
  return null;
}

function writeManual(list) {
  fs.rmSync(MANUAL_DIR, { recursive: true, force: true });
  if (!list.length) return;
  fs.mkdirSync(MANUAL_DIR, { recursive: true });
  const lines = [
    "Verify each contract in the browser (about a minute each):",
    "  1. Open the link below, tab Contract, click 'Verify & publish'.",
    "  2. Verification method: Solidity (Standard JSON input).",
    `  3. Compiler: v${SOLC}.`,
    "  4. Upload the .json file listed for that contract.",
    "  5. Leave 'Try to fetch constructor args automatically' ticked (or paste the constructor arguments shown).",
    "",
  ];
  list.forEach((c, i) => {
    const file = `${String(i + 1).padStart(2, "0")}-${c.label.replace(/[^A-Za-z0-9]+/g, "-").replace(/-$/, "")}.json`;
    fs.writeFileSync(path.join(MANUAL_DIR, file), JSON.stringify(c.input));
    lines.push(c.label, `  ${BROWSER}/address/${c.address}?tab=contract`, `  contract name: ${c.fqn.split(":")[1]}   file: ${file}`);
    if (c.args) lines.push(`  constructor arguments: ${c.args}`);
    lines.push("");
  });
  fs.writeFileSync(path.join(MANUAL_DIR, "README.txt"), lines.join("\n"));
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT)) throw new Error(`No deployment at ${DEPLOYMENT}. Run this in the folder you deployed from.`);
  const d = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));

  const plan = [];
  const add = async (label, name, address) => address && plan.push(await compiled(label, name, address));
  await add("XStockFiTimelock", "XStockFiTimelock", d.timelock);
  await add("XStockFiOracle", "XStockFiOracle", d.oracle);
  await add("XStockFiOptions", "XStockFiOptions", d.options);
  await add("XStockFiBinaries", "XStockFiBinaries", d.binaries);
  await add("XStockFiSwapAdapter", "XStockFiSwapAdapter", d.swapAdapter);
  await add("XStockFiBuyBurn", "XStockFiBuyBurn", d.buyBurn);
  await add("XStockFiFeeRouter", "XStockFiFeeRouter", d.feeRouter);
  await add("XStockFiRegistry", "XStockFiRegistry", d.registry);
  for (const [t, v] of Object.entries(d.incomeVaults || {})) await add(`XStockFiIncomeVault ${t}`, "XStockFiIncomeVault", v.vault);
  for (const [t, v] of Object.entries(d.liquidityVaults || {})) {
    await add(`XStockFiLiquidityVault ${t}`, "XStockFiLiquidityVault", v.vault);
    await add(`XStockFiPosition ${t}`, "XStockFiPosition", v.position);
  }
  for (const [t, desk] of Object.entries(d.creditLines || {})) await add(`XStockFiCreditDesk ${t}`, "XStockFiCreditDesk", desk);

  // Published source must not carry anything from this Mac (user name, folders).
  const home = os.homedir();
  for (const c of plan) {
    const at = localPathAt(c.input, home);
    if (at) throw new Error(`STOPPED: the compiler input for ${c.label} still contains a path from this computer (in ${at}). Nothing was sent.`);
  }

  console.log(`${plan.length} contracts.\n\n1/2 Sourcify (open verification database, read by the explorer)`);
  const sourcifyFailed = [];
  for (const c of plan) {
    process.stdout.write(`  ${c.label.padEnd(30)} ${c.address}  `);
    try {
      const m = await sourcifyMatch(c.address);
      console.log(m ? "already verified" : await sourcifyVerify(c));
    } catch (e) {
      console.log(`not verified: ${String(e.message).split("\n")[0].slice(0, 160)}`);
      sourcifyFailed.push(c);
    }
    await sleep(300);
  }

  console.log("\n2/2 Robinhood Chain explorer");
  route = await findRoute(plan[0].address);
  let explorerFailed = plan;
  if (route) {
    console.log(`  using the ${route.name}`);
    explorerFailed = [];
    for (const c of plan) {
      process.stdout.write(`  ${c.label.padEnd(30)} ${c.address}  `);
      try {
        if (await explorerVerified(c.address)) console.log("already verified");
        else {
          await explorerVerify(c);
          console.log("verified");
        }
      } catch (e) {
        console.log(`not verified: ${String(e.message).split("\n")[0].slice(0, 160)}`);
        explorerFailed.push(c);
        if (e instanceof Blocked) {
          explorerFailed.push(...plan.slice(plan.indexOf(c) + 1));
          break;
        }
      }
      await sleep(400);
    }
  } else {
    console.log("  The explorer only lets browsers in. It picks up the Sourcify verification on its own.");
  }

  const sourcifyOk = plan.length - sourcifyFailed.length;
  const explorerOk = plan.length - explorerFailed.length;
  console.log(`\nSourcify: ${sourcifyOk} of ${plan.length} verified.${route ? ` Explorer: ${explorerOk} of ${plan.length}.` : ""}`);
  console.log(`Check: ${BROWSER}/address/${plan[0].address}?tab=contract   and   https://repo.sourcify.dev/${CHAIN}/${plan[0].address}`);

  // Browser upload files for anything the explorer has not confirmed (a backup if it is slow to read Sourcify).
  writeManual(explorerFailed);
  if (explorerFailed.length && !route && sourcifyOk === plan.length) {
    console.log("Backup: verify-files/ holds a browser upload file per contract, in case the explorer has not shown them within an hour.");
  }
  const nowhere = sourcifyFailed.filter((c) => explorerFailed.includes(c));
  if (nowhere.length) process.exitCode = route ? 1 : 3;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

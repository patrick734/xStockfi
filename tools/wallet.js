// Wallet helpers for launch. Private keys are generated, encrypted and used in memory only; nothing here prints one.
//
//   node tools/wallet.js create <name>          new keystore ~/.foundry/keystores/<name>, password in ~/.foundry/xstockfi.pw
//   node tools/wallet.js address <name>         prints the address of a keystore
//   node tools/wallet.js keeper-secret <owner/repo>  new keeper wallet; the key goes straight into the GitHub
//                                                    secret KEEPER_PRIVATE_KEY via the gh CLI; prints the address only
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Wallet } = require(require.resolve("ethers", { paths: [path.join(__dirname, "..", "contracts")] }));

const dir = path.join(os.homedir(), ".foundry", "keystores");
const pwFile = process.env.DEPLOYER_PASSWORD_FILE || path.join(os.homedir(), ".foundry", "xstockfi.pw");
const [cmd, name] = process.argv.slice(2);

function password(create = false) {
  if (!fs.existsSync(pwFile)) {
    if (!create) { console.error(`Missing password file ${pwFile}. Restore it from your backup.`); process.exit(1); }
    fs.mkdirSync(path.dirname(pwFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pwFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(pwFile, "utf8").trim();
}

if (cmd === "create") {
  if (!name || !/^[\w.-]+$/.test(name)) throw new Error("usage: create <name>");
  const file = path.join(dir, name);
  if (fs.existsSync(file)) { console.error(`${file} already exists; not replacing it.`); process.exit(1); }
  const w = Wallet.createRandom();
  const json = w.encryptSync(password(true)).replace("\"Crypto\":", "\"crypto\":"); // lowercase key: Foundry and MetaMask expect it
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, json, { mode: 0o600 });
  console.log(w.address);
} else if (cmd === "address") {
  const file = path.join(dir, name || "");
  if (!name || !fs.existsSync(file)) { console.error(`No keystore ${file}`); process.exit(1); }
  const pw = password();
  try { console.log(Wallet.fromEncryptedJsonSync(fs.readFileSync(file, "utf8"), pw).address); }
  catch { console.error(`${pwFile} does not unlock ${file}.`); process.exit(1); }
} else if (cmd === "keeper-secret") {
  const { spawnSync } = require("child_process");
  const repo = name;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("usage: keeper-secret <owner/repo>");
  const list = spawnSync("gh", ["secret", "list", "-R", repo], { encoding: "utf8" });
  if (list.status !== 0) { console.error(`gh could not read ${repo}: ${(list.stderr || "").trim()}\nRun: gh auth login`); process.exit(1); }
  if (/^KEEPER_PRIVATE_KEY\b/m.test(list.stdout) && process.env.FORCE !== "1") {
    console.error(`KEEPER_PRIVATE_KEY already exists in ${repo}; not replacing it (FORCE=1 to replace).`);
    process.exit(1);
  }
  const w = Wallet.createRandom();
  const set = spawnSync("gh", ["secret", "set", "KEEPER_PRIVATE_KEY", "-R", repo], { input: w.privateKey, encoding: "utf8" });
  if (set.status !== 0) { console.error(`could not store the secret: ${(set.stderr || "").trim()}`); process.exit(1); }
  console.log(w.address);
} else {
  console.error("usage: create <name> | address <name> | keeper-secret <owner/repo>");
  process.exit(1);
}

// Imports a wallet you created yourself (in MetaMask, for example) into an encrypted Foundry keystore, reading the
// key from the clipboard (macOS). The key is never shown or typed, and the clipboard is cleared right after.
//   node tools/import-key.js [name]
// The default name is xstockfi-dev.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execSync } = require("child_process");
const { Wallet } = require(require.resolve("ethers", { paths: [path.join(__dirname, "..", "contracts")] }));

const name = process.argv[2] || "xstockfi-dev";
const dir = path.join(os.homedir(), ".foundry", "keystores");
const file = path.join(dir, name);
const pwFile = process.env.DEPLOYER_PASSWORD_FILE || path.join(os.homedir(), ".foundry", "xstockfi.pw");
if (fs.existsSync(file)) { console.error(`${file} already exists; not replacing it.`); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Copy the PRIVATE KEY of your wallet from your wallet app, then press Enter: ", () => {
  rl.close();
  let key = execSync("pbpaste").toString().replace(/\s/g, "");
  execSync("pbcopy", { input: "" }); // clear the clipboard
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    key = "";
    console.error("That isn't a private key (wrong length). Nothing saved. Copy it again and rerun.");
    process.exit(1);
  }
  const w = new Wallet(key.startsWith("0x") ? key : "0x" + key);
  key = "";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  const json = w.encryptSync(fs.readFileSync(pwFile, "utf8").trim()).replace('"Crypto":', '"crypto":');
  fs.writeFileSync(file, json, { mode: 0o600 });
  console.log(`wallet saved as ${name}: ${w.address}`);
});

// Loads keeper settings, the deployment addresses and the environment.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONTRACTS = path.join(ROOT, "..", "contracts");
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadConfig() {
  let cfg = readJson(path.join(ROOT, "config.json"));
  if (process.env.KEEPER_CONFIG) {
    const file = path.resolve(process.env.KEEPER_CONFIG);
    cfg = merge(cfg, readJson(file));
    cfg.overrideFile = file;
  }
  if (process.env.LOOP_INTERVAL_SECONDS) cfg.loopIntervalSeconds = Number(process.env.LOOP_INTERVAL_SECONDS);
  return cfg;
}

function loadDeployment(network) {
  const dir = process.env.KEEPER_DEPLOYMENTS_DIR || path.join(CONTRACTS, "deployments");
  const file = path.join(dir, `${network}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Set KEEPER_NETWORK to one that exists.`);
  return { file, ...readJson(file) };
}

function loadEnv() {
  const pk = process.env.KEEPER_PRIVATE_KEY;
  return {
    rpcUrl: process.env.RPC_URL || DEFAULT_RPC,
    network: process.env.KEEPER_NETWORK || "robinhood",
    // Dry run unless explicitly turned off.
    dryRun: process.env.DRY_RUN !== "0",
    privateKey: pk ? (pk.startsWith("0x") ? pk : "0x" + pk) : null,
    // Address to simulate from when running dry without a key. Defaults to deployment roles.keeper.
    keeperAddress: process.env.KEEPER_ADDRESS || null,
    once: process.argv.includes("--once") || process.env.KEEPER_ONCE === "1",
  };
}

module.exports = { loadConfig, loadDeployment, loadEnv, CONTRACTS };

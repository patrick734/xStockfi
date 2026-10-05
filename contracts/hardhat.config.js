require("@nomicfoundation/hardhat-toolbox");
require("./solc-override");

const fs = require("fs");
const os = require("os");
const path = require("path");

const { ROBINHOOD_RPC_URL, DEPLOYER_ACCOUNT, DEPLOYER_PASSWORD_FILE, FORK, FORK_BLOCK } = process.env;
const RPC = ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

// The deployer signs from an encrypted keystore (~/.foundry/keystores/<DEPLOYER_ACCOUNT>) unlocked with a
// password file. The key is decrypted in memory only, only for --network robinhood, and never printed or written.
function deployerAccounts() {
  if (!process.argv.includes("robinhood") && process.env.HARDHAT_NETWORK !== "robinhood") return [];
  const ks = path.join(os.homedir(), ".foundry", "keystores", DEPLOYER_ACCOUNT || "xstockfi-dev");
  if (!fs.existsSync(ks)) return [];
  const pw = DEPLOYER_PASSWORD_FILE || path.join(os.homedir(), ".foundry", "xstockfi.pw");
  const { Wallet } = require("ethers");
  const wallet = Wallet.fromEncryptedJsonSync(fs.readFileSync(ks, "utf8"), fs.readFileSync(pw, "utf8").trim());
  return [wallet.privateKey];
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  paths: {
    sources: "./src",
    tests: FORK ? "./test/fork" : "./test/unit",
  },
  mocha: { timeout: FORK ? 600_000 : 60_000 },
  networks: {
    hardhat: {
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
      ...(FORK && {
        chainId: 4663,
        forking: { url: RPC, ...(FORK_BLOCK && { blockNumber: Number(FORK_BLOCK) }) },
      }),
    },
    // Local node on a separate port, used by the keeper's tests (keeper/README.md).
    keeper: { url: "http://127.0.0.1:8547" },
    robinhood: {
      url: RPC,
      chainId: 4663,
      accounts: deployerAccounts(),
    },
    // Read-only connection for source verification (scripts/verify.js): no wallet is unlocked.
    explorer: { url: RPC, chainId: 4663 },
  },
  // Source verification on the Robinhood Chain explorer (Blockscout). Public and free: no API key.
  etherscan: { enabled: false },
  sourcify: { enabled: false },
  blockscout: {
    enabled: true,
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: process.env.VERIFY_API_URL || "https://robinhoodchain.blockscout.com/api",
          browserURL: process.env.VERIFY_BROWSER_URL || "https://robinhoodchain.blockscout.com",
        },
      },
    ],
  },
};

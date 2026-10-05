// Plugs the xStockFi token into a deployment made before it launched: calls BuyBurn.setToken once, from the
// deployer (the recorded tokenSetter), after checking the token. Permanent once sent.
//   XSF_TOKEN_ADDRESS=0x... npx hardhat run scripts/set-token.js --network robinhood
// Updates deployments/<network>.json so the website and the keeper pick the address up.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ERC20 = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function burn(uint256)",
];

/** A usable token: a contract with 18 decimals and a real burn(uint256). */
async function checkToken(address) {
  if (!address || !ethers.isAddress(address)) throw new Error("XSF_TOKEN_ADDRESS is not a valid address");
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at ${address}`);
  const token = new ethers.Contract(address, ERC20, ethers.provider);
  const [symbol, name, decimals, supply] = await Promise.all([token.symbol(), token.name(), token.decimals(), token.totalSupply()]);
  if (decimals !== 18n) throw new Error(`The token must have 18 decimals, got ${decimals}`);
  const probe = (amount) =>
    ethers.provider
      .call({ from: "0x0000000000000000000000000000000000000001", to: address, data: token.interface.encodeFunctionData("burn", [amount]) })
      .then(() => true, () => false);
  // A real burn accepts 0 and refuses more than the caller holds; a catch-all fallback would accept both.
  if (!(await probe(0n)) || (await probe(10n ** 30n))) throw new Error(`${symbol} at ${address} has no working burn(uint256), which BuyBurn needs`);
  return { symbol, name, supply };
}

async function setToken(file, address, signer) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const buyBurn = await ethers.getContractAt("XStockFiBuyBurn", d.buyBurn, signer);
  const [current, setter] = await Promise.all([buyBurn.token(), buyBurn.tokenSetter()]);
  const save = async (addr) => {
    const { symbol, name } = await checkToken(addr);
    d.token = ethers.getAddress(addr);
    d.tokenSymbol = symbol;
    d.tokenName = name;
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
    console.log(`Updated ${path.relative(process.cwd(), file)}.`);
  };
  if (current !== ethers.ZeroAddress) {
    if (current.toLowerCase() !== address.toLowerCase()) throw new Error(`The token is already set to ${current} and can never change.`);
    console.log(`The token is already set to ${current}. Nothing to send.`);
    if (d.token !== current || !d.tokenSymbol) await save(current); // e.g. an earlier run mined but lost its confirmation
    return null;
  }
  if (setter.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only ${setter} can set the token; this wallet is ${signer.address}. Use the dev wallet that deployed.`);
  }
  const { symbol, supply } = await checkToken(address);
  console.log(`Setting the token to ${symbol} ${address} (supply ${ethers.formatEther(supply)}). This is permanent.`);
  const tx = await buyBurn.setToken(address);
  await tx.wait();
  await save(address);
  console.log(`Done: ${tx.hash}`);
  return tx.hash;
}

async function main() {
  const label = network.name === "hardhat" ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Deploy first.`);
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No dev wallet signer: keystore ~/.foundry/keystores/xstockfi-dev (or DEPLOYER_ACCOUNT) not found.");
  await setToken(file, process.env.XSF_TOKEN_ADDRESS, signer);
}

module.exports = { checkToken, setToken };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}

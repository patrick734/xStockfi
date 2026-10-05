// Deploys xStockFi.
//   Local demo (mock tokens and feeds, seeded):  npx hardhat run scripts/deploy.js --network localhost
//   Robinhood Chain:                              npx hardhat run scripts/deploy.js --network robinhood
// Live deploys read their roles from the environment: ADMIN_MULTISIG (the timelock's proposer and executor),
// GUARDIAN_MULTISIG and KEEPER_ADDRESS. launch.sh sets all of them.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");

// DEPLOY_LIVE=1 runs the live path against a local copy of the chain (FORK=1), as a rehearsal.
const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
const REAL_ROLES = network.name === "robinhood";
const L = config.launch;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));
const ADMIN = ethers.ZeroHash;

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(24)} ${await c.getAddress()}`);
  return c;
}

const send = async (p) => (await p).wait();

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const roles = REAL_ROLES
    ? { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS") }
    : process.env.LOCAL_SINGLE_WALLET === "1"
      ? { admin: deployer.address, guardian: deployer.address, keeper: rest[2].address }
      : { admin: rest[0].address, guardian: rest[1].address, keeper: rest[2].address };

  console.log(`Deploying xStockFi to ${network.name} from ${deployer.address}`);
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    roles,
    markets: {},
    liquidityVaults: {},
    creditLines: {},
    incomeVaults: {},
  };

  const timelock = await deploy("XStockFiTimelock", [LIVE ? L.timelockDelaySeconds : 60, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  out.timelock = await timelock.getAddress();
  out.block = (await timelock.deploymentTransaction().wait()).blockNumber;

  const env = LIVE ? liveEnv() : await localEnv();
  out.usdg = env.usdg;

  // A live deploy normally goes out before the token launches on Pons: BuyBurn then starts without a token and the
  // deployer sets it once with set-token.sh. The local demo mints its own.
  const pendingToken = LIVE && !process.env.XSF_TOKEN_ADDRESS;
  const token = process.env.XSF_TOKEN_ADDRESS
    ? await existingToken(process.env.XSF_TOKEN_ADDRESS)
    : pendingToken
      ? null
      : await localToken(deployer, env.swap, env.usdg, env.stocks);
  out.token = token ? await token.getAddress() : null;
  out.tokenSetter = pendingToken ? deployer.address : null;
  if (pendingToken) console.log(`  ${"token".padEnd(24)} not yet: set it after the Pons launch with ./set-token.sh`);

  const oracle = await deploy("XStockFiOracle", [deployer.address, env.sequencerFeed, env.usdgFeed, config.chainlink.usdgMaxAge, config.tokens.usdg.decimals]);
  out.oracle = await oracle.getAddress();

  const swap = LIVE ? await deploy("XStockFiSwapAdapter", [deployer.address, config.uniswap.poolManager, env.usdg]) : env.swap;
  out.swapAdapter = await swap.getAddress();
  if (LIVE) {
    // Buy-and-burn path: fee token, USDG, native ETH, then the token's Pons pool (registered after graduation by
    // ./govern.sh register-pool). The Pons hook and the hookless ETH/USDG leg go in now.
    await send(swap.setHookAllowed(config.pons.hook, true));
    const eth = config.uniswap.ethUsdgPool;
    await send(swap.setPool({ currency0: ethers.ZeroAddress, currency1: env.usdg, fee: eth.fee, tickSpacing: eth.tickSpacing, hooks: ethers.ZeroAddress }));
    console.log(`  Pons hook allowed; ETH/USDG ${eth.fee}/${eth.tickSpacing} pool registered`);
  }

  const buyBurn = await deploy("XStockFiBuyBurn", [
    token ?? ethers.ZeroAddress,
    swap,
    deployer.address,
    roles.guardian,
    roles.keeper,
    L.buyBurnMinIntervalSeconds,
    pendingToken ? deployer.address : ethers.ZeroAddress,
  ]);
  out.buyBurn = await buyBurn.getAddress();
  // Small runs: a freshly graduated Pons pool is thin, so big buys would move its price a lot.
  await send(buyBurn.setInputLimit(env.usdg, usdgUnits(L.buyBurnMaxUsdgPerRun)));

  const feeRouter = await deploy("XStockFiFeeRouter", [out.timelock, buyBurn]);
  out.feeRouter = await feeRouter.getAddress();
  const registry = await deploy("XStockFiRegistry", [deployer.address]);
  out.registry = await registry.getAddress();

  const options = await deploy("XStockFiOptions", [env.usdg, oracle, feeRouter, deployer.address, roles.guardian, usdgUnits(L.options.minNotionalUsdg)]);
  out.options = await options.getAddress();
  const binaries = await deploy("XStockFiBinaries", [env.usdg, oracle, feeRouter, deployer.address, roles.guardian, usdgUnits(L.binaries.minStakeUsdg)]);
  out.binaries = await binaries.getAddress();
  if (L.options.feeBps !== 100) await send(options.setFee(L.options.feeBps));
  if (L.binaries.feeBps !== 100) await send(binaries.setFee(L.binaries.feeBps));

  console.log("Markets");
  for (const ticker of Object.keys(env.stocks)) {
    const t = env.stocks[ticker];
    await send(oracle.setFeed(t.address, t.feed, config.chainlink.stockMaxAge));
    await send(options.setMarket(t.address, true));
    await send(binaries.setMarket(t.address, true));
    out.markets[ticker] = { token: t.address, feed: t.feed, name: t.name };
  }
  console.log(`  ${Object.keys(out.markets).length} listed on the options desk and binaries: ${Object.keys(out.markets).join(" ")}`);

  const pooled = new Set([...L.liquidityVaults, ...L.incomeVaults]);
  if (LIVE) {
    for (const ticker of pooled) {
      const t = env.stocks[ticker];
      await send(swap.setPool(poolKey(t.address, env.usdg, t.fee, t.tickSpacing)));
    }
  }

  console.log("Liquidity Vaults");
  for (const ticker of L.liquidityVaults) {
    const t = env.stocks[ticker];
    await send(buyBurn.setInputLimit(t.address, wad(L.buyBurnMaxStockPerRun)));
    const position = LIVE
      ? await deploy("XStockFiPosition", [
          config.uniswap.poolManager,
          config.uniswap.positionManager,
          config.uniswap.permit2,
          oracle,
          poolKey(t.address, env.usdg, t.fee, t.tickSpacing),
          t.address,
          env.usdg,
        ])
      : await deploy("MockPosition", [t.address, env.usdg, usdgUnits(t.price)]);
    const vault = await deploy("XStockFiLiquidityVault", [
      {
        usdg: env.usdg,
        stock: t.address,
        position: await position.getAddress(),
        oracle: out.oracle,
        swapAdapter: out.swapAdapter,
        feeRouter: out.feeRouter,
        admin: out.timelock,
        guardian: roles.guardian,
        keeper: roles.keeper,
        heldValueCap: usdgUnits(L.heldValueCapUsdg),
      },
      `xStockFi ${ticker} Liquidity Vault`,
      `xl${ticker}`,
    ]);
    await send(position.bind(vault));
    await send(registry.list(vault, 0, ticker));
    out.liquidityVaults[ticker] = { vault: await vault.getAddress(), position: await position.getAddress(), stock: t.address, name: t.name };
  }

  const cl = L.creditLine;
  for (const ticker of L.creditLines) {
    const desk = await deploy("XStockFiCreditDesk", [
      out.liquidityVaults[ticker].vault,
      out.feeRouter,
      out.timelock,
      roles.guardian,
      cl.risk,
      {
        baseRatePerYear: wad(cl.rates.baseRatePerYear),
        slope1PerYear: wad(cl.rates.slope1PerYear),
        slope2PerYear: wad(cl.rates.slope2PerYear),
        kinkUtilization: wad(cl.rates.kinkUtilization),
      },
      usdgUnits(cl.supplyCapUsdg),
      usdgUnits(cl.borrowCapUsdg),
      `xStockFi ${ticker} Credit Line`,
      `xc${ticker}`,
    ]);
    await send(registry.list(desk, 1, ticker));
    out.creditLines[ticker] = await desk.getAddress();
  }

  console.log("Income Vaults");
  for (const ticker of L.incomeVaults) {
    const t = env.stocks[ticker];
    const vault = await deploy("XStockFiIncomeVault", [
      {
        usdg: env.usdg,
        stock: t.address,
        desk: out.options,
        oracle: out.oracle,
        swapAdapter: out.swapAdapter,
        admin: out.timelock,
        guardian: roles.guardian,
        keeper: roles.keeper,
        depositCap: usdgUnits(L.incomeVault.depositCapUsdg),
        limits: L.incomeVault.limits,
      },
      `xStockFi ${ticker} Income Vault`,
      `xi${ticker}`,
    ]);
    await send(registry.list(vault, 2, ticker));
    out.incomeVaults[ticker] = { vault: await vault.getAddress(), stock: t.address, name: t.name };
  }

  if (!LIVE) await seedLocal(out, env, rest);

  console.log("Handing governance to the timelock");
  for (const c of [buyBurn, options, binaries]) {
    await send(c.grantRole(ADMIN, out.timelock));
    await send(c.renounceRole(ADMIN, deployer.address));
  }
  for (const c of [oracle, registry, ...(LIVE ? [swap] : [])]) await send(c.transferOwnership(out.timelock));
  out.pendingTimelockAcceptances = [out.oracle, out.registry, ...(LIVE ? [out.swapAdapter] : [])];

  const label = REAL_ROLES ? network.name : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log(`Next: the timelock accepts ownership of ${out.pendingTimelockAcceptances.length} contracts (./govern.sh handoff).`);
}

/** BuyBurn calls burn(uint256) on the token, so anything that cannot burn is refused here. */
async function existingToken(address) {
  if (!ethers.isAddress(address)) throw new Error("XSF_TOKEN_ADDRESS is not a valid address");
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at XSF_TOKEN_ADDRESS ${address}`);
  const token = await ethers.getContractAt("MockERC20", address);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  if (decimals !== 18n) throw new Error(`The token must have 18 decimals, got ${decimals}`);
  try {
    await token.burn.staticCall(0);
  } catch {
    throw new Error(`${symbol} at ${address} has no burn(uint256), which BuyBurn needs`);
  }
  console.log(`  ${"token".padEnd(24)} ${address} (${symbol})`);
  return token;
}

async function localToken(deployer, swap, usdg, stocks) {
  const t = await deploy("MockERC20", ["xStockFi", "XSF", 18]);
  await send(t.mint(deployer.address, wad(1_000_000_000)));
  // The mock venue sells it at 0.01 USDG, so the keeper's buy-and-burn has something to do locally.
  await send(t.mint(swap, wad(100_000_000)));
  await send(swap.setRate(usdg, t, 10n ** 32n));
  for (const [ticker, s] of Object.entries(stocks)) await send(swap.setRate(s.address, t, wad(Math.round(DEMO_PRICES[ticker] * 100))));
  return t;
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for a live deploy`);
  return v;
}

function poolKey(stock, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(stock) < BigInt(usdg) ? [stock, usdg] : [usdg, stock];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

function liveEnv() {
  const pools = require("../config/robinhood.pools.json");
  const stocks = {};
  for (const ticker of L.markets) {
    const t = config.stockTokens[ticker];
    if (!t) throw new Error(`Unknown market ${ticker} in config/robinhood.json`);
    const p = pools[ticker] && pools[ticker].pool;
    stocks[ticker] = {
      address: t.address,
      feed: t.chainlinkFeed,
      name: t.name,
      fee: p ? p.fee : config.uniswap.defaultFee,
      tickSpacing: p ? p.tickSpacing : config.uniswap.defaultTickSpacing,
    };
  }
  return {
    usdg: config.tokens.usdg.address,
    usdgFeed: config.chainlink.usdgUsdFeed,
    sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress,
    stocks,
  };
}

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 236.31, META: 778.25, MSFT: 511.2, AMZN: 231.6, GOOGL: 252.4, PLTR: 191.53, SPY: 668.1 };

async function localEnv() {
  console.log("Local demo: mock USDG, Stock Tokens, Chainlink feeds and swap venue");
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const swap = await deploy("MockSwapAdapter");
  await send(usdg.mint(swap, usdgUnits(100_000_000)));
  const stocks = {};
  for (const [ticker, price] of Object.entries(DEMO_PRICES)) {
    const name = config.stockTokens[ticker].name;
    const token = await ethers.deployContract("MockStockToken", [name, ticker]);
    const feed = await ethers.deployContract("MockAggregator", [8, Math.round(price * 1e8)]);
    await send(token.mint(swap, wad(1_000_000)));
    await send(swap.setRate(token, usdg, usdgUnits(price)));
    await send(swap.setRate(usdg, token, 10n ** 36n / usdgUnits(price)));
    stocks[ticker] = { address: await token.getAddress(), feed: await feed.getAddress(), name, price, token, feedContract: feed };
  }
  console.log(`  ${Object.keys(stocks).length} mock Stock Tokens with feeds`);
  return { usdg: await usdg.getAddress(), usdgToken: usdg, usdgFeed: await usdgFeed.getAddress(), usdgFeedContract: usdgFeed, sequencerFeed: ethers.ZeroAddress, swap, stocks };
}

/** Gives the local demo something to show: vault deposits, an Income Vault round, desk offers and open bets. */
async function seedLocal(out, env, [, , keeperSigner, demo, trader]) {
  console.log("Seeding the local demo");
  const usdg = env.usdgToken;
  const H = 3600;
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  for (const who of [demo, trader]) await send(usdg.mint(who.address, usdgUnits(500_000)));

  for (const [ticker, w] of Object.entries(out.liquidityVaults)) {
    const vault = await ethers.getContractAt("XStockFiLiquidityVault", w.vault);
    await send(usdg.connect(demo).approve(vault, usdgUnits(6_000)));
    await send(vault.connect(demo).deposit(usdgUnits(6_000), demo.address));
    await send(vault.connect(keeperSigner).rebalance(-600, 600, true, usdgUnits(3_000), "0x"));
    const position = await ethers.getContractAt("MockPosition", w.position);
    const price = env.stocks[ticker].price;
    await send(position.accrueFees(wad((30 / price).toFixed(6)), usdgUnits(30)));
    await send(vault.harvest());
  }
  for (const desk of Object.values(out.creditLines)) {
    const d = await ethers.getContractAt("XStockFiCreditDesk", desk);
    await send(usdg.connect(demo).approve(d, usdgUnits(8_000)));
    await send(d.connect(demo).deposit(usdgUnits(8_000), demo.address));
  }

  const options = await ethers.getContractAt("XStockFiOptions", out.options);
  for (const [ticker, w] of Object.entries(out.incomeVaults)) {
    const vault = await ethers.getContractAt("XStockFiIncomeVault", w.vault);
    await send(usdg.connect(demo).approve(vault, usdgUnits(15_000)));
    await send(vault.connect(demo).deposit(usdgUnits(15_000)));
    await send(vault.connect(keeperSigner).startRound(now + 7 * 24 * H));
    const price = env.stocks[ticker].price;
    const strike = Math.floor(price * 0.94);
    const size = wad((4_000 / strike).toFixed(4));
    const premium = usdgUnits(((4_000 * 0.012)).toFixed(2));
    const id = await options.count();
    await send(vault.connect(keeperSigner).sellPut(usdgUnits(strike), size, premium, 6 * H));
    if (ticker === "TSLA") {
      await send(usdg.connect(trader).approve(options, ethers.MaxUint256));
      await send(options.connect(trader).buy(id));
    }
  }

  // A few offers from an ordinary writer, so the desk has calls and puts on several stocks.
  await send(usdg.connect(demo).approve(options, ethers.MaxUint256));
  for (const [ticker, price] of [["NVDA", 224.41], ["AAPL", 236.31], ["META", 778.25], ["TSLA", 378.34]]) {
    const s = env.stocks[ticker];
    await send(s.token.mint(demo.address, wad(20)));
    await send(s.token.connect(demo).approve(options, ethers.MaxUint256));
    const expiry = now + 14 * 24 * H;
    await send(options.connect(demo).write(0, s.address, wad(2), usdgUnits(Math.ceil(price * 1.08)), usdgUnits((price * 2 * 0.018).toFixed(2)), expiry, 0, 0, 0));
    await send(options.connect(demo).write(1, s.address, wad(2), usdgUnits(Math.floor(price * 0.92)), usdgUnits((price * 2 * 0.015).toFixed(2)), expiry, 0, 0, 0));
  }

  const binaries = await ethers.getContractAt("XStockFiBinaries", out.binaries);
  await send(usdg.connect(demo).approve(binaries, ethers.MaxUint256));
  await send(usdg.connect(trader).approve(binaries, ethers.MaxUint256));
  const bets = [["TSLA", 0, 380, 250], ["NVDA", 1, 220, 100], ["AAPL", 0, 240, 150], ["META", 1, 770, 300]];
  for (const [i, [ticker, side, strike, stake]] of bets.entries()) {
    const id = await binaries.count();
    await send(binaries.connect(demo).open(env.stocks[ticker].address, side, usdgUnits(strike), usdgUnits(stake), now + 3 * 24 * H, 0));
    if (i === 0) await send(binaries.connect(trader).join(id));
  }
  out.demoUser = demo.address;
  out.demoTrader = trader.address;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

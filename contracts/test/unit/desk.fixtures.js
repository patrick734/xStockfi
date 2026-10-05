const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, rate, baseFixture } = require("./fixtures");

const CALL = 0;
const PUT = 1;
const ABOVE = 0;
const BELOW = 1;
const State = { None: 0n, Offered: 1n, Active: 2n, Exercised: 3n, Expired: 4n, Cancelled: 5n };
const Bet = { None: 0n, Open: 1n, Matched: 2n, Settled: 3n, Void: 4n, Cancelled: 5n };
const HOUR = 3600;
const DAY = 86400;

/** Pushes fresh prices for the stock and USDG feeds, as Chainlink would after time passes. */
async function refresh(ctx, price) {
  await ctx.amd.feed.setAnswer(FEED(price ?? ctx.price));
  await ctx.usdgFeed.setAnswer(FEED(1));
}

async function deskFixture() {
  const ctx = await baseFixture();
  const { admin, guardian, usdg, oracle, feeRouter, amd } = ctx;
  const desk = await ethers.deployContract("XStockFiOptions", [usdg, oracle, feeRouter, admin.address, guardian.address, USDG(10)]);
  const binaries = await ethers.deployContract("XStockFiBinaries", [usdg, oracle, feeRouter, admin.address, guardian.address, USDG(5)]);
  await desk.connect(admin).setMarket(amd.stock, true);
  await binaries.connect(admin).setMarket(amd.stock, true);
  for (const user of [ctx.alice, ctx.bob, ctx.carol]) {
    await amd.stock.mint(user, EQ(1_000));
    await usdg.connect(user).approve(desk, ethers.MaxUint256);
    await amd.stock.connect(user).approve(desk, ethers.MaxUint256);
    await usdg.connect(user).approve(binaries, ethers.MaxUint256);
  }
  return { ...ctx, desk, binaries, price: 150 };
}

const LIMITS = {
  minOtmBps: 300,
  minPremiumBps: 20,
  maxCommitBps: 8_000,
  quoteBandBps: 100,
  maxSwapLossBps: 100,
  entrySpreadBps: 100,
  maxBuyWindow: 6 * HOUR,
  minRound: 1 * DAY,
  maxRound: 14 * DAY,
};

async function vaultFixture() {
  const ctx = await deskFixture();
  const { admin, guardian, keeper, usdg, oracle, swap, desk, amd } = ctx;
  const vault = await ethers.deployContract("XStockFiIncomeVault", [
    {
      usdg: await usdg.getAddress(),
      stock: await amd.stock.getAddress(),
      desk: await desk.getAddress(),
      oracle: await oracle.getAddress(),
      swapAdapter: await swap.getAddress(),
      admin: admin.address,
      guardian: guardian.address,
      keeper: keeper.address,
      depositCap: USDG(1_000_000),
      limits: LIMITS,
    },
    "xStockFi AMD Income Vault",
    "xiAMD",
  ]);
  for (const user of [ctx.alice, ctx.bob, ctx.carol]) {
    await usdg.connect(user).approve(vault, ethers.MaxUint256);
  }
  return { ...ctx, vault, limits: LIMITS };
}

/** Writes an option from `writer` with sensible defaults, returning its id. */
async function write(ctx, writer, o = {}) {
  const now = await time.latest();
  const args = {
    kind: CALL,
    token: ctx.amd.stock.target,
    size: EQ(1),
    strike: USDG(160),
    premium: USDG(5),
    expiry: now + 7 * DAY,
    buyBy: 0,
    minPrice: 0,
    maxPrice: 0,
    ...o,
  };
  const id = await ctx.desk.count();
  await ctx.desk
    .connect(writer)
    .write(args.kind, args.token, args.size, args.strike, args.premium, args.expiry, args.buyBy, args.minPrice, args.maxPrice);
  return id;
}

module.exports = { CALL, PUT, ABOVE, BELOW, State, Bet, HOUR, DAY, LIMITS, refresh, deskFixture, vaultFixture, write, USDG, EQ, FEED, rate };

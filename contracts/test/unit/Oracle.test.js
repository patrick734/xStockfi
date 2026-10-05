const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, baseFixture } = require("./fixtures");

describe("XStockFiOracle", function () {
  it("converts Stock Token amounts to USDG across decimals", async function () {
    const ctx = await loadFixture(baseFixture);
    const token = ctx.amd.stock;
    expect(await ctx.oracle.usdgValue(token, EQ(2))).to.equal(USDG(300));
    expect(await ctx.oracle.fromUsdgValue(token, USDG(300))).to.equal(EQ(2));
  });

  it("treats a stale feed, a non-positive answer and an unknown token as unpriced", async function () {
    const ctx = await loadFixture(baseFixture);
    const token = ctx.amd.stock;
    await ctx.amd.feed.setAnswer(0);
    expect(await ctx.oracle.isFresh(token)).to.equal(false);
    await ctx.amd.feed.setAnswer(FEED(150));
    expect(await ctx.oracle.isFresh(token)).to.equal(true);
    await time.increase(3601);
    expect(await ctx.oracle.isFresh(token)).to.equal(false);
    await expect(ctx.oracle.usdgValue(token, EQ(1))).to.be.revertedWithCustomError(ctx.oracle, "Unpriced");
    expect(await ctx.oracle.isFresh(ctx.usdg)).to.equal(false);
  });

  it("goes unpriced while the sequencer is down and during its grace period", async function () {
    const ctx = await loadFixture(baseFixture);
    const token = ctx.amd.stock;
    const now = await time.latest();
    await ctx.sequencer.set(1, now, now);
    expect(await ctx.oracle.isFresh(token)).to.equal(false);
    await ctx.sequencer.set(0, now, now);
    expect(await ctx.oracle.isFresh(token)).to.equal(false);
    await time.increase(3601);
    await ctx.amd.feed.setAnswer(FEED(150));
    expect(await ctx.oracle.isFresh(token)).to.equal(true);
  });

  it("prices through USDG / USD, so a depeg raises the USDG value", async function () {
    const ctx = await loadFixture(baseFixture);
    await ctx.usdgFeed.setAnswer(FEED(0.98));
    expect(await ctx.oracle.usdgValue(ctx.amd.stock, EQ(1))).to.equal(153061224n);
  });

  it("goes unpriced while a corporate action is pending on the Stock Token", async function () {
    const ctx = await loadFixture(baseFixture);
    await ctx.amd.stock.setOraclePaused(true);
    expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
    expect(await ctx.amd.vault.maxDeposit(ctx.alice)).to.equal(0);
    await ctx.amd.stock.setOraclePaused(false);
    expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(true);
  });

  it("skips the sequencer check when no uptime feed is configured", async function () {
    const ctx = await loadFixture(baseFixture);
    const now = await time.latest();
    await ctx.sequencer.set(1, now, now);
    expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
    await ctx.oracle.connect(ctx.admin).setSequencerFeed(ethers.ZeroAddress);
    expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(true);
  });

  it("only lets the owner register feeds", async function () {
    const ctx = await loadFixture(baseFixture);
    await expect(ctx.oracle.connect(ctx.alice).setFeed(ctx.amd.stock, ctx.amd.feed, 60)).to.be.revertedWithCustomError(
      ctx.oracle,
      "OwnableUnauthorizedAccount"
    );
  });
});

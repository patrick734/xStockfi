const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, baseFixture } = require("./fixtures");

describe("VaultOracle (extra coverage)", function () {
  describe("constructor", function () {
    it("rejects a zero USDG feed and a zero USDG max age", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("XStockFiOracle");
      await expect(F.deploy(ctx.admin.address, ctx.sequencer, ethers.ZeroAddress, 90_000, 6)).to.be.revertedWithCustomError(
        F,
        "InvalidFeed"
      );
      await expect(F.deploy(ctx.admin.address, ctx.sequencer, ctx.usdgFeed, 0, 6)).to.be.revertedWithCustomError(F, "InvalidFeed");
    });

    it("stores its configuration", async function () {
      const ctx = await loadFixture(baseFixture);
      expect(await ctx.oracle.usdgDecimals()).to.equal(6);
      expect(await ctx.oracle.usdgFeed()).to.equal(ctx.usdgFeed.target);
      expect(await ctx.oracle.usdgMaxAge()).to.equal(90_000);
      expect(await ctx.oracle.sequencerFeed()).to.equal(ctx.sequencer.target);
      expect(await ctx.oracle.SEQUENCER_GRACE()).to.equal(3600);
      const f = await ctx.oracle.feeds(ctx.amd.stock);
      expect(f.aggregator).to.equal(ctx.amd.feed.target);
      expect(f.maxAge).to.equal(3600);
      expect(f.scale).to.equal(10n ** 20n); // 18 + 8 - 6
    });
  });

  describe("setFeed", function () {
    it("rejects a zero maxAge", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(ctx.oracle.connect(ctx.admin).setFeed(ctx.amd.stock, ctx.amd.feed, 0)).to.be.revertedWithCustomError(
        ctx.oracle,
        "InvalidFeed"
      );
    });

    it("rejects token + feed decimals below USDG decimals", async function () {
      const ctx = await loadFixture(baseFixture);
      const token = await ethers.deployContract("MockERC20", ["Zero", "Z", 0]);
      const feed = await ethers.deployContract("MockAggregator", [5, 150_00000n]);
      await expect(ctx.oracle.connect(ctx.admin).setFeed(token, feed, 3600)).to.be.revertedWithCustomError(ctx.oracle, "InvalidFeed");
    });

    it("prices correctly when token + feed decimals exactly equal USDG decimals (scale 1)", async function () {
      const ctx = await loadFixture(baseFixture);
      const token = await ethers.deployContract("MockERC20", ["Zero", "Z", 0]);
      const feed = await ethers.deployContract("MockAggregator", [6, 150_000000n]);
      await expect(ctx.oracle.connect(ctx.admin).setFeed(token, feed, 3600))
        .to.emit(ctx.oracle, "FeedSet")
        .withArgs(token.target, feed.target, 3600);
      expect((await ctx.oracle.feeds(token)).scale).to.equal(1);
      expect(await ctx.oracle.usdgValue(token, 2)).to.equal(USDG(300));
      expect(await ctx.oracle.fromUsdgValue(token, USDG(300))).to.equal(2);
      expect(await ctx.oracle.fromUsdgValue(token, USDG(299))).to.equal(1); // rounds down
    });

    it("prices a 6-decimal token behind an 18-decimal feed", async function () {
      const ctx = await loadFixture(baseFixture);
      const token = await ethers.deployContract("MockERC20", ["Six", "SIX", 6]);
      const feed = await ethers.deployContract("MockAggregator", [18, ethers.parseUnits("42.5", 18)]);
      await ctx.oracle.connect(ctx.admin).setFeed(token, feed, 3600);
      expect(await ctx.oracle.usdgValue(token, USDG(2))).to.equal(USDG(85));
      expect(await ctx.oracle.fromUsdgValue(token, USDG(85))).to.equal(USDG(2));
    });

    it("can replace a feed", async function () {
      const ctx = await loadFixture(baseFixture);
      const feed = await ethers.deployContract("MockAggregator", [8, FEED(300)]);
      await ctx.oracle.connect(ctx.admin).setFeed(ctx.amd.stock, feed, 60);
      expect(await ctx.oracle.usdgValue(ctx.amd.stock, EQ(1))).to.equal(USDG(300));
      await time.increase(61);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
    });
  });

  describe("feed reads", function () {
    it("treats a reverting Stock Token feed as unpriced instead of reverting", async function () {
      const ctx = await loadFixture(baseFixture);
      // MockERC20 has decimals() but no latestRoundData(): every read reverts.
      const broken = await ethers.deployContract("MockERC20", ["Broken", "B", 8]);
      await ctx.oracle.connect(ctx.admin).setFeed(ctx.amd.stock, broken, 3600);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
      await expect(ctx.oracle.fromUsdgValue(ctx.amd.stock, USDG(1)))
        .to.be.revertedWithCustomError(ctx.oracle, "Unpriced")
        .withArgs(ctx.amd.stock.target);
    });

    it("treats a reverting USDG feed as unpriced", async function () {
      const ctx = await loadFixture(baseFixture);
      const broken = await ethers.deployContract("MockERC20", ["Broken", "B", 8]);
      const oracle = await ethers.deployContract("XStockFiOracle", [ctx.admin.address, ethers.ZeroAddress, broken, 90_000, 6]);
      await oracle.connect(ctx.admin).setFeed(ctx.amd.stock, ctx.amd.feed, 3600);
      expect(await oracle.isFresh(ctx.amd.stock)).to.equal(false);
    });

    it("goes unpriced when the USDG feed is stale or non-positive", async function () {
      const ctx = await loadFixture(baseFixture);
      const now = await time.latest();
      await ctx.usdgFeed.set(FEED(1), now, now - 90_001);
      await ctx.amd.feed.setAnswer(FEED(150));
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
      await ctx.usdgFeed.setAnswer(-1);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
      await ctx.usdgFeed.setAnswer(FEED(1));
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(true);
    });

    it("rejects a negative answer, a zero updatedAt and a future updatedAt", async function () {
      const ctx = await loadFixture(baseFixture);
      const { feed, stock } = ctx.amd;
      const now = await time.latest();
      await feed.set(-FEED(150), now, now);
      expect(await ctx.oracle.isFresh(stock)).to.equal(false);
      await feed.set(FEED(150), now, 0);
      expect(await ctx.oracle.isFresh(stock)).to.equal(false);
      await feed.set(FEED(150), now, now + 1000);
      expect(await ctx.oracle.isFresh(stock)).to.equal(false);
    });

    it("accepts a price exactly maxAge old but not one second older", async function () {
      const ctx = await loadFixture(baseFixture);
      const { feed, stock } = ctx.amd;
      await feed.setAnswer(FEED(150));
      const updated = await time.latest();
      await time.increaseTo(updated + 3600);
      expect(await ctx.oracle.isFresh(stock)).to.equal(true);
      await time.increaseTo(updated + 3601);
      expect(await ctx.oracle.isFresh(stock)).to.equal(false);
    });
  });

  describe("sequencer", function () {
    it("treats a zero startedAt as down", async function () {
      const ctx = await loadFixture(baseFixture);
      const now = await time.latest();
      await ctx.sequencer.set(0, 0, now);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
    });

    it("treats a reverting sequencer feed as down", async function () {
      const ctx = await loadFixture(baseFixture);
      const broken = await ethers.deployContract("MockERC20", ["Broken", "B", 0]);
      await expect(ctx.oracle.connect(ctx.admin).setSequencerFeed(broken))
        .to.emit(ctx.oracle, "SequencerFeedSet")
        .withArgs(broken.target);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
    });

    it("requires strictly more than the grace period since the restart", async function () {
      const ctx = await loadFixture(baseFixture);
      await ctx.amd.feed.setAnswer(FEED(150));
      const next = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(next);
      await ctx.sequencer.set(0, next - 3600, next - 3600);
      expect(await time.latest()).to.equal(next);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(false);
      await time.increase(1);
      expect(await ctx.oracle.isFresh(ctx.amd.stock)).to.equal(true);
    });

    it("only the owner sets the sequencer feed", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(ctx.oracle.connect(ctx.guardian).setSequencerFeed(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.oracle,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("corporate action flag", function () {
    it("makes usdgValue and fromUsdgValue revert, and blocks Vault depositing", async function () {
      const ctx = await loadFixture(baseFixture);
      await ctx.amd.stock.setOraclePaused(true);
      await expect(ctx.oracle.usdgValue(ctx.amd.stock, EQ(1))).to.be.revertedWithCustomError(ctx.oracle, "Unpriced");
      await expect(ctx.oracle.fromUsdgValue(ctx.amd.stock, USDG(1))).to.be.revertedWithCustomError(ctx.oracle, "Unpriced");
      await ctx.usdg.connect(ctx.alice).approve(ctx.amd.vault, USDG(1));
      await expect(ctx.amd.vault.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.reverted;
    });

    it("ignores tokens that do not implement oraclePaused()", async function () {
      const ctx = await loadFixture(baseFixture);
      const token = await ethers.deployContract("MockERC20", ["Plain", "P", 18]);
      const feed = await ethers.deployContract("MockAggregator", [8, FEED(10)]);
      await ctx.oracle.connect(ctx.admin).setFeed(token, feed, 3600);
      expect(await ctx.oracle.isFresh(token)).to.equal(true);
      expect(await ctx.oracle.usdgValue(token, EQ(3))).to.equal(USDG(30));
    });
  });

  it("transfers ownership in two steps", async function () {
    const ctx = await loadFixture(baseFixture);
    await ctx.oracle.connect(ctx.admin).transferOwnership(ctx.bob.address);
    expect(await ctx.oracle.owner()).to.equal(ctx.admin.address);
    await expect(ctx.oracle.connect(ctx.carol).acceptOwnership()).to.be.revertedWithCustomError(
      ctx.oracle,
      "OwnableUnauthorizedAccount"
    );
    await ctx.oracle.connect(ctx.bob).acceptOwnership();
    expect(await ctx.oracle.owner()).to.equal(ctx.bob.address);
    await expect(ctx.oracle.connect(ctx.admin).setSequencerFeed(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      ctx.oracle,
      "OwnableUnauthorizedAccount"
    );
  });
});

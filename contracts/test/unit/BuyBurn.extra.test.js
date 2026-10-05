const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, baseFixture } = require("./fixtures");

describe("BuyBurn (extra coverage)", function () {
  async function funded() {
    const ctx = await baseFixture();
    await ctx.usdg.mint(ctx.buyBurn, USDG(10_000));
    await ctx.buyBurn.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(1_000));
    return ctx;
  }

  describe("constructor", function () {
    for (const idx of [0, 1, 2, 3, 4]) {
      it(`rejects a zero address at argument ${idx}`, async function () {
        const ctx = await loadFixture(baseFixture);
        const F = await ethers.getContractFactory("XStockFiBuyBurn");
        const args = [ctx.xsf.target, ctx.swap.target, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 3600, ethers.ZeroAddress];
        args[idx] = ethers.ZeroAddress;
        await expect(F.deploy(...args)).to.be.revertedWithCustomError(F, "InvalidConfig");
      });
    }

    it("wires immutables and roles", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = ctx.buyBurn;
      expect(await d.token()).to.equal(ctx.xsf.target);
      expect(await d.swapAdapter()).to.equal(ctx.swap.target);
      expect(await d.minInterval()).to.equal(3600);
      expect(await d.lastRun()).to.equal(0);
      expect(await d.halted()).to.equal(false);
      expect(await d.hasRole(await d.KEEPER_ROLE(), ctx.keeper.address)).to.equal(true);
      expect(await d.hasRole(await d.GUARDIAN_ROLE(), ctx.guardian.address)).to.equal(true);
    });
  });

  it("exposes no withdrawal, rescue or sweep path", async function () {
    const ctx = await loadFixture(baseFixture);
    const names = ctx.buyBurn.interface.fragments.filter((f) => f.type === "function").map((f) => f.name.toLowerCase());
    for (const n of names) {
      expect(n).to.not.match(/withdraw|rescue|sweep|recover|transfer|skim|approve|execute|call/);
    }
    // The only state-changing functions:
    const mutating = ctx.buyBurn.interface.fragments
      .filter((f) => f.type === "function" && !["view", "pure"].includes(f.stateMutability))
      .map((f) => f.name)
      .sort();
    expect(mutating).to.deep.equal(
      [
        "buyAndBurn",
        "grantRole",
        "halt",
        "renounceRole",
        "resume",
        "burnHeld",
        "revokeRole",
        "setInputLimit",
        "setMinInterval",
        "setToken",
      ].sort()
    );
  });

  describe("per-run limits", function () {
    it("rejects XSF as the input even with a limit set", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await d.connect(ctx.admin).setInputLimit(ctx.xsf, EQ(1_000));
      await ctx.xsf.connect(ctx.admin).transfer(d, EQ(10));
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.xsf, EQ(1), 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });

    it("rejects a zero amount and a token with no limit", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, 0, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
      const other = await ethers.deployContract("MockERC20", ["Other", "OTH", 18]);
      await other.mint(d, EQ(1));
      await expect(d.connect(ctx.keeper).buyAndBurn(other, 1, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });

    it("accepts exactly the per-run limit and tracks spend per token", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(1_000), EQ(100_000), "0x"))
        .to.emit(d, "Bought")
        .withArgs(ctx.usdg.target, USDG(1_000), EQ(100_000))
        .and.to.emit(d, "Burned")
        .withArgs(EQ(100_000), EQ(100_000));
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(1_000));
      expect(await ctx.usdg.allowance(d, ctx.swap)).to.equal(0);
      expect(await d.lastRun()).to.equal(await time.latest());
    });

    it("reverts when the adapter cannot meet minOut", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(100), EQ(10_000) + 1n, "0x")).to.be.reverted;
      expect(await d.totalSpent(ctx.usdg)).to.equal(0);
      expect(await d.lastRun()).to.equal(0);
    });

    it("limit changes are admin-only and can close a token", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      for (const s of [ctx.guardian, ctx.keeper, ctx.alice]) {
        await expect(d.connect(s).setInputLimit(ctx.usdg, 1)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      }
      await expect(d.connect(ctx.admin).setInputLimit(ctx.usdg, 0)).to.emit(d, "InputLimitSet").withArgs(ctx.usdg.target, 0);
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, 1, 1, "0x")).to.be.revertedWithCustomError(d, "OverLimit");
    });
  });

  describe("minimum interval", function () {
    it("allows the next run exactly at lastRun + minInterval, not a second earlier", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x");
      const last = Number(await d.lastRun());
      await time.setNextBlockTimestamp(last + 3599);
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x")).to.be.revertedWithCustomError(d, "TooSoon");
      await time.setNextBlockTimestamp(last + 3600);
      await d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x");
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(20));
    });

    it("setMinInterval is admin-only; zero allows back-to-back runs", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.guardian).setMinInterval(0)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.keeper).setMinInterval(0)).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.admin).setMinInterval(0)).to.emit(d, "MinIntervalSet").withArgs(0);
      expect(await d.minInterval()).to.equal(0);
      await d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x");
      await d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x");
      expect(await d.totalSpent(ctx.usdg)).to.equal(USDG(20));

      await d.connect(ctx.admin).setMinInterval(86_400);
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(10), 1, "0x")).to.be.revertedWithCustomError(d, "TooSoon");
    });
  });

  describe("halt", function () {
    it("only the guardian halts; only the admin resumes", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.admin).halt()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.keeper).halt()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.guardian).halt()).to.emit(d, "HaltSet").withArgs(true);
      expect(await d.halted()).to.equal(true);
      await expect(d.connect(ctx.keeper).resume()).to.be.revertedWithCustomError(d, "AccessControlUnauthorizedAccount");
      await expect(d.connect(ctx.admin).resume()).to.emit(d, "HaltSet").withArgs(false);
    });

    it("halting does not stop burnHeld", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await d.connect(ctx.guardian).halt();
      await ctx.xsf.connect(ctx.admin).transfer(d, EQ(3));
      await d.connect(ctx.alice).burnHeld();
      expect(await d.totalBurned()).to.equal(EQ(3));
    });
  });

  describe("burn accounting", function () {
    it("burns XSF already held together with the swap proceeds", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await ctx.xsf.connect(ctx.admin).transfer(d, EQ(7));
      const supply = await ctx.xsf.totalSupply();
      await expect(d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(1), EQ(100), "0x"))
        .to.emit(d, "Bought")
        .withArgs(ctx.usdg.target, USDG(1), EQ(100))
        .and.to.emit(d, "Burned")
        .withArgs(EQ(107), EQ(107));
      expect(supply - (await ctx.xsf.totalSupply())).to.equal(EQ(107));
      expect(await ctx.xsf.balanceOf(d)).to.equal(0);
    });

    it("burnHeld with nothing held is a no-op", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await expect(d.connect(ctx.bob).burnHeld()).not.to.emit(d, "Burned");
      expect(await d.totalBurned()).to.equal(0);
    });

    it("totalBurned accumulates across runs", async function () {
      const ctx = await loadFixture(funded);
      const d = ctx.buyBurn;
      await ctx.xsf.connect(ctx.admin).transfer(d, EQ(1));
      await d.burnHeld();
      await ctx.xsf.connect(ctx.admin).transfer(d, EQ(2));
      await expect(d.burnHeld()).to.emit(d, "Burned").withArgs(EQ(2), EQ(3));
      await d.connect(ctx.keeper).buyAndBurn(ctx.usdg, USDG(1), 1, "0x");
      expect(await d.totalBurned()).to.equal(EQ(103));
    });
  });
});

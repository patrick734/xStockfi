const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, FEED, baseFixture, deposit } = require("./fixtures");

const RISK = {
  ltvBps: 5000,
  liquidationThresholdBps: 6500,
  liquidationBonusBps: 500,
  closeFactorBps: 5000,
  maxCollateralShareBps: 10000,
  reserveFactorBps: 1000,
};
const RATES = {
  baseRatePerYear: ethers.parseEther("0.02"),
  slope1PerYear: ethers.parseEther("0.10"),
  slope2PerYear: ethers.parseEther("1"),
  kinkUtilization: ethers.parseEther("0.8"),
};

describe("XStockFiCreditDesk", function () {
  async function deskFixture() {
    const ctx = await baseFixture();
    const { vault } = ctx.amd;
    const desk = await ethers.deployContract("XStockFiCreditDesk", [
      vault,
      ctx.feeRouter,
      ctx.admin.address,
      ctx.guardian.address,
      RISK,
      RATES,
      USDG(1_000_000),
      USDG(1_000_000),
      "xStockFi AMD Credit Line",
      "clAMD",
    ]);

    await ctx.usdg.connect(ctx.bob).approve(desk, USDG(50_000));
    await desk.connect(ctx.bob).deposit(USDG(50_000), ctx.bob.address);

    await deposit(ctx, vault, ctx.alice, USDG(10_000));
    await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");
    const shares = await vault.balanceOf(ctx.alice);
    await vault.connect(ctx.alice).approve(desk, shares);
    await desk.connect(ctx.alice).pledge(shares);
    return { ...ctx, desk, shares };
  }

  it("lets a borrower draw USDG up to the loan-to-value limit", async function () {
    const ctx = await loadFixture(deskFixture);
    expect(await ctx.desk.borrowable(ctx.alice)).to.be.closeTo(USDG(5_000), USDG(0.01));
    await ctx.desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
    await expect(ctx.desk.connect(ctx.alice).borrow(USDG(1_100), ctx.alice.address)).to.be.revertedWithCustomError(
      ctx.desk,
      "Unhealthy"
    );
  });

  it("accrues interest to lenders and reserves", async function () {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
    const assetsBefore = await ctx.desk.totalAssets();
    await time.increase(365 * 24 * 3600);
    await ctx.desk.accrue();
    expect(await ctx.desk.debtOf(ctx.alice)).to.be.gt(USDG(4_000));
    expect(await ctx.desk.totalAssets()).to.be.gt(assetsBefore);
    expect(await ctx.desk.reserves()).to.be.gt(0);
    await ctx.desk.claimReserves();
    expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.be.gt(0);
  });

  it("blocks borrowing on a stale price but always accepts repayment", async function () {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.alice).borrow(USDG(1_000), ctx.alice.address);
    await time.increase(3601);
    await expect(ctx.desk.connect(ctx.alice).borrow(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(
      ctx.desk,
      "StalePrice"
    );
    await ctx.usdg.connect(ctx.alice).approve(ctx.desk, ethers.MaxUint256);
    await ctx.desk.connect(ctx.alice).repay(ethers.MaxUint256, ctx.alice.address);
    expect(await ctx.desk.debtOf(ctx.alice)).to.equal(0);
    await ctx.desk.connect(ctx.alice).release(ctx.shares, ctx.alice.address);
  });

  it("liquidates an unhealthy account with a bonus", async function () {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
    await ctx.amd.feed.setAnswer(FEED(30));
    expect(await ctx.desk.healthFactor(ctx.alice)).to.be.lt(ethers.parseEther("1"));

    await ctx.usdg.connect(ctx.carol).approve(ctx.desk, ethers.MaxUint256);
    await ctx.desk.connect(ctx.carol).liquidate(ctx.alice.address, USDG(2_000), ctx.carol.address);
    const seized = await ctx.amd.vault.balanceOf(ctx.carol);
    const seizedValue = await ctx.amd.vault.convertToAssets(seized);
    expect(seizedValue).to.be.closeTo(USDG(2_100), USDG(1));
    expect(await ctx.desk.debtOf(ctx.alice)).to.be.closeTo(USDG(2_000), USDG(0.01));
  });

  it("writes off bad debt within the market once collateral runs out", async function () {
    const ctx = await loadFixture(deskFixture);
    const { vault } = ctx.amd;
    await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");
    await ctx.desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
    await ctx.amd.feed.setAnswer(FEED(15));
    await ctx.amd.position.setSpot(USDG(15));

    const lenderAssetsBefore = await ctx.desk.totalAssets();
    await ctx.usdg.connect(ctx.carol).approve(ctx.desk, ethers.MaxUint256);
    await ctx.desk.connect(ctx.carol).liquidate(ctx.alice.address, USDG(2_000), ctx.carol.address);

    expect((await ctx.desk.accounts(ctx.alice)).collateralShares).to.equal(0);
    expect(await ctx.desk.debtOf(ctx.alice)).to.equal(0);
    expect(await ctx.desk.badDebt()).to.be.gt(USDG(3_000));
    expect(await ctx.desk.totalAssets()).to.be.lt(lenderAssetsBefore);
  });

  it("pauses new borrowing without trapping lenders", async function () {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.guardian).pause();
    await expect(ctx.desk.connect(ctx.alice).borrow(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(
      ctx.desk,
      "EnforcedPause"
    );
    await ctx.desk.connect(ctx.bob).withdraw(USDG(10_000), ctx.bob.address, ctx.bob.address);
  });

  it("caps lender withdrawals at unborrowed cash", async function () {
    const ctx = await loadFixture(deskFixture);
    await ctx.desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
    expect(await ctx.desk.maxWithdraw(ctx.bob)).to.equal(USDG(46_000));
  });
});

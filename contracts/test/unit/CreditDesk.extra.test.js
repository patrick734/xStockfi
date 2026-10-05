const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, FEED, WAD, baseFixture, deposit } = require("./fixtures");

const YEAR = 365n * 24n * 3600n;
const BPS = 10_000n;
const ZERO_ROLE = ethers.ZeroHash;

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
const ZERO_RATES = { baseRatePerYear: 0n, slope1PerYear: 0n, slope2PerYear: 0n, kinkUtilization: ethers.parseEther("0.8") };

// ------------------------------------------------------------------ local helpers

function deskArgs(ctx, o = {}) {
  return [
    o.vault ?? ctx.amd.vault,
    o.feeRouter ?? ctx.feeRouter,
    o.admin ?? ctx.admin.address,
    o.guardian ?? ctx.guardian.address,
    o.risk ?? RISK,
    o.rates ?? RATES,
    o.supplyCap ?? USDG(1_000_000),
    o.borrowCap ?? USDG(1_000_000),
    "xStockFi AMD Credit Line",
    "clAMD",
  ];
}

async function deployDesk(ctx, o) {
  return ethers.deployContract("XStockFiCreditDesk", deskArgs(ctx, o));
}

async function lend(ctx, desk, user, amount) {
  await ctx.usdg.connect(user).approve(desk, amount);
  await desk.connect(user).deposit(amount, user.address);
}

/** Alice deposits 10k USDG into the AMD Vault; the keeper moves half (or all) of it into AMD. */
async function makeCollateral(ctx, allStock = false) {
  const { vault } = ctx.amd;
  await deposit(ctx, vault, ctx.alice, USDG(10_000));
  await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");
  if (allStock) await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");
  return vault.balanceOf(ctx.alice);
}

async function pledge(ctx, desk, user, shares) {
  await ctx.amd.vault.connect(user).approve(desk, shares);
  await desk.connect(user).pledge(shares);
}

/** Refreshes both Chainlink feeds (e.g. after a long time jump). */
async function refreshPrice(ctx, price) {
  await ctx.usdgFeed.setAnswer(FEED(1));
  await ctx.amd.feed.setAnswer(FEED(price));
}

function findEvent(desk, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = desk.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed;
    } catch (_) {}
  }
  return null;
}

// ------------------------------------------------------------------ fixtures

async function emptyDeskFixture() {
  const ctx = await baseFixture();
  const desk = await deployDesk(ctx);
  return { ...ctx, desk };
}

async function deskFixture() {
  const ctx = await baseFixture();
  const desk = await deployDesk(ctx);
  await lend(ctx, desk, ctx.bob, USDG(50_000));
  const shares = await makeCollateral(ctx);
  await pledge(ctx, desk, ctx.alice, shares);
  return { ...ctx, desk, shares };
}

/** Zero interest, 100% close factor, all-stock collateral, alice pledges 90% of her shares. */
async function exactFixture() {
  const ctx = await baseFixture();
  const desk = await deployDesk(ctx, { rates: ZERO_RATES, risk: { ...RISK, closeFactorBps: 10000 } });
  await lend(ctx, desk, ctx.bob, USDG(50_000));
  const shares = await makeCollateral(ctx, true);
  const pledged = (shares * 9n) / 10n;
  await pledge(ctx, desk, ctx.alice, pledged);
  return { ...ctx, desk, shares, pledged };
}

/** Bob lends only 3k; alice borrows all of it against all-stock collateral (100% utilization). */
async function insolventFixture() {
  const ctx = await baseFixture();
  const desk = await deployDesk(ctx);
  await lend(ctx, desk, ctx.bob, USDG(3_000));
  const shares = await makeCollateral(ctx, true);
  await pledge(ctx, desk, ctx.alice, shares);
  await desk.connect(ctx.alice).borrow(USDG(3_000), ctx.alice.address);
  return { ...ctx, desk, shares };
}

// ------------------------------------------------------------------ tests

describe("BorrowDesk (extra)", function () {
  describe("constructor", function () {
    it("stores configuration, roles and ERC-4626 metadata", async function () {
      const { desk, usdg, amd, feeRouter, admin, guardian } = await loadFixture(emptyDeskFixture);
      expect(await desk.asset()).to.equal(await usdg.getAddress());
      expect(await desk.vault()).to.equal(await amd.vault.getAddress());
      expect(await desk.feeRouter()).to.equal(await feeRouter.getAddress());
      expect(await desk.decimals()).to.equal(12n);
      expect(await desk.hasRole(ZERO_ROLE, admin.address)).to.equal(true);
      expect(await desk.hasRole(await desk.GUARDIAN_ROLE(), guardian.address)).to.equal(true);
      expect(await desk.hasRole(await desk.GUARDIAN_ROLE(), admin.address)).to.equal(false);
      expect(await desk.borrowIndex()).to.equal(WAD);
      expect(await desk.supplyCap()).to.equal(USDG(1_000_000));
      expect(await desk.borrowCap()).to.equal(USDG(1_000_000));
      const r = await desk.risk();
      expect(r.ltvBps).to.equal(5000n);
      expect(r.reserveFactorBps).to.equal(1000n);
      const m = await desk.rates();
      expect(m.kinkUtilization).to.equal(RATES.kinkUtilization);
    });

    it("rejects zero addresses and admin == guardian", async function () {
      const ctx = await loadFixture(emptyDeskFixture);
      const F = await ethers.getContractFactory("XStockFiCreditDesk");
      for (const o of [
        { feeRouter: ethers.ZeroAddress },
        { admin: ethers.ZeroAddress },
        { guardian: ethers.ZeroAddress },
        { guardian: ctx.admin.address },
      ]) {
        await expect(F.deploy(...deskArgs(ctx, o))).to.be.revertedWithCustomError(F, "InvalidConfig");
      }
    });

    it("rejects every out-of-bounds risk parameter", async function () {
      const ctx = await loadFixture(emptyDeskFixture);
      const F = await ethers.getContractFactory("XStockFiCreditDesk");
      const bad = [
        { ltvBps: 0 },
        { ltvBps: 6500 }, // ltv == threshold
        { ltvBps: 7000 }, // ltv > threshold
        { liquidationThresholdBps: 9001 },
        { liquidationThresholdBps: 9000, liquidationBonusBps: 1200 }, // threshold * (1 + bonus) >= 100%
        { closeFactorBps: 0 },
        { closeFactorBps: 10001 },
        { maxCollateralShareBps: 10001 },
        { reserveFactorBps: 5001 },
      ];
      for (const b of bad) {
        await expect(F.deploy(...deskArgs(ctx, { risk: { ...RISK, ...b } }))).to.be.revertedWithCustomError(
          F,
          "InvalidConfig"
        );
      }
    });

    it("rejects a kink of 0 or >= 100%", async function () {
      const ctx = await loadFixture(emptyDeskFixture);
      const F = await ethers.getContractFactory("XStockFiCreditDesk");
      for (const k of [0n, WAD, WAD + 1n]) {
        await expect(
          F.deploy(...deskArgs(ctx, { rates: { ...RATES, kinkUtilization: k } }))
        ).to.be.revertedWithCustomError(F, "InvalidConfig");
      }
    });

    it("accepts parameters exactly at the hard limits", async function () {
      const ctx = await loadFixture(emptyDeskFixture);
      const edge = {
        ltvBps: 8999,
        liquidationThresholdBps: 9000,
        liquidationBonusBps: 1100, // 9000 * 11100 = 99.9M < 100M
        closeFactorBps: 10000,
        maxCollateralShareBps: 10000,
        reserveFactorBps: 5000,
      };
      await deployDesk(ctx, { risk: edge, rates: { ...RATES, kinkUtilization: WAD - 1n } });
    });
  });

  describe("governance and access control", function () {
    it("only the guardian can pause and only the admin can unpause", async function () {
      const { desk, admin, guardian, alice } = await loadFixture(emptyDeskFixture);
      const GUARDIAN = await desk.GUARDIAN_ROLE();
      await expect(desk.connect(admin).pause())
        .to.be.revertedWithCustomError(desk, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, GUARDIAN);
      await expect(desk.connect(alice).pause()).to.be.revertedWithCustomError(desk, "AccessControlUnauthorizedAccount");
      await expect(desk.connect(guardian).pause()).to.emit(desk, "Paused");
      await expect(desk.connect(guardian).pause()).to.be.revertedWithCustomError(desk, "EnforcedPause");
      await expect(desk.connect(guardian).unpause())
        .to.be.revertedWithCustomError(desk, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, ZERO_ROLE);
      await expect(desk.connect(admin).unpause()).to.emit(desk, "Unpaused");
      await expect(desk.connect(admin).unpause()).to.be.revertedWithCustomError(desk, "ExpectedPause");
    });

    it("only the admin can set risk params, and they are validated", async function () {
      const { desk, admin, guardian, alice } = await loadFixture(emptyDeskFixture);
      const next = { ...RISK, ltvBps: 4000, liquidationThresholdBps: 5500, liquidationBonusBps: 600 };
      for (const s of [guardian, alice]) {
        await expect(desk.connect(s).setRiskParams(next))
          .to.be.revertedWithCustomError(desk, "AccessControlUnauthorizedAccount")
          .withArgs(s.address, ZERO_ROLE);
      }
      await expect(desk.connect(admin).setRiskParams({ ...next, ltvBps: 0 })).to.be.revertedWithCustomError(
        desk,
        "InvalidConfig"
      );
      await expect(desk.connect(admin).setRiskParams(next)).to.emit(desk, "RiskParamsSet");
      const r = await desk.risk();
      expect(r.ltvBps).to.equal(4000n);
      expect(r.liquidationThresholdBps).to.equal(5500n);
      expect(r.liquidationBonusBps).to.equal(600n);
    });

    it("only the admin can set the rate model, and it is validated", async function () {
      const { desk, admin, guardian } = await loadFixture(emptyDeskFixture);
      const next = { ...RATES, baseRatePerYear: ethers.parseEther("0.05") };
      await expect(desk.connect(guardian).setRateModel(next)).to.be.revertedWithCustomError(
        desk,
        "AccessControlUnauthorizedAccount"
      );
      await expect(desk.connect(admin).setRateModel({ ...next, kinkUtilization: 0 })).to.be.revertedWithCustomError(
        desk,
        "InvalidConfig"
      );
      await expect(desk.connect(admin).setRateModel(next)).to.emit(desk, "RateModelSet");
      expect((await desk.rates()).baseRatePerYear).to.equal(ethers.parseEther("0.05"));
      expect(await desk.borrowRatePerYear()).to.equal(ethers.parseEther("0.05"));
    });

    it("accrues interest at the old rate before a parameter change", async function () {
      const { desk, admin, alice } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await time.increase(YEAR);
      await desk.connect(admin).setRateModel({ ...RATES, baseRatePerYear: ethers.parseEther("0.5") });
      expect(await desk.lastAccrual()).to.equal(await time.latest());
      // 3% (old model at 8% utilization) for one year
      expect(await desk.totalDebt()).to.be.closeTo(USDG(4_120), USDG(0.01));
      await time.increase(YEAR);
      await desk.connect(admin).setRiskParams(RISK);
      expect(await desk.lastAccrual()).to.equal(await time.latest());
      expect(await desk.totalDebt()).to.be.gt(USDG(4_120) + USDG(1_000)); // now > 50%/yr
    });

    it("only the admin can set caps (up or down)", async function () {
      const { desk, admin, guardian } = await loadFixture(emptyDeskFixture);
      await expect(desk.connect(guardian).setCaps(USDG(2_000_000), USDG(2_000_000))).to.be.revertedWithCustomError(
        desk,
        "AccessControlUnauthorizedAccount"
      );
      await expect(desk.connect(admin).setCaps(USDG(2_000_000), USDG(3)))
        .to.emit(desk, "CapsSet")
        .withArgs(USDG(2_000_000), USDG(3));
      expect(await desk.supplyCap()).to.equal(USDG(2_000_000));
      expect(await desk.borrowCap()).to.equal(USDG(3));
    });

    it("only the guardian can lower caps, and never raise them", async function () {
      const { desk, admin, guardian } = await loadFixture(emptyDeskFixture);
      await expect(desk.connect(admin).lowerCaps(USDG(1), USDG(1)))
        .to.be.revertedWithCustomError(desk, "AccessControlUnauthorizedAccount")
        .withArgs(admin.address, await desk.GUARDIAN_ROLE());
      await expect(desk.connect(guardian).lowerCaps(USDG(1_000_001), USDG(1))).to.be.revertedWithCustomError(
        desk,
        "InvalidConfig"
      );
      await expect(desk.connect(guardian).lowerCaps(USDG(1), USDG(1_000_001))).to.be.revertedWithCustomError(
        desk,
        "InvalidConfig"
      );
      // equal is allowed
      await expect(desk.connect(guardian).lowerCaps(USDG(1_000_000), USDG(1_000_000))).to.emit(desk, "CapsSet");
      await expect(desk.connect(guardian).lowerCaps(USDG(500), USDG(100)))
        .to.emit(desk, "CapsSet")
        .withArgs(USDG(500), USDG(100));
      expect(await desk.supplyCap()).to.equal(USDG(500));
      expect(await desk.borrowCap()).to.equal(USDG(100));
    });
  });

  describe("interest rate model", function () {
    it("reports zero utilization and the base rate on an empty market", async function () {
      const { desk } = await loadFixture(emptyDeskFixture);
      expect(await desk.utilization()).to.equal(0n);
      expect(await desk.borrowRatePerYear()).to.equal(RATES.baseRatePerYear);
      expect(await desk.supplyRatePerYear()).to.equal(0n);
      expect(await desk.totalAssets()).to.equal(0n);
      await desk.accrue(); // no debt: nothing to accrue
      expect(await desk.borrowIndex()).to.equal(WAD);
      expect(await desk.lastAccrual()).to.equal(await time.latest());
    });

    it("follows slope1 below the kink", async function () {
      const { desk, alice } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      const tol = ethers.parseEther("0.000001");
      expect(await desk.utilization()).to.be.closeTo(ethers.parseEther("0.08"), tol);
      // 2% + 0.08 * 10% / 0.8 = 3%
      expect(await desk.borrowRatePerYear()).to.be.closeTo(ethers.parseEther("0.03"), tol);
      // 3% * 8% * 90%
      expect(await desk.supplyRatePerYear()).to.be.closeTo(ethers.parseEther("0.00216"), tol);
    });

    it("follows slope2 above the kink", async function () {
      const { desk, alice, bob } = await loadFixture(deskFixture);
      await desk.connect(bob).withdraw(USDG(45_000), bob.address, bob.address);
      await desk.connect(alice).borrow(USDG(4_500), alice.address);
      const tol = ethers.parseEther("0.000001");
      expect(await desk.utilization()).to.be.closeTo(ethers.parseEther("0.9"), tol);
      // 2% + 10% + (0.9 - 0.8) * 100% / 0.2 = 62%
      expect(await desk.borrowRatePerYear()).to.be.closeTo(ethers.parseEther("0.62"), tol);
    });

    it("accrues a year of interest into debt, the borrow index, lender assets and reserves", async function () {
      const { desk, alice } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await time.increase(YEAR);
      await desk.accrue();
      const tol = USDG(0.01);
      expect(await desk.totalDebt()).to.be.closeTo(USDG(4_120), tol);
      expect(await desk.debtOf(alice)).to.be.closeTo(USDG(4_120), tol);
      expect(await desk.reserves()).to.be.closeTo(USDG(12), tol);
      expect(await desk.totalAssets()).to.be.closeTo(USDG(50_108), tol);
      expect(await desk.borrowIndex()).to.be.closeTo(ethers.parseEther("1.03"), ethers.parseEther("0.000001"));
    });

    it("views project interest without a state change", async function () {
      const { desk, alice } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      const stored = await desk.totalDebt();
      await time.increase(YEAR);
      expect(await desk.totalDebt()).to.equal(stored);
      expect(await desk.debtOf(alice)).to.be.closeTo(USDG(4_120), USDG(0.01));
      expect(await desk.totalAssets()).to.be.closeTo(USDG(50_108), USDG(0.01));
    });
  });

  describe("lenders (ERC-4626)", function () {
    it("caps deposits at the supply cap", async function () {
      const ctx = await loadFixture(emptyDeskFixture);
      const { desk, admin, carol, usdg } = ctx;
      await desk.connect(admin).setCaps(USDG(1_000), USDG(1_000));
      expect(await desk.maxDeposit(carol)).to.equal(USDG(1_000));
      expect(await desk.maxMint(carol)).to.equal(USDG(1_000) * 10n ** 6n);
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      await expect(desk.connect(carol).deposit(USDG(1_001), carol.address)).to.be.revertedWithCustomError(
        desk,
        "ERC4626ExceededMaxDeposit"
      );
      await desk.connect(carol).deposit(USDG(1_000), carol.address);
      expect(await desk.maxDeposit(carol)).to.equal(0n);
      expect(await desk.maxMint(carol)).to.equal(0n);
      await expect(desk.connect(carol).deposit(1n, carol.address)).to.be.revertedWithCustomError(
        desk,
        "ERC4626ExceededMaxDeposit"
      );
    });

    it("reports no deposit room once supply exceeds a lowered cap", async function () {
      const { desk, guardian, carol } = await loadFixture(deskFixture);
      await desk.connect(guardian).lowerCaps(USDG(10_000), USDG(10_000));
      expect(await desk.maxDeposit(carol)).to.equal(0n);
    });

    it("mints lender shares and honours the cap for mint", async function () {
      const { desk, carol, usdg } = await loadFixture(emptyDeskFixture);
      const shares = USDG(100) * 10n ** 6n;
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      const before = await usdg.balanceOf(carol);
      await desk.connect(carol).mint(shares, carol.address);
      expect(await desk.balanceOf(carol)).to.equal(shares);
      expect(before - (await usdg.balanceOf(carol))).to.equal(USDG(100));
      const max = await desk.maxMint(carol);
      await expect(desk.connect(carol).mint(max + 1n, carol.address)).to.be.revertedWithCustomError(
        desk,
        "ERC4626ExceededMaxMint"
      );
    });

    it("blocks deposit and mint while paused but keeps withdraw and redeem open", async function () {
      const { desk, guardian, bob, usdg } = await loadFixture(deskFixture);
      await desk.connect(guardian).pause();
      expect(await desk.maxDeposit(bob)).to.equal(0n);
      expect(await desk.maxMint(bob)).to.equal(0n);
      await usdg.connect(bob).approve(desk, ethers.MaxUint256);
      await expect(desk.connect(bob).deposit(USDG(1), bob.address)).to.be.revertedWithCustomError(desk, "EnforcedPause");
      await expect(desk.connect(bob).mint(10n ** 12n, bob.address)).to.be.revertedWithCustomError(
        desk,
        "EnforcedPause"
      );
      await desk.connect(bob).withdraw(USDG(1_000), bob.address, bob.address);
      await desk.connect(bob).redeem(await desk.balanceOf(bob), bob.address, bob.address);
      expect(await desk.balanceOf(bob)).to.equal(0n);
    });

    it("limits withdraw and redeem to free cash while loans are out", async function () {
      const { desk, alice, bob } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      expect(await desk.maxWithdraw(bob)).to.equal(USDG(46_000));
      const maxRedeem = await desk.maxRedeem(bob);
      expect(maxRedeem).to.be.lt(await desk.balanceOf(bob));
      expect(await desk.convertToAssets(maxRedeem)).to.be.closeTo(USDG(46_000), USDG(0.01));
      await expect(desk.connect(bob).withdraw(USDG(46_001), bob.address, bob.address)).to.be.revertedWithCustomError(
        desk,
        "ERC4626ExceededMaxWithdraw"
      );
      await expect(desk.connect(bob).redeem(maxRedeem + 10n ** 9n, bob.address, bob.address)).to.be.revertedWithCustomError(
        desk,
        "ERC4626ExceededMaxRedeem"
      );
      await desk.connect(bob).redeem(maxRedeem - maxRedeem / 1_000_000n, bob.address, bob.address);
      expect(await desk.maxWithdraw(bob)).to.be.lte(USDG(0.1));
    });

    it("limits a small lender by their own balance, not free cash", async function () {
      const ctx = await loadFixture(deskFixture);
      await lend(ctx, ctx.desk, ctx.carol, USDG(100));
      expect(await ctx.desk.maxWithdraw(ctx.carol)).to.be.closeTo(USDG(100), 1n);
      expect(await ctx.desk.maxRedeem(ctx.carol)).to.equal(await ctx.desk.balanceOf(ctx.carol));
    });

    it("lets lenders exit with interest once the loan is repaid, leaving reserves behind", async function () {
      const { desk, alice, bob, usdg } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await time.increase(YEAR);
      await usdg.connect(alice).approve(desk, ethers.MaxUint256);
      await desk.connect(alice).repay(ethers.MaxUint256, alice.address);
      expect(await desk.totalDebt()).to.equal(0n);

      const before = await usdg.balanceOf(bob);
      await desk.connect(bob).redeem(await desk.maxRedeem(bob), bob.address, bob.address);
      const received = (await usdg.balanceOf(bob)) - before;
      expect(received).to.be.closeTo(USDG(50_108), USDG(0.02));
      // what remains is (almost only) the reserves
      expect(await desk.cash()).to.be.closeTo(await desk.reserves(), USDG(0.02));
      expect(await desk.maxWithdraw(bob)).to.be.lte(USDG(0.02));
    });
  });

  describe("pledging", function () {
    it("rejects zero, paused, and over-concentration pledges", async function () {
      const ctx = await baseFixture();
      const desk = await deployDesk(ctx, { risk: { ...RISK, maxCollateralShareBps: 3000 } });
      const shares = await makeCollateral(ctx);
      const supply = await ctx.amd.vault.totalSupply();
      await ctx.amd.vault.connect(ctx.alice).approve(desk, shares);

      await expect(desk.connect(ctx.alice).pledge(0)).to.be.revertedWithCustomError(desk, "ZeroAmount");
      const limit = (supply * 3000n) / BPS;
      await expect(desk.connect(ctx.alice).pledge(limit + 1n)).to.be.revertedWithCustomError(desk, "CapExceeded");

      await desk.connect(ctx.guardian).pause();
      await expect(desk.connect(ctx.alice).pledge(1n)).to.be.revertedWithCustomError(desk, "EnforcedPause");
      await desk.connect(ctx.admin).unpause();

      await expect(desk.connect(ctx.alice).pledge(limit)).to.emit(desk, "Pledged").withArgs(ctx.alice.address, limit);
      expect(await desk.totalCollateralShares()).to.equal(limit);
      expect((await desk.accounts(ctx.alice)).collateralShares).to.equal(limit);
      await expect(desk.connect(ctx.alice).pledge(1n)).to.be.revertedWithCustomError(desk, "CapExceeded");
    });

    it("values collateral with the Vault price and reports max health with no debt", async function () {
      const { desk, alice, carol, amd, shares } = await loadFixture(deskFixture);
      expect(await desk.collateralValue(alice)).to.equal(await amd.vault.convertToAssets(shares));
      expect(await desk.collateralValue(alice)).to.be.closeTo(USDG(10_000), USDG(0.01));
      expect(await desk.collateralValue(carol)).to.equal(0n);
      expect(await desk.healthFactor(alice)).to.equal(ethers.MaxUint256);
    });
  });

  describe("borrowing", function () {
    it("rejects zero, paused, over-cash, over-cap and uncollateralised borrows", async function () {
      const { desk, alice, bob, carol, admin, guardian } = await loadFixture(deskFixture);
      await expect(desk.connect(alice).borrow(0, alice.address)).to.be.revertedWithCustomError(desk, "ZeroAmount");
      await expect(desk.connect(carol).borrow(USDG(1), carol.address)).to.be.revertedWithCustomError(desk, "Unhealthy");

      await desk.connect(admin).setCaps(USDG(1_000_000), USDG(1_000));
      await expect(desk.connect(alice).borrow(USDG(1_001), alice.address)).to.be.revertedWithCustomError(
        desk,
        "CapExceeded"
      );
      await desk.connect(alice).borrow(USDG(1_000), alice.address);
      await expect(desk.connect(alice).borrow(USDG(1), alice.address)).to.be.revertedWithCustomError(
        desk,
        "CapExceeded"
      );
      await desk.connect(admin).setCaps(USDG(1_000_000), USDG(1_000_000));

      await desk.connect(bob).withdraw(await desk.maxWithdraw(bob) - USDG(500), bob.address, bob.address);
      expect(await desk.borrowable(alice)).to.be.closeTo(USDG(500), USDG(0.01));
      await expect(desk.connect(alice).borrow(USDG(501), alice.address)).to.be.revertedWithCustomError(
        desk,
        "InsufficientCash"
      );

      await desk.connect(guardian).pause();
      await expect(desk.connect(alice).borrow(USDG(1), alice.address)).to.be.revertedWithCustomError(
        desk,
        "EnforcedPause"
      );
    });

    it("sends borrowed USDG to the receiver and records the debt", async function () {
      const { desk, alice, carol, usdg } = await loadFixture(deskFixture);
      const before = await usdg.balanceOf(carol);
      await expect(desk.connect(alice).borrow(USDG(1_234), carol.address))
        .to.emit(desk, "Borrowed")
        .withArgs(alice.address, carol.address, USDG(1_234));
      expect((await usdg.balanceOf(carol)) - before).to.equal(USDG(1_234));
      expect(await desk.debtOf(alice)).to.equal(USDG(1_234));
      expect(await desk.totalDebt()).to.equal(USDG(1_234));
      expect(await desk.debtOf(carol)).to.equal(0n);
    });

    it("allows borrowing exactly up to the LTV and computes the health factor", async function () {
      const { desk, alice } = await loadFixture(deskFixture);
      const limit = ((await desk.collateralValue(alice)) * 5000n) / BPS;
      await desk.connect(alice).borrow(limit, alice.address);
      expect(await desk.borrowable(alice)).to.equal(0n);
      // HF = value * 65% / (value * 50%) = 1.3
      expect(await desk.healthFactor(alice)).to.be.closeTo(ethers.parseEther("1.3"), ethers.parseEther("0.0001"));
    });

    it("reports zero borrowable once debt exceeds the LTV limit after a price drop", async function () {
      const { desk, alice, amd } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(30));
      expect(await desk.borrowable(alice)).to.equal(0n);
      await expect(desk.connect(alice).borrow(USDG(1), alice.address)).to.be.revertedWithCustomError(desk, "Unhealthy");
    });

    it("on a stale price: borrowable is 0, collateral value and health revert, borrow reverts", async function () {
      const { desk, alice, carol, oracle } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(1_000), alice.address);
      await time.increase(3601);
      expect(await desk.borrowable(alice)).to.equal(0n);
      await expect(desk.collateralValue(alice)).to.be.revertedWithCustomError(oracle, "Unpriced");
      await expect(desk.healthFactor(alice)).to.be.revertedWithCustomError(oracle, "Unpriced");
      expect(await desk.collateralValue(carol)).to.equal(0n); // nothing pledged: no price needed
      await expect(desk.connect(alice).borrow(USDG(1), alice.address)).to.be.revertedWithCustomError(desk, "StalePrice");
    });

    it("treats a corporate-action flag on the Stock Token as a stale price", async function () {
      const { desk, alice, amd } = await loadFixture(deskFixture);
      await amd.stock.setOraclePaused(true);
      expect(await desk.borrowable(alice)).to.equal(0n);
      await expect(desk.connect(alice).borrow(USDG(1), alice.address)).to.be.revertedWithCustomError(desk, "StalePrice");
    });
  });

  describe("releasing collateral", function () {
    it("rejects zero and more-than-pledged releases", async function () {
      const { desk, alice, carol, shares } = await loadFixture(deskFixture);
      await expect(desk.connect(alice).release(0, alice.address)).to.be.revertedWithCustomError(desk, "ZeroAmount");
      await expect(desk.connect(alice).release(shares + 1n, alice.address)).to.be.revertedWithCustomError(
        desk,
        "ZeroAmount"
      );
      await expect(desk.connect(carol).release(1n, carol.address)).to.be.revertedWithCustomError(desk, "ZeroAmount");
    });

    it("lets a debt-free account release everything even when paused and stale", async function () {
      const { desk, alice, carol, guardian, amd, shares } = await loadFixture(deskFixture);
      await desk.connect(guardian).pause();
      await time.increase(3601);
      await expect(desk.connect(alice).release(shares, carol.address))
        .to.emit(desk, "Released")
        .withArgs(alice.address, carol.address, shares);
      expect(await amd.vault.balanceOf(carol)).to.equal(shares);
      expect(await desk.totalCollateralShares()).to.equal(0n);
    });

    it("lets an indebted account release only while staying within the LTV", async function () {
      const { desk, alice, amd, shares } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(1_000), alice.address);
      // keep 40% of the collateral: value 4000, limit 2000 >= 1000
      const half = (shares * 6n) / 10n;
      await desk.connect(alice).release(half, alice.address);
      expect(await amd.vault.balanceOf(alice)).to.equal(half);
      // keep ~15%: limit ~750 < 1000
      const more = ((shares - half) * 3n) / 4n;
      await expect(desk.connect(alice).release(more, alice.address)).to.be.revertedWithCustomError(desk, "Unhealthy");
    });

    it("blocks releasing against debt on a stale price", async function () {
      const { desk, alice } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(1_000), alice.address);
      await time.increase(3601);
      await expect(desk.connect(alice).release(1n, alice.address)).to.be.revertedWithCustomError(desk, "StalePrice");
    });

    it("allows releasing against debt while paused if within LTV", async function () {
      const { desk, alice, guardian, shares } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(1_000), alice.address);
      await desk.connect(guardian).pause();
      await desk.connect(alice).release(shares / 2n, alice.address);
    });
  });

  describe("repaying", function () {
    it("rejects a repay when nothing is owed", async function () {
      const { desk, alice, carol } = await loadFixture(deskFixture);
      await expect(desk.connect(carol).repay(USDG(1), alice.address)).to.be.revertedWithCustomError(desk, "ZeroAmount");
      await desk.connect(alice).borrow(USDG(1), alice.address);
      await expect(desk.connect(carol).repay(0, alice.address)).to.be.revertedWithCustomError(desk, "ZeroAmount");
    });

    it("lets a third party repay part of someone else's debt", async function () {
      const { desk, alice, carol, usdg } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      const before = await usdg.balanceOf(carol);
      await expect(desk.connect(carol).repay(USDG(1_000), alice.address))
        .to.emit(desk, "Repaid")
        .withArgs(carol.address, alice.address, USDG(1_000));
      expect(before - (await usdg.balanceOf(carol))).to.equal(USDG(1_000));
      expect(await desk.debtOf(alice)).to.be.closeTo(USDG(3_000), USDG(0.01));
      expect(await desk.totalDebt()).to.be.closeTo(USDG(3_000), USDG(0.01));
    });

    it("repays in full with interest via max, even while paused and stale", async function () {
      const { desk, alice, guardian, usdg } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await time.increase(YEAR);
      await desk.connect(guardian).pause();
      await usdg.connect(alice).approve(desk, ethers.MaxUint256);
      const before = await usdg.balanceOf(alice);
      await desk.connect(alice).repay(ethers.MaxUint256, alice.address);
      expect(before - (await usdg.balanceOf(alice))).to.be.closeTo(USDG(4_120), USDG(0.01));
      expect(await desk.debtOf(alice)).to.equal(0n);
      expect((await desk.accounts(alice)).debtScaled).to.equal(0n);
      expect(await desk.totalDebt()).to.equal(0n);
      expect(await desk.healthFactor(alice)).to.equal(ethers.MaxUint256);
    });
  });

  describe("liquidation", function () {
    it("cannot liquidate a healthy account or one with no debt", async function () {
      const { desk, alice, carol } = await loadFixture(deskFixture);
      await expect(desk.connect(carol).liquidate(alice.address, USDG(1), carol.address)).to.be.revertedWithCustomError(
        desk,
        "Healthy"
      );
      await desk.connect(alice).borrow(USDG(5_000), alice.address); // HF 1.3
      await expect(desk.connect(carol).liquidate(alice.address, USDG(1), carol.address)).to.be.revertedWithCustomError(
        desk,
        "Healthy"
      );
    });

    it("cannot liquidate on a stale price even when the account looks unhealthy", async function () {
      const { desk, alice, carol, amd } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(30));
      await time.increase(3601);
      await expect(desk.connect(carol).liquidate(alice.address, USDG(1), carol.address)).to.be.revertedWithCustomError(
        desk,
        "StalePrice"
      );
    });

    it("rejects a zero repay amount", async function () {
      const { desk, alice, carol, amd } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(30));
      await expect(desk.connect(carol).liquidate(alice.address, 0, carol.address)).to.be.revertedWithCustomError(
        desk,
        "ZeroAmount"
      );
    });

    it("caps repayment at the close factor and seizes repayment plus bonus in shares", async function () {
      const { desk, alice, carol, usdg, amd, shares } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(30));
      // value = 5000 USDG + 33.33 AMD * 30 = 6000; HF = 6000 * 0.65 / 4000
      expect(await desk.healthFactor(alice)).to.be.closeTo(ethers.parseEther("0.975"), ethers.parseEther("0.0001"));

      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      const usdgBefore = await usdg.balanceOf(carol);
      const tx = await desk.connect(carol).liquidate(alice.address, ethers.MaxUint256, carol.address);
      const ev = findEvent(desk, await tx.wait(), "Liquidated");
      const { repaid, sharesSeized, badDebt } = ev.args;

      expect(repaid).to.be.closeTo(USDG(2_000), USDG(0.01)); // 50% close factor
      expect(usdgBefore - (await usdg.balanceOf(carol))).to.equal(repaid);
      expect(sharesSeized).to.equal(await amd.vault.convertToShares((repaid * 10_500n) / BPS));
      expect(await amd.vault.balanceOf(carol)).to.equal(sharesSeized);
      expect(badDebt).to.equal(0n);
      expect((await desk.accounts(alice)).collateralShares).to.equal(shares - sharesSeized);
      expect(await desk.totalCollateralShares()).to.equal(shares - sharesSeized);
      expect(await desk.debtOf(alice)).to.be.closeTo(USDG(2_000), USDG(0.01));
      expect(await desk.badDebt()).to.equal(0n);
      expect(ev.args.liquidator).to.equal(carol.address);
      expect(ev.args.account).to.equal(alice.address);
    });

    it("sends seized shares to a separate receiver and still works while paused", async function () {
      const { desk, alice, bob, carol, guardian, usdg, amd } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(30));
      await desk.connect(guardian).pause();
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      const bobBefore = await amd.vault.balanceOf(bob);
      await desk.connect(carol).liquidate(alice.address, USDG(100), bob.address);
      expect(await amd.vault.balanceOf(carol)).to.equal(0n);
      expect((await amd.vault.balanceOf(bob)) - bobBefore).to.equal(await amd.vault.convertToShares(USDG(105)));
      expect(await desk.debtOf(alice)).to.be.closeTo(USDG(3_900), USDG(0.01));
    });

    it("writes off bad debt exactly and reduces lender assets by the written amount", async function () {
      const ctx = await baseFixture();
      const desk = await deployDesk(ctx);
      await lend(ctx, desk, ctx.bob, USDG(50_000));
      const shares = await makeCollateral(ctx, true);
      await pledge(ctx, desk, ctx.alice, shares);
      await desk.connect(ctx.alice).borrow(USDG(4_000), ctx.alice.address);
      await ctx.amd.feed.setAnswer(FEED(15)); // collateral 10000 -> 1000

      const assetsBefore = await desk.totalAssets();
      const collValue = await desk.collateralValue(ctx.alice);
      await ctx.usdg.connect(ctx.carol).approve(desk, ethers.MaxUint256);
      const tx = await desk.connect(ctx.carol).liquidate(ctx.alice.address, USDG(2_000), ctx.carol.address);
      const ev = findEvent(desk, await tx.wait(), "Liquidated");

      expect(ev.args.sharesSeized).to.equal(shares);
      expect(ev.args.repaid).to.be.closeTo((collValue * BPS) / 10_500n, 2n);
      expect(ev.args.badDebt).to.be.closeTo(USDG(4_000) - ev.args.repaid, USDG(0.01));
      expect(await desk.badDebt()).to.equal(ev.args.badDebt);
      expect((await desk.accounts(ctx.alice)).collateralShares).to.equal(0n);
      expect((await desk.accounts(ctx.alice)).debtScaled).to.equal(0n);
      expect(await desk.totalCollateralShares()).to.equal(0n);
      expect(await desk.totalDebt()).to.be.lte(1n);
      // lenders absorb the write-off (repayment only swaps debt for cash)
      expect(assetsBefore - (await desk.totalAssets())).to.be.closeTo(ev.args.badDebt, USDG(0.01));
    });

    it("records no bad debt when the seizure takes exactly all collateral and clears the debt", async function () {
      const { desk, alice, carol, usdg, amd, shares, pledged } = await loadFixture(exactFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await amd.feed.setAnswer(FEED(66)); // pledged value 3960, HF < 1
      const target = await amd.vault.convertToShares(USDG(4_200)); // debt * (1 + 5%)
      expect(target).to.be.gt(pledged);
      expect(target).to.be.lte(shares);
      await pledge({ amd }, desk, alice, target - pledged);
      expect(await desk.healthFactor(alice)).to.be.lt(WAD);

      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      await expect(desk.connect(carol).liquidate(alice.address, ethers.MaxUint256, carol.address))
        .to.emit(desk, "Liquidated")
        .withArgs(carol.address, alice.address, USDG(4_000), target, 0n);
      expect((await desk.accounts(alice)).collateralShares).to.equal(0n);
      expect(await desk.debtOf(alice)).to.equal(0n);
      expect(await desk.badDebt()).to.equal(0n);
      expect(await desk.totalDebt()).to.equal(0n);
    });
  });

  describe("reserves", function () {
    it("reverts claimReserves when there is nothing to claim", async function () {
      const { desk } = await loadFixture(deskFixture);
      await expect(desk.claimReserves()).to.be.revertedWithCustomError(desk, "ZeroAmount");
    });

    it("lets anyone send reserves to the FeeRouter, which routes them to BuyBurn", async function () {
      const { desk, alice, carol, usdg, feeRouter, buyBurn } = await loadFixture(deskFixture);
      await desk.connect(alice).borrow(USDG(4_000), alice.address);
      await time.increase(YEAR);
      const tx = await desk.connect(carol).claimReserves();
      const ev = findEvent(desk, await tx.wait(), "ReservesClaimed");
      expect(ev.args.amount).to.be.closeTo(USDG(12), USDG(0.01));
      expect(await desk.reserves()).to.equal(0n);
      expect(await usdg.balanceOf(feeRouter)).to.equal(ev.args.amount);
      // reserves were never lender money: lender assets unchanged by the claim
      expect(await desk.totalAssets()).to.be.closeTo(USDG(50_108), USDG(0.01));

      const ddBefore = await usdg.balanceOf(buyBurn);
      await feeRouter.connect(carol).route(usdg);
      expect((await usdg.balanceOf(buyBurn)) - ddBefore).to.equal(ev.args.amount);
      expect(await usdg.balanceOf(feeRouter)).to.equal(0n);
    });

    it("claims only the cash on hand when reserves exceed cash", async function () {
      const ctx = await loadFixture(insolventFixture);
      const { desk, carol, usdg, feeRouter } = ctx;
      expect(await desk.cash()).to.equal(0n);
      expect(await desk.utilization()).to.equal(WAD);
      await time.increase(YEAR);
      await desk.accrue();
      const res = await desk.reserves();
      expect(res).to.be.gt(0n);
      await expect(desk.claimReserves()).to.be.revertedWithCustomError(desk, "ZeroAmount");
      // free cash is zero: reserves are not lendable nor withdrawable
      expect(await desk.maxWithdraw(ctx.bob)).to.equal(0n);

      await usdg.connect(carol).transfer(desk, res / 2n); // donation
      await desk.claimReserves();
      expect(await usdg.balanceOf(feeRouter)).to.equal(res / 2n);
      expect(await desk.reserves()).to.be.closeTo(res - res / 2n, USDG(0.001));
    });

    it("writes reserves off against bad debt first, leaving recovered cash to the existing lenders", async function () {
      const ctx = await loadFixture(insolventFixture);
      const { desk, alice, carol, usdg } = ctx;
      await time.increase(YEAR);
      await refreshPrice(ctx, 1); // AMD collapses to $1; collateral now worth ~66 USDG
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      await desk.connect(carol).liquidate(alice.address, ethers.MaxUint256, carol.address);

      const cash = await desk.cash();
      expect(cash).to.be.gt(0n);
      expect(await desk.totalDebt()).to.be.lte(1n);
      expect(await desk.reserves()).to.equal(0n);
      expect(await desk.totalAssets()).to.be.closeTo(cash, 1n);
      expect(await desk.maxWithdraw(ctx.bob)).to.be.closeTo(cash, 1n);
      await expect(desk.claimReserves()).to.be.revertedWithCustomError(desk, "ZeroAmount");
      expect(await desk.utilization()).to.equal(0n);
      expect(await desk.badDebt()).to.be.gt(USDG(6_000));
    });

    // Reserves booked on never-collected interest must not survive a write-off. If they did, a later lender's
    // deposit would fill the hole and claimReserves() could send part of it to the FeeRouter.
    it("a lender depositing after a large write-off keeps the value of the deposit", async function () {
      const ctx = await loadFixture(insolventFixture);
      const { desk, alice, carol, usdg } = ctx;
      await time.increase(YEAR);
      await refreshPrice(ctx, 1);
      await usdg.connect(carol).approve(desk, ethers.MaxUint256);
      await desk.connect(carol).liquidate(alice.address, ethers.MaxUint256, carol.address);

      await desk.connect(carol).deposit(USDG(1_000), carol.address);
      expect(await desk.maxWithdraw(carol)).to.be.closeTo(USDG(1_000), USDG(1));
    });
  });
});

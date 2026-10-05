const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, baseFixture, deposit } = require("./fixtures");

describe("Vault (extra coverage)", function () {
  function config(ctx, overrides = {}) {
    return {
      usdg: ctx.usdg.target,
      stock: ctx.amd.stock.target,
      position: ctx.amd.position.target,
      oracle: ctx.oracle.target,
      swapAdapter: ctx.swap.target,
      feeRouter: ctx.feeRouter.target,
      admin: ctx.admin.address,
      guardian: ctx.guardian.address,
      keeper: ctx.keeper.address,
      heldValueCap: USDG(1_000_000),
      ...overrides,
    };
  }

  describe("constructor", function () {
    for (const field of ["stock", "position", "oracle", "swapAdapter", "feeRouter", "admin", "guardian", "keeper"]) {
      it(`rejects a zero ${field}`, async function () {
        const ctx = await loadFixture(baseFixture);
        const Vault = await ethers.getContractFactory("XStockFiLiquidityVault");
        await expect(
          Vault.deploy(config(ctx, { [field]: ethers.ZeroAddress }), "w", "w")
        ).to.be.revertedWithCustomError(Vault, "InvalidConfig");
      });
    }

    it("rejects guardian == admin", async function () {
      const ctx = await loadFixture(baseFixture);
      const Vault = await ethers.getContractFactory("XStockFiLiquidityVault");
      await expect(
        Vault.deploy(config(ctx, { guardian: ctx.admin.address }), "w", "w")
      ).to.be.revertedWithCustomError(Vault, "InvalidConfig");
    });

    it("stores its wiring and default risk parameters", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, stock, position } = ctx.amd;
      expect(await vault.asset()).to.equal(ctx.usdg.target);
      expect(await vault.stock()).to.equal(stock.target);
      expect(await vault.position()).to.equal(position.target);
      expect(await vault.feeRouter()).to.equal(ctx.feeRouter.target);
      expect(await vault.protocolShareBps()).to.equal(3000);
      expect(await vault.maxPoolDeviationBps()).to.equal(200);
      expect(await vault.maxSwapLossBps()).to.equal(100);
      expect(await vault.decimals()).to.equal(12); // 6 USDG decimals + 6 offset
      expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), ctx.admin.address)).to.equal(false);
    });
  });

  describe("caps and max views", function () {
    it("maxDeposit / maxMint drop to zero once Held Value reaches the cap", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await vault.connect(ctx.admin).setHeldValueCap(USDG(1_000));
      expect(await vault.maxMint(ctx.alice)).to.be.gt(0);
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      expect(await vault.maxDeposit(ctx.alice)).to.equal(0);
      expect(await vault.maxMint(ctx.alice)).to.equal(0);

      await ctx.usdg.connect(ctx.alice).approve(vault, USDG(10));
      await expect(vault.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(
        vault,
        "ERC4626ExceededMaxMint"
      );

      // Lowering the cap below Held Value keeps it closed rather than underflowing.
      await vault.connect(ctx.guardian).lowerHeldValueCap(USDG(500));
      expect(await vault.maxDeposit(ctx.alice)).to.equal(0);
    });

    it("mints an exact share amount for USDG", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      const shares = await vault.previewDeposit(USDG(100));
      const assets = await vault.previewMint(shares);
      await ctx.usdg.connect(ctx.alice).approve(vault, assets);
      await expect(vault.connect(ctx.alice).mint(shares, ctx.alice.address)).to.emit(vault, "Deposit");
      expect(await vault.balanceOf(ctx.alice)).to.equal(shares);
      expect(await vault.totalAssets()).to.equal(assets);
    });

    it("rejects USDG exits above maxWithdraw / maxRedeem", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      const shares = await vault.balanceOf(ctx.alice);
      await expect(
        vault.connect(ctx.alice).withdraw(USDG(1_001), ctx.alice.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxWithdraw");
      await expect(
        vault.connect(ctx.alice).redeem(shares + 1n, ctx.alice.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxRedeem");
    });

    it("blocks USDG exits while the price is stale", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      await time.increase(3601);
      expect(await vault.maxWithdraw(ctx.alice)).to.equal(0);
      await expect(vault.connect(ctx.alice).withdraw(1n, ctx.alice.address, ctx.alice.address)).to.be.reverted;
      await expect(vault.connect(ctx.alice).redeem(1n, ctx.alice.address, ctx.alice.address)).to.be.reverted;
    });

    it("lets a spender withdraw on the owner's behalf only with allowance", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      await expect(
        vault.connect(ctx.bob).withdraw(USDG(100), ctx.bob.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");
      await vault.connect(ctx.alice).approve(ctx.bob, await vault.balanceOf(ctx.alice));
      const before = await ctx.usdg.balanceOf(ctx.bob);
      await vault.connect(ctx.bob).withdraw(USDG(100), ctx.bob.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.bob)) - before).to.equal(USDG(100));
    });
  });

  describe("pool deviation", function () {
    it("rejects when pool spot is below the oracle beyond the limit, accepts at the edge", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await ctx.usdg.connect(ctx.alice).approve(vault, USDG(200));

      await position.setSpot(USDG(140));
      await expect(vault.connect(ctx.alice).deposit(USDG(100), ctx.alice.address))
        .to.be.revertedWithCustomError(vault, "PoolDeviation")
        .withArgs(USDG(140), USDG(150));

      // exactly 2% away is allowed (strict >)
      await position.setSpot(USDG(147));
      await vault.connect(ctx.alice).deposit(USDG(100), ctx.alice.address);
      await position.setSpot(USDG(153));
      await vault.connect(ctx.alice).deposit(USDG(100), ctx.alice.address);
    });

    it("also guards withdraw, redeem and rebalance but not redeemInKind", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      await position.setSpot(USDG(100));
      await expect(vault.connect(ctx.alice).withdraw(1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        vault,
        "PoolDeviation"
      );
      await expect(vault.connect(ctx.alice).redeem(1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        vault,
        "PoolDeviation"
      );
      await expect(vault.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x")).to.be.revertedWithCustomError(
        vault,
        "PoolDeviation"
      );
      await expect(vault.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(vault, "PoolDeviation");
      const shares = await vault.balanceOf(ctx.alice);
      await vault.connect(ctx.alice).redeemInKind(shares, ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await vault.totalSupply()).to.equal(0);
    });
  });

  describe("pause matrix", function () {
    it("only the guardian pauses; only the admin unpauses", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      for (const s of [ctx.admin, ctx.keeper, ctx.alice]) {
        await expect(vault.connect(s).pause()).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      }
      await expect(vault.connect(ctx.guardian).pause()).to.emit(vault, "Paused");
      for (const s of [ctx.guardian, ctx.keeper, ctx.alice]) {
        await expect(vault.connect(s).unpause()).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      }
      await expect(vault.connect(ctx.admin).unpause()).to.emit(vault, "Unpaused");
    });

    it("while paused: depositing, minting and rebalancing stop; every exit and harvest stays open", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(3_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_000), "0x");
      await vault.connect(ctx.guardian).pause();

      expect(await vault.maxDeposit(ctx.alice)).to.equal(0);
      expect(await vault.maxMint(ctx.alice)).to.equal(0);
      await ctx.usdg.connect(ctx.alice).approve(vault, USDG(10));
      await expect(vault.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(vault.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(vault, "EnforcedPause");
      await expect(vault.connect(ctx.keeper).rebalance(-600, 600, false, 0, "0x")).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );

      await position.accrueFees(0, USDG(10));
      await vault.harvest();
      await vault.connect(ctx.alice).withdraw(USDG(500), ctx.alice.address, ctx.alice.address);
      await vault.connect(ctx.alice).redeem((await vault.balanceOf(ctx.alice)) / 3n, ctx.alice.address, ctx.alice.address);
      await vault.connect(ctx.alice).redeemInKind(await vault.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await vault.totalSupply()).to.equal(0);
    });
  });

  describe("governance setters", function () {
    it("restricts every setter to its role", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      const E = "AccessControlUnauthorizedAccount";
      await expect(vault.connect(ctx.guardian).setHeldValueCap(1)).to.be.revertedWithCustomError(vault, E);
      await expect(vault.connect(ctx.keeper).setHeldValueCap(1)).to.be.revertedWithCustomError(vault, E);
      await expect(vault.connect(ctx.admin).lowerHeldValueCap(1)).to.be.revertedWithCustomError(vault, E);
      await expect(vault.connect(ctx.guardian).setProtocolShareBps(1)).to.be.revertedWithCustomError(vault, E);
      await expect(vault.connect(ctx.guardian).setRiskLimits(100, 100)).to.be.revertedWithCustomError(vault, E);
      await expect(vault.connect(ctx.admin).rebalance(0, 60, false, 0, "0x")).to.be.revertedWithCustomError(vault, E);
    });

    it("lowerHeldValueCap accepts an equal cap and emits", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await expect(vault.connect(ctx.guardian).lowerHeldValueCap(USDG(1_000_000)))
        .to.emit(vault, "HeldValueCapSet")
        .withArgs(USDG(1_000_000));
      await expect(vault.connect(ctx.admin).setHeldValueCap(USDG(2_000_000)))
        .to.emit(vault, "HeldValueCapSet")
        .withArgs(USDG(2_000_000));
    });

    it("validates risk limits against hard maxima", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      const a = vault.connect(ctx.admin);
      for (const [dev, loss] of [
        [0, 100],
        [501, 100],
        [200, 0],
        [200, 301],
      ]) {
        await expect(a.setRiskLimits(dev, loss)).to.be.revertedWithCustomError(vault, "InvalidConfig");
      }
      await expect(a.setRiskLimits(500, 300)).to.emit(vault, "RiskLimitsSet").withArgs(500, 300);
      expect(await vault.maxPoolDeviationBps()).to.equal(500);
      expect(await vault.maxSwapLossBps()).to.equal(300);
      await a.setRiskLimits(1, 1);
      expect(await vault.maxPoolDeviationBps()).to.equal(1);
    });

    it("fee split: accepts exactly 30%, harvests pending fees at the old share before changing it", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      await expect(vault.connect(ctx.admin).setProtocolShareBps(3000)).to.emit(vault, "ProtocolShareSet").withArgs(3000);

      await position.accrueFees(0, USDG(100));
      await vault.connect(ctx.admin).setProtocolShareBps(0);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
      expect(await vault.protocolShareBps()).to.equal(0);

      // With a 0% share nothing leaves for the FeeRouter, but gross fees are still tracked.
      await position.accrueFees(EQ(1), USDG(100));
      await expect(vault.harvest()).to.emit(vault, "FeesHarvested").withArgs(EQ(1), USDG(100), 0, 0);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
      expect(await ctx.amd.stock.balanceOf(ctx.feeRouter)).to.equal(0);
      expect(await vault.grossStockFees()).to.equal(EQ(1));
      expect(await vault.grossUsdgFees()).to.equal(USDG(200));
    });

    it("harvest with no pending fees is a no-op", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(ctx.amd.vault.harvest()).not.to.emit(ctx.amd.vault, "FeesHarvested");
    });

    it("harvest forwards an stock-only fee share", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position, stock } = ctx.amd;
      await position.accrueFees(EQ(10), 0);
      await expect(vault.harvest()).to.emit(vault, "FeesHarvested").withArgs(EQ(10), 0, EQ(3), 0);
      expect(await stock.balanceOf(ctx.feeRouter)).to.equal(EQ(3));
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(0);
    });
  });

  describe("rebalance", function () {
    it("can sell Stock Token, or skip the swap entirely", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position, stock } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(3_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(3_000), "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(0);
      const eq = await stock.balanceOf(position);
      expect(eq).to.be.closeTo(EQ(20), EQ(0.000001));

      await expect(vault.connect(ctx.keeper).rebalance(-120, 120, false, EQ(10), "0x"))
        .to.emit(vault, "Rebalanced")
        .withArgs(-120, 120, 1);
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(1_500));
      expect(await stock.balanceOf(position)).to.equal(eq - EQ(10));

      await vault.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(1_500));
      expect(await position.entries()).to.equal(3);
    });

    it("reverts when the price is stale", async function () {
      const ctx = await loadFixture(baseFixture);
      await time.increase(3601);
      await expect(ctx.amd.vault.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x")).to.be.reverted;
    });

    it("bounds the swap with the oracle minOut (adapter under-delivers -> reverts)", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, stock } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(3_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_500), "0x");
      // 2% worse than oracle on the sell side; limit is 1%.
      await ctx.swap.setRate(stock, ctx.usdg, ((USDG(147) * 10n ** 18n) / EQ(1)));
      await expect(vault.connect(ctx.keeper).rebalance(-600, 600, false, EQ(5), "0x")).to.be.reverted;
    });
  });

  describe("USDG exits that sell idle Stock Token", function () {
    it("sells idle Stock Token when the range is empty", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, stock } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(10_000));
      // Idle stock in the Vault with an empty range (e.g. donated / compounded).
      await stock.mint(vault, EQ(10));
      expect(await vault.totalAssets()).to.equal(USDG(11_500));

      const before = await ctx.usdg.balanceOf(ctx.alice);
      await vault.connect(ctx.alice).withdraw(USDG(11_000), ctx.alice.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(USDG(11_000));
      expect(await stock.balanceOf(vault)).to.be.lt(EQ(10));
      expect(await stock.balanceOf(vault)).to.be.gt(EQ(3));
    });

    it("pulls only USDG from a USDG-only range without swapping", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(10_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, false, 0, "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(10_000));
      const before = await ctx.usdg.balanceOf(ctx.alice);
      await vault.connect(ctx.alice).redeem((await vault.balanceOf(ctx.alice)) / 2n, ctx.alice.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.be.closeTo(USDG(5_000), 1n);
    });
  });

  describe("redeemInKind", function () {
    it("rejects zero shares", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(
        ctx.amd.vault.connect(ctx.alice).redeemInKind(0, ctx.alice.address, ctx.alice.address, 0, 0)
      ).to.be.revertedWithCustomError(ctx.amd.vault, "InvalidConfig");
    });

    it("needs allowance for a third party and spends it", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      const shares = await vault.balanceOf(ctx.alice);
      await expect(
        vault.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address, 0, 0)
      ).to.be.revertedWithCustomError(vault, "ERC20InsufficientAllowance");
      await vault.connect(ctx.alice).approve(ctx.bob, shares);
      const before = await ctx.usdg.balanceOf(ctx.bob);
      await expect(vault.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address, 0, 0)).to.emit(
        vault,
        "RedeemedInKind"
      );
      expect((await ctx.usdg.balanceOf(ctx.bob)) - before).to.equal(USDG(1_000));
      expect(await vault.allowance(ctx.alice, ctx.bob)).to.equal(0);
    });

    it("enforces minStock and minUsdg slippage bounds", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(3_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_500), "0x");
      const shares = await vault.balanceOf(ctx.alice);
      const [he, hu] = await vault.holdings();
      expect(hu).to.equal(USDG(1_500));
      const a = vault.connect(ctx.alice);
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, he + 1n, 0)).to.be.revertedWithCustomError(
        vault,
        "Slippage"
      );
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, 0, USDG(1_500) + 1n)).to.be.revertedWithCustomError(
        vault,
        "Slippage"
      );
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, he, hu))
        .to.emit(vault, "RedeemedInKind")
        .withArgs(ctx.alice.address, ctx.alice.address, ctx.alice.address, shares, he, hu);
    });

    it("rounds down in favour of remaining holders and returns idle plus range balances", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, stock } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(3_000));
      await deposit(ctx, vault, ctx.bob, USDG(3_000));
      await vault.connect(ctx.keeper).rebalance(-600, 600, true, USDG(3_000), "0x");
      await stock.mint(vault, EQ(1)); // idle stock on top of the range
      await ctx.usdg.mint(vault, USDG(7)); // idle USDG on top of the range

      // A dust redemption pays no USDG (rounds to zero) but still burns the share.
      const [heD, huD] = await vault.holdings();
      const supplyD = await vault.totalSupply();
      const eD = await stock.balanceOf(ctx.alice);
      const uD = await ctx.usdg.balanceOf(ctx.alice);
      const s0 = await vault.balanceOf(ctx.alice);
      await vault.connect(ctx.alice).redeemInKind(1n, ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await vault.balanceOf(ctx.alice)).to.equal(s0 - 1n);
      expect(await ctx.usdg.balanceOf(ctx.alice)).to.equal(uD);
      expect(huD / supplyD).to.equal(0);
      expect((await stock.balanceOf(ctx.alice)) - eD).to.be.lte(heD / supplyD);

      // An odd share count: outputs never exceed the exact pro-rata amount.
      const e0 = await stock.balanceOf(ctx.alice);
      const u0 = await ctx.usdg.balanceOf(ctx.alice);
      const [heB, huB] = await vault.holdings();
      const supply = await vault.totalSupply();
      const odd = (await vault.balanceOf(ctx.alice)) - 12345n;
      await vault.connect(ctx.alice).redeemInKind(odd, ctx.alice.address, ctx.alice.address, 0, 0);
      const gotE = (await stock.balanceOf(ctx.alice)) - e0;
      const gotU = (await ctx.usdg.balanceOf(ctx.alice)) - u0;
      expect(gotE).to.be.lte((heB * odd) / supply);
      expect(gotU).to.be.lte((huB * odd) / supply);
      expect(gotE).to.be.gte((heB * odd) / supply - 2n);
      expect(gotU).to.be.gte((huB * odd) / supply - 2n);

      // Bob, who stayed, is not diluted.
      const [heA, huA] = await vault.holdings();
      const bobShares = await vault.balanceOf(ctx.bob);
      const supplyA = await vault.totalSupply();
      expect((heA * 10n ** 18n) / supplyA).to.be.gte((heB * 10n ** 18n) / supply);
      expect((huA * 10n ** 18n) / supplyA).to.be.gte((huB * 10n ** 18n) / supply);
      expect(bobShares).to.be.gt(0);
    });

    it("works while the price is stale and while paused, harvesting first", async function () {
      const ctx = await loadFixture(baseFixture);
      const { vault, position } = ctx.amd;
      await deposit(ctx, vault, ctx.alice, USDG(1_000));
      await position.accrueFees(0, USDG(100));
      await vault.connect(ctx.guardian).pause();
      await ctx.amd.feed.set(FEED(150), 1, 1);
      expect(await vault.priceFresh()).to.equal(false);
      const before = await ctx.usdg.balanceOf(ctx.alice);
      await vault.connect(ctx.alice).redeemInKind(await vault.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address, 0, 0);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(USDG(1_070));
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
    });
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { State, HOUR, DAY, vaultFixture, refresh, USDG, EQ, FEED, rate } = require("./desk.fixtures");

const SHARE = 10n ** 12n; // shares per USDG base unit at the start

async function funded() {
  const ctx = await vaultFixture();
  await ctx.vault.connect(ctx.alice).deposit(USDG(10_000));
  return ctx;
}

async function start(ctx, days = 7) {
  const expiry = (await time.latest()) + days * DAY;
  await ctx.vault.connect(ctx.keeper).startRound(expiry);
  return expiry;
}

/** A 145-strike put on 10 AMD (1,450 USDG collateral) for a 15 USDG premium. */
async function sellPut(ctx, o = {}) {
  const a = { strike: USDG(145), size: EQ(10), premium: USDG(15), window: 2 * HOUR, ...o };
  const id = await ctx.desk.count();
  await ctx.vault.connect(ctx.keeper).sellPut(a.strike, a.size, a.premium, a.window);
  return id;
}

describe("XStockFiIncomeVault", function () {
  describe("between rounds", function () {
    it("mints shares at once and pays exits at once", async function () {
      const ctx = await loadFixture(vaultFixture);
      const { vault, alice, usdg } = ctx;
      expect(await vault.previewDeposit(USDG(1_000))).to.equal(USDG(1_000) * SHARE);
      await expect(vault.connect(alice).deposit(USDG(1_000)))
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, USDG(1_000), USDG(1_000) * SHARE);
      expect(await vault.totalValue()).to.equal(USDG(1_000));
      const a0 = await usdg.balanceOf(alice);
      await vault.connect(alice).withdraw(USDG(400) * SHARE);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(400));
      await expect(vault.connect(alice).deposit(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("enforces the deposit cap", async function () {
      const ctx = await loadFixture(vaultFixture);
      const { vault, admin, guardian, alice } = ctx;
      await vault.connect(admin).setDepositCap(USDG(5_000));
      await vault.connect(alice).deposit(USDG(5_000));
      await expect(vault.connect(alice).deposit(1)).to.be.revertedWithCustomError(vault, "CapExceeded");
      await expect(vault.connect(guardian).lowerDepositCap(USDG(6_000))).to.be.revertedWithCustomError(vault, "InvalidConfig");
      await vault.connect(guardian).lowerDepositCap(USDG(4_000));
      expect(await vault.depositCap()).to.equal(USDG(4_000));
    });
  });

  describe("selling options", function () {
    it("starts a round within the allowed length, keeper only", async function () {
      const ctx = await loadFixture(funded);
      const { vault, keeper, alice } = ctx;
      const now = await time.latest();
      await expect(vault.connect(alice).startRound(now + 7 * DAY)).to.be.reverted;
      await expect(vault.connect(keeper).startRound(now + 3 * HOUR)).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(vault.connect(keeper).startRound(now + 15 * DAY)).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(vault.connect(keeper).sellPut(USDG(145), EQ(1), USDG(5), HOUR)).to.be.revertedWithCustomError(vault, "NoRound");
      await vault.connect(keeper).startRound(now + 7 * DAY);
      expect(await vault.live()).to.equal(true);
      expect(await vault.roundStartValue()).to.equal(USDG(10_000));
      await expect(vault.connect(keeper).startRound(now + 7 * DAY)).to.be.revertedWithCustomError(vault, "RoundLive");
    });

    it("sells a put on the desk with the vault's USDG as collateral and a quote band", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, usdg } = ctx;
      const expiry = await start(ctx);
      const id = await sellPut(ctx);
      const o = await desk.get(id);
      expect(o.writer).to.equal(vault.target);
      expect(o.kind).to.equal(1n);
      expect(o.collateral).to.equal(USDG(1_450));
      expect(o.expiry).to.equal(BigInt(expiry));
      expect(o.minPrice).to.equal(USDG("148.5"));
      expect(o.maxPrice).to.equal(USDG("151.5"));
      expect(Number(o.buyBy)).to.be.closeTo((await time.latest()) + 2 * HOUR, 2);
      expect(await usdg.balanceOf(vault)).to.equal(USDG(8_550));
      expect(await vault.committed()).to.equal(USDG(1_450));
      expect(await vault.roundOptions()).to.deep.equal([id]);
    });

    it("refuses quotes outside the limits", async function () {
      const ctx = await loadFixture(funded);
      const { vault } = ctx;
      await start(ctx);
      // 3% out of the money at 150 means a put strike of 145.50 at most
      await expect(sellPut(ctx, { strike: USDG(146) })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      // 0.2% of 1,450 collateral is 2.90
      await expect(sellPut(ctx, { premium: USDG("2.8") })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(sellPut(ctx, { window: 7 * HOUR })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(sellPut(ctx, { window: 0 })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      // more than 80% of the round's 10,000 committed
      await expect(sellPut(ctx, { size: EQ(56), premium: USDG(17) })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      // calls need Stock Tokens the vault does not have yet
      await expect(ctx.vault.connect(ctx.keeper).sellCall(USDG(160), EQ(1), USDG(5), HOUR)).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await sellPut(ctx, { size: EQ(55), premium: USDG(16) });
    });

    it("frees the commitment of an offer it withdraws", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, keeper, alice } = ctx;
      await start(ctx);
      const a = await sellPut(ctx, { size: EQ(50) });
      await expect(sellPut(ctx, { size: EQ(10) })).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(vault.connect(alice).withdrawOffer(a)).to.be.reverted;
      await vault.connect(keeper).withdrawOffer(a);
      expect((await desk.get(a)).state).to.equal(State.Cancelled);
      expect(await vault.committed()).to.equal(0n);
      await sellPut(ctx, { size: EQ(50) });
      await expect(vault.connect(keeper).withdrawOffer(999)).to.be.revertedWithCustomError(vault, "OutsideLimits");
    });

    it("caps the options in one round", async function () {
      const ctx = await loadFixture(funded);
      const { vault } = ctx;
      await start(ctx);
      for (let i = 0; i < 20; i++) await sellPut(ctx, { size: EQ(1), premium: USDG(1) });
      await expect(sellPut(ctx, { size: EQ(1), premium: USDG(1) })).to.be.revertedWithCustomError(vault, "OutsideLimits");
    });

    it("receives the premium when a trader buys", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, bob, usdg } = ctx;
      await start(ctx);
      const id = await sellPut(ctx);
      const v0 = await usdg.balanceOf(vault);
      await desk.connect(bob).buy(id);
      expect((await usdg.balanceOf(vault)) - v0).to.equal(USDG("14.85"));
    });
  });

  describe("closing a round", function () {
    it("only after expiry, unless the keeper closes with nothing left open", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, keeper, bob } = ctx;
      await start(ctx);
      const id = await sellPut(ctx);
      await expect(vault.connect(bob).closeRound()).to.be.revertedWithCustomError(vault, "TooEarly");
      await desk.connect(bob).buy(id);
      await expect(vault.connect(keeper).closeRound()).to.be.revertedWithCustomError(vault, "NotSettled").withArgs(id);
    });

    it("lets the keeper close early, taking back unsold offers", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, keeper, usdg } = ctx;
      await start(ctx);
      const id = await sellPut(ctx);
      await vault.connect(keeper).closeRound();
      expect((await desk.get(id)).state).to.equal(State.Cancelled);
      expect(await usdg.balanceOf(vault)).to.equal(USDG(10_000));
      expect(await vault.live()).to.equal(false);
      expect(await vault.round()).to.equal(1n);
    });

    it("after expiry anyone closes: expires options, pays queued exits and prices queued deposits", async function () {
      const ctx = await loadFixture(funded);
      const { vault, desk, alice, bob, carol, usdg } = ctx;
      await start(ctx);
      const id = await sellPut(ctx);
      await desk.connect(bob).buy(id);

      // queued during the round
      await expect(vault.connect(carol).deposit(USDG(1_000))).to.emit(vault, "DepositQueued");
      expect(await vault.pendingUsdg()).to.equal(USDG(1_000));
      const half = (await vault.balanceOf(alice)) / 2n;
      await expect(vault.connect(alice).withdraw(half)).to.emit(vault, "ExitQueued");
      expect(await vault.balanceOf(vault)).to.equal(half);

      await time.increase(7 * DAY);
      await refresh(ctx);
      await vault.connect(bob).closeRound();
      expect((await desk.get(id)).state).to.equal(State.Expired);

      // the round earned 14.85; alice's queued half gets half of 10,014.85
      const [shares, usdgOut, stockOut] = await vault.claimable(alice);
      expect(shares).to.equal(0n);
      expect(usdgOut).to.equal(USDG("5007.425"));
      expect(stockOut).to.equal(0n);
      const a0 = await usdg.balanceOf(alice);
      await vault.connect(alice).claim();
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG("5007.425"));

      // carol joins at the post-round price, so she does not share in a premium earned before she came in
      await vault.connect(carol).claim();
      const carolShares = await vault.balanceOf(carol);
      const [carolUsdg] = await vault.previewWithdraw(carolShares);
      expect(carolUsdg).to.be.closeTo(USDG(1_000), 2n);
      expect(await vault.reservedUsdg()).to.equal(0n);
      expect(await vault.unclaimedShares()).to.be.lte(1n);
    });

    it("lets queued deposits and exits be taken back before the close", async function () {
      const ctx = await loadFixture(funded);
      const { vault, alice, carol, usdg } = ctx;
      await start(ctx);
      const c0 = await usdg.balanceOf(carol);
      await vault.connect(carol).deposit(USDG(500));
      await vault.connect(carol).cancelDeposit();
      expect(await usdg.balanceOf(carol)).to.equal(c0);
      await expect(vault.connect(carol).cancelDeposit()).to.be.revertedWithCustomError(vault, "NothingToCancel");
      const s = await vault.balanceOf(alice);
      await vault.connect(alice).withdraw(s);
      await vault.connect(alice).cancelWithdraw();
      expect(await vault.balanceOf(alice)).to.equal(s);
      expect(await vault.queuedShares()).to.equal(0n);
    });
  });

  describe("the wheel", function () {
    async function assigned() {
      const ctx = await funded();
      const { vault, desk, bob, amd } = ctx;
      await start(ctx);
      const id = await sellPut(ctx);
      await desk.connect(bob).buy(id);
      await amd.feed.setAnswer(FEED(140));
      await desk.connect(bob).exercise(id); // bob sells 10 AMD at 145
      return { ...ctx, putId: id };
    }

    it("takes delivery when a put is exercised and pays exits in kind", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, alice, usdg, amd } = ctx;
      expect(await amd.stock.balanceOf(vault)).to.equal(EQ(10));
      expect(await vault.freeUsdg()).to.equal(USDG(10_000) - USDG(1_450) + USDG("14.85"));
      await vault.connect(alice).withdraw((await vault.balanceOf(alice)) / 4n);
      await time.increase(7 * DAY);
      await refresh(ctx, 140);
      await vault.closeRound();
      const [, u, s] = await vault.claimable(alice);
      expect(u).to.equal(USDG("8564.85") / 4n);
      expect(s).to.equal(EQ("2.5"));
      const s0 = await amd.stock.balanceOf(alice);
      await vault.connect(alice).claim();
      expect((await amd.stock.balanceOf(alice)) - s0).to.equal(EQ("2.5"));
      expect(await vault.reservedStock()).to.equal(0n);
    });

    it("prices deposits with the Stock Tokens at Chainlink plus the quote band", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, carol } = ctx;
      await vault.connect(carol).deposit(USDG(1_000));
      await time.increase(7 * DAY);
      await refresh(ctx, 140);
      await vault.closeRound();
      expect(await vault.pendingUsdg()).to.equal(USDG(1_000)); // a public close leaves pricing to the keeper
      await vault.connect(ctx.keeper).processDeposits();
      // holders' side: 8,564.85 USDG + 10 AMD x 140 = 9,964.85, plus carol's 1,000
      expect(await vault.totalValue()).to.equal(USDG("10964.85"));
      await vault.connect(carol).claim();
      // carol buys in with the AMD marked up by the 1% entry spread: 8,564.85 + 1,414 = 9,978.85
      const shares = await vault.balanceOf(carol);
      expect(shares).to.be.closeTo((USDG(1_000) * USDG(10_000) * SHARE) / USDG("9978.85"), 10n ** 12n);
    });

    it("queues deposits while it holds Stock Tokens, so a lagging feed cannot be traded against", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, carol, usdg, amd } = ctx;
      await time.increase(7 * DAY);
      await refresh(ctx, 140);
      await vault.closeRound();
      // the feed says 140 while the market has moved 0.9% higher, inside the feed's deviation threshold
      await expect(vault.connect(carol).deposit(USDG(10_000))).to.emit(vault, "DepositQueued");
      expect(await vault.balanceOf(carol)).to.equal(0n);
      await vault.connect(ctx.keeper).processDeposits();
      const u0 = await usdg.balanceOf(carol);
      const s0 = await amd.stock.balanceOf(carol);
      await vault.connect(carol).claim();
      await vault.connect(carol).withdraw(await vault.balanceOf(carol));
      const worth = (await usdg.balanceOf(carol)) - u0 + (((await amd.stock.balanceOf(carol)) - s0) * USDG("141.26")) / EQ(1);
      expect(worth).to.be.lt(USDG(10_000));
    });

    it("stops a queued deposit from being cancelled once its round has expired", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, carol } = ctx;
      await vault.connect(carol).deposit(USDG(1_000));
      await time.increase(7 * DAY);
      await expect(vault.connect(carol).cancelDeposit()).to.be.revertedWithCustomError(vault, "TooLate");
    });

    it("leaves deposits waiting while the price is stale, then prices them on request", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, carol, bob, usdg } = ctx;
      await vault.connect(carol).deposit(USDG(1_000));
      await time.increase(7 * DAY); // no refresh: the AMD feed is stale
      await vault.closeRound();
      expect(await vault.pendingUsdg()).to.equal(USDG(1_000));
      expect(await vault.depositEpoch()).to.equal(0n);
      // a new deposit queues too, and both can still be cancelled
      await vault.connect(bob).deposit(USDG(100));
      await vault.connect(bob).cancelDeposit();
      await refresh(ctx, 140);
      await expect(vault.connect(bob).processDeposits()).to.be.reverted;
      await vault.connect(ctx.keeper).processDeposits();
      expect(await vault.pendingUsdg()).to.equal(0n);
      await expect(vault.connect(carol).cancelDeposit()).to.be.revertedWithCustomError(vault, "NothingToCancel");
      await vault.connect(carol).claim();
      expect(await vault.balanceOf(carol)).to.be.gt(0n);
      expect(await usdg.balanceOf(vault)).to.equal(USDG("8564.85") + USDG(1_000));
    });

    it("then sells covered calls on the tokens it holds", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, desk, keeper, bob, amd, usdg } = ctx;
      await time.increase(7 * DAY);
      await refresh(ctx, 140);
      await vault.closeRound();
      await start(ctx);
      // at 140, a call must be struck at 144.20 or higher
      await expect(vault.connect(keeper).sellCall(USDG(144), EQ(10), USDG(10), HOUR)).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await expect(vault.connect(keeper).sellCall(USDG(150), EQ(11), USDG(10), HOUR)).to.be.revertedWithCustomError(vault, "OutsideLimits");
      const id = await desk.count();
      await vault.connect(keeper).sellCall(USDG(150), EQ(10), USDG(10), HOUR);
      expect(await amd.stock.balanceOf(vault)).to.equal(0n);
      await desk.connect(bob).buy(id);
      await amd.feed.setAnswer(FEED(141)); // inside the band, still fine for bob to exercise
      await desk.connect(bob).exercise(id);
      // called away at 150: the vault is back in USDG
      expect(await amd.stock.balanceOf(vault)).to.equal(0n);
      expect(await usdg.balanceOf(vault)).to.equal(USDG("8564.85") + USDG(1_500) + USDG("9.9"));
    });

    it("can sell the tokens back to USDG between rounds, within the swap-loss limit", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, keeper, swap, usdg, amd } = ctx;
      await time.increase(7 * DAY);
      await refresh(ctx, 140);
      await vault.closeRound();
      await swap.setRate(amd.stock, usdg, rate(138, 18, 6)); // 1.43% under Chainlink: over the 1% limit
      await expect(vault.connect(keeper).sellStock(EQ(10), "0x")).to.be.reverted;
      await swap.setRate(amd.stock, usdg, rate(139, 18, 6));
      await expect(vault.connect(keeper).sellStock(EQ(10), "0x")).to.emit(vault, "StockSold").withArgs(EQ(10), USDG(1_390));
      await expect(vault.connect(keeper).sellStock(EQ(1), "0x")).to.be.revertedWithCustomError(vault, "OutsideLimits");
      await start(ctx);
      await expect(vault.connect(keeper).sellStock(EQ(1), "0x")).to.be.revertedWithCustomError(vault, "RoundLive");
    });

    it("books an exit payout a frozen holder cannot receive, without holding up the rest", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, alice, usdg, amd } = ctx;
      await time.increase(7 * DAY);
      await vault.closeRound();
      await usdg.setBlocked(alice, true);
      const s0 = await amd.stock.balanceOf(alice);
      await vault.connect(alice).withdraw((await vault.balanceOf(alice)) / 2n);
      expect((await amd.stock.balanceOf(alice)) - s0).to.equal(EQ(5));
      const [u] = await vault.owed(alice);
      expect(u).to.equal(USDG("8564.85") / 2n);
      expect(await vault.freeUsdg()).to.equal(USDG("8564.85") - u);
      await expect(vault.connect(alice).claimOwed()).to.be.reverted;
      await usdg.setBlocked(alice, false);
      await vault.connect(alice).claimOwed();
      expect(await vault.reservedUsdg()).to.equal(0n);
      await expect(vault.connect(alice).claimOwed()).to.be.revertedWithCustomError(vault, "NothingOwed");
    });

    it("pays exits between rounds in kind without needing a price", async function () {
      const ctx = await loadFixture(assigned);
      const { vault, alice, amd } = ctx;
      await time.increase(7 * DAY);
      await vault.closeRound(); // stale price: no deposits to price, so it closes anyway
      const all = await vault.balanceOf(alice);
      await vault.connect(alice).withdraw(all);
      expect(await amd.stock.balanceOf(vault)).to.equal(0n);
      expect(await vault.totalSupply()).to.equal(0n);
    });
  });

  it("pausing stops deposits and new rounds; exits and closing still work", async function () {
    const ctx = await loadFixture(funded);
    const { vault, admin, guardian, keeper, alice } = ctx;
    await start(ctx);
    await vault.connect(guardian).pause();
    await expect(vault.connect(alice).deposit(USDG(1))).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await expect(vault.connect(keeper).sellPut(USDG(145), EQ(1), USDG(5), HOUR)).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await vault.connect(alice).withdraw(USDG(1) * SHARE);
    await time.increase(7 * DAY);
    await vault.closeRound();
    await expect(vault.connect(keeper).startRound((await time.latest()) + 2 * DAY)).to.be.revertedWithCustomError(vault, "EnforcedPause");
    await vault.connect(alice).claim();
    await vault.connect(alice).withdraw(USDG(1) * SHARE);
    await expect(vault.connect(guardian).unpause()).to.be.reverted;
    await vault.connect(admin).unpause();
  });

  it("collects a premium the desk had to hold for it", async function () {
    const ctx = await loadFixture(funded);
    const { vault, desk, bob, usdg } = ctx;
    await start(ctx);
    const id = await sellPut(ctx);
    await usdg.setBlocked(vault, true);
    await desk.connect(bob).buy(id);
    expect(await desk.owed(usdg, vault)).to.equal(USDG("14.85"));
    await usdg.setBlocked(vault, false);
    await time.increase(7 * DAY);
    await vault.closeRound();
    expect(await desk.owed(usdg, vault)).to.equal(0n);
    expect(await vault.freeUsdg()).to.equal(USDG("10014.85"));
  });

  it("rejects limits outside the hard bounds", async function () {
    const ctx = await loadFixture(funded);
    const { vault, admin, limits } = ctx;
    const bad = [
      { minOtmBps: 49 },
      { minPremiumBps: 4 },
      { maxCommitBps: 9_001 },
      { quoteBandBps: 0 },
      { quoteBandBps: 301 },
      { maxSwapLossBps: 301 },
      { entrySpreadBps: 501 },
      { maxBuyWindow: DAY + 1 },
      { minRound: 11 * HOUR },
      { maxRound: 36 * DAY },
    ];
    for (const b of bad) {
      await expect(vault.connect(admin).setLimits({ ...limits, ...b })).to.be.revertedWithCustomError(vault, "InvalidConfig");
    }
    await expect(vault.connect(ctx.keeper).setLimits(limits)).to.be.reverted;
    await vault.connect(admin).setLimits({ ...limits, minOtmBps: 500 });
  });
});

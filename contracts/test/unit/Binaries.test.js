const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ABOVE, BELOW, Bet, HOUR, DAY, deskFixture, refresh, USDG, FEED } = require("./desk.fixtures");

async function open(ctx, maker, o = {}) {
  const now = await time.latest();
  const a = { side: ABOVE, strike: USDG(150), stake: USDG(100), expiry: now + DAY, joinBy: 0, ...o };
  const id = await ctx.binaries.count();
  await ctx.binaries.connect(maker).open(ctx.amd.stock, a.side, a.strike, a.stake, a.expiry, a.joinBy);
  return id;
}

describe("XStockFiBinaries", function () {
  describe("opening and joining", function () {
    it("takes the maker's stake and defaults the join deadline to halfway", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, usdg, amd } = ctx;
      const before = await usdg.balanceOf(alice);
      const now = await time.latest();
      const id = await open(ctx, alice, { expiry: now + 10 * HOUR });
      const b = await binaries.get(id);
      expect(before - (await usdg.balanceOf(alice))).to.equal(USDG(100));
      expect(b.state).to.equal(Bet.Open);
      expect(b.feed).to.equal(amd.feed.target);
      expect(Number(b.joinBy)).to.be.closeTo(now + 5 * HOUR, 2);
    });

    it("rejects bad terms", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, usdg, amd } = ctx;
      const now = await time.latest();
      await expect(open(ctx, alice, { side: 2 })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(open(ctx, alice, { strike: 0 })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(open(ctx, alice, { stake: USDG(4) })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(open(ctx, alice, { expiry: now + 600 })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(open(ctx, alice, { expiry: now + 31 * DAY })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(open(ctx, alice, { expiry: now + DAY, joinBy: now + 13 * HOUR })).to.be.revertedWithCustomError(binaries, "BadTerms");
      await expect(binaries.connect(alice).open(usdg, 0, USDG(1), USDG(10), now + DAY, 0)).to.be.revertedWithCustomError(binaries, "UnknownMarket");
      await amd.stock.setOraclePaused(true);
      await expect(open(ctx, alice)).to.be.revertedWithCustomError(binaries, "UnknownMarket");
    });

    it("matches a taker before the deadline only", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, carol, usdg } = ctx;
      const id = await open(ctx, alice);
      await expect(binaries.connect(alice).join(id)).to.be.revertedWithCustomError(binaries, "NotAllowed");
      const b0 = await usdg.balanceOf(bob);
      await expect(binaries.connect(bob).join(id)).to.emit(binaries, "Joined").withArgs(id, bob.address);
      expect(b0 - (await usdg.balanceOf(bob))).to.equal(USDG(100));
      await expect(binaries.connect(carol).join(id)).to.be.revertedWithCustomError(binaries, "WrongState");
      const late = await open(ctx, alice);
      await time.increase(12 * HOUR);
      await expect(binaries.connect(carol).join(late)).to.be.revertedWithCustomError(binaries, "TooLate");
    });

    it("refunds an unmatched bet: the maker any time, anyone after the deadline", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, usdg } = ctx;
      const a = await open(ctx, alice);
      const b = await open(ctx, alice);
      await expect(binaries.connect(bob).cancel(a)).to.be.revertedWithCustomError(binaries, "NotAllowed");
      const a0 = await usdg.balanceOf(alice);
      await binaries.connect(alice).cancel(a);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(100));
      await time.increase(12 * HOUR);
      await binaries.connect(bob).cancel(b);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(200));
      await expect(binaries.connect(alice).cancel(b)).to.be.revertedWithCustomError(binaries, "WrongState");
    });
  });

  describe("settlement", function () {
    async function matched(ctx, o) {
      const id = await open(ctx, ctx.alice, o);
      await ctx.binaries.connect(ctx.bob).join(id);
      return id;
    }

    it("pays the maker both stakes less the fee when the price finishes on their side", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, carol, usdg, amd, feeRouter } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      await time.increase(DAY - 60);
      await amd.feed.setAnswer(FEED("150.5"));
      await expect(binaries.settle(id, 0)).to.be.revertedWithCustomError(binaries, "TooEarly");
      await time.increase(120);
      await expect(binaries.settle(id, 0)).to.be.revertedWithCustomError(binaries, "TooEarly"); // settle delay
      await time.increase(300);
      const a0 = await usdg.balanceOf(alice);
      await expect(binaries.connect(carol).settle(id, 0))
        .to.emit(binaries, "Settled")
        .withArgs(id, alice.address, USDG("150.5"), USDG(198), USDG(2));
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(198));
      expect(await usdg.balanceOf(feeRouter)).to.equal(USDG(2));
      const b = await binaries.get(id);
      expect(b.state).to.equal(Bet.Settled);
      expect(b.makerWon).to.equal(true);
      expect(b.settlePrice).to.equal(USDG("150.5"));
      await expect(binaries.settle(id, 0)).to.be.revertedWithCustomError(binaries, "WrongState");
    });

    it("pays the taker when the maker's side loses", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, bob, usdg, amd } = ctx;
      const id = await matched(ctx, { side: BELOW, strike: USDG(150) });
      await amd.feed.setAnswer(FEED(151));
      await time.increase(DAY + 301);
      const b0 = await usdg.balanceOf(bob);
      await binaries.settle(id, 0);
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(198));
    });

    it("refunds both sides with no fee when the price lands exactly on the strike", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, usdg } = ctx;
      const id = await matched(ctx, { strike: USDG(150) });
      await time.increase(DAY + 301);
      const [a0, b0] = [await usdg.balanceOf(alice), await usdg.balanceOf(bob)];
      await expect(binaries.settle(id, 0)).to.emit(binaries, "Voided").withArgs(id);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(100));
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(100));
    });

    it("settles on the round that was current at expiry, proven with a hint", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, usdg, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      await time.increase(DAY - 100);
      await amd.feed.setAnswer(FEED(149)); // the price at expiry: below, so bob wins
      const atExpiry = await amd.feed.latestId();
      await time.increase(500);
      await amd.feed.setAnswer(FEED(160)); // after expiry; must not count
      const later = await amd.feed.latestId();
      await expect(binaries.settle(id, 0)).to.be.revertedWithCustomError(binaries, "NeedHint");
      await expect(binaries.settle(id, later)).to.be.revertedWithCustomError(binaries, "BadHint");
      await expect(binaries.settle(id, atExpiry - 1n)).to.be.revertedWithCustomError(binaries, "BadHint");
      const b0 = await usdg.balanceOf(bob);
      await binaries.settle(id, atExpiry);
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(198));
      expect((await binaries.get(id)).makerWon).to.equal(false);
      expect(await usdg.balanceOf(alice)).to.be.gt(0n);
    });

    it("proves the last round of an old phase through the first round of the next", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, usdg, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      await time.increase(DAY - 100);
      await amd.feed.setAnswer(FEED(152));
      const lastOfPhase1 = await amd.feed.latestId();
      await time.increase(500);
      await amd.feed.newPhase(FEED(140));
      await amd.feed.setAnswer(FEED(139));
      const a0 = await usdg.balanceOf(alice);
      await binaries.settle(id, lastOfPhase1);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(198));
    });

    it("proves a round across a phase that never reported", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, usdg, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      await time.increase(DAY - 100);
      await amd.feed.setAnswer(FEED(152));
      const atExpiry = await amd.feed.latestId();
      await time.increase(500);
      await amd.feed.skipPhase();
      await amd.feed.newPhase(FEED(140));
      const a0 = await usdg.balanceOf(alice);
      await binaries.settle(id, atExpiry);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(198));
    });

    it("will not let a settler choose between two phases that overlap at expiry", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      await time.increase(DAY - 100);
      await amd.feed.setAnswer(FEED(149));
      const oldPhase = await amd.feed.latestId();
      await amd.feed.newPhase(FEED(151)); // the new aggregator already reported before expiry
      const newPhaseFirst = await amd.feed.latestId();
      await time.increase(500);
      await amd.feed.setAnswer(FEED(152));
      await expect(binaries.settle(id, oldPhase)).to.be.revertedWithCustomError(binaries, "BadHint");
      await binaries.settle(id, newPhaseFirst);
      expect((await binaries.get(id)).settlePrice).to.equal(USDG(151));
    });

    it("refunds a bet that expired during a recorded corporate action", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, carol, usdg, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE });
      await expect(binaries.notePause(amd.stock)).to.be.revertedWithCustomError(binaries, "WrongState");
      await time.increase(DAY - 3600);
      await amd.stock.setOraclePaused(true);
      await binaries.connect(carol).notePause(amd.stock);
      await binaries.connect(carol).notePause(amd.stock); // already open: no second window
      await amd.feed.setAnswer(FEED(170));
      await time.increase(2 * 3600);
      await expect(binaries.noteResume(amd.stock)).to.be.revertedWithCustomError(binaries, "WrongState");
      await amd.stock.setOraclePaused(false);
      await binaries.connect(carol).noteResume(amd.stock);
      expect((await binaries.pauses(amd.stock)).length).to.equal(1);
      await time.increase(600);
      const [a0, b0] = [await usdg.balanceOf(alice), await usdg.balanceOf(bob)];
      await expect(binaries.settle(id, 0)).to.emit(binaries, "Voided");
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(100));
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(100));
    });

    it("voids when the price at expiry is older than four days", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, amd } = ctx;
      const now = await time.latest();
      const id = await matched(ctx, { expiry: now + 6 * DAY });
      await amd.feed.set(FEED(170), now + 60, now + 60); // last print, then the feed goes quiet
      await time.increase(6 * DAY + 301);
      await expect(binaries.settle(id, 0)).to.emit(binaries, "Voided");
    });

    it("waits while the token reports a corporate action, then voids if nobody can settle", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, bob, usdg, amd } = ctx;
      const id = await matched(ctx);
      await time.increase(DAY + 301);
      await amd.stock.setOraclePaused(true);
      await expect(binaries.settle(id, 0)).to.be.revertedWithCustomError(binaries, "CorporateAction");
      await expect(binaries.voidStale(id)).to.be.revertedWithCustomError(binaries, "TooEarly");
      await time.increase(7 * DAY);
      const [a0, b0] = [await usdg.balanceOf(alice), await usdg.balanceOf(bob)];
      await binaries.voidStale(id);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(100));
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(100));
    });

    it("keeps settling on the feed it opened with after the oracle changes", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, admin, alice, usdg, amd, oracle } = ctx;
      const id = await matched(ctx, { side: ABOVE, strike: USDG(150) });
      const other = await ethers.deployContract("MockAggregator", [8, FEED(100)]);
      await oracle.connect(admin).setFeed(amd.stock, other, 3600);
      await amd.feed.setAnswer(FEED(155));
      await time.increase(DAY + 301);
      const a0 = await usdg.balanceOf(alice);
      await binaries.settle(id, 0);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(198));
    });

    it("books a payout the winner cannot receive and pays it on claim", async function () {
      const ctx = await loadFixture(deskFixture);
      const { binaries, alice, usdg, amd } = ctx;
      const id = await matched(ctx, { side: ABOVE });
      await amd.feed.setAnswer(FEED(155));
      await time.increase(DAY + 301);
      await usdg.setBlocked(alice, true);
      await binaries.settle(id, 0);
      expect(await binaries.owed(alice)).to.equal(USDG(198));
      await usdg.setBlocked(alice, false);
      await binaries.connect(alice).claim();
      expect(await binaries.owed(alice)).to.equal(0n);
      await expect(binaries.connect(alice).claim()).to.be.revertedWithCustomError(binaries, "NothingOwed");
    });
  });

  it("never holds less than it owes", async function () {
    const ctx = await loadFixture(deskFixture);
    const { binaries, alice, bob, carol, usdg, amd } = ctx;
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await open(ctx, [alice, bob, carol][i % 3], { side: i % 2, strike: USDG(148 + i), stake: USDG(10 + i) }));
    for (let i = 0; i < 4; i++) await binaries.connect([bob, carol, alice][i % 3]).join(ids[i]);
    await binaries.connect(bob).cancel(ids[4]);
    await amd.feed.setAnswer(FEED(150.5));
    await time.increase(DAY + 301);
    await binaries.settle(ids[0], 0);
    await binaries.settle(ids[1], 0);
    let due = 0n;
    for (const id of ids) {
      const b = await binaries.get(id);
      if (b.state === Bet.Open) due += b.stake;
      if (b.state === Bet.Matched) due += 2n * b.stake;
    }
    for (const who of [alice, bob, carol]) due += await binaries.owed(who);
    expect(await usdg.balanceOf(binaries)).to.equal(due);
  });

  it("only the admin configures, only the guardian pauses", async function () {
    const ctx = await loadFixture(deskFixture);
    const { binaries, admin, guardian, alice } = ctx;
    await expect(binaries.connect(alice).setFee(0)).to.be.reverted;
    await expect(binaries.connect(admin).setFee(301)).to.be.revertedWithCustomError(binaries, "InvalidConfig");
    await expect(binaries.connect(alice).setMinStake(0)).to.be.reverted;
    const id = await open(ctx, alice);
    await binaries.connect(guardian).pause();
    await expect(open(ctx, alice)).to.be.revertedWithCustomError(binaries, "EnforcedPause");
    await expect(binaries.connect(ctx.bob).join(id)).to.be.revertedWithCustomError(binaries, "EnforcedPause");
    await binaries.connect(alice).cancel(id);
    await binaries.connect(admin).unpause();
    expect(await binaries.tokens()).to.deep.equal([ctx.amd.stock.target]);
    const [price] = await binaries.spot(ctx.amd.stock);
    expect(price).to.equal(USDG(150));
  });
});

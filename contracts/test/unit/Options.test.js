const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { CALL, PUT, State, HOUR, DAY, deskFixture, write, refresh, USDG, EQ } = require("./desk.fixtures");

describe("XStockFiOptions", function () {
  describe("writing", function () {
    it("locks the tokens for a covered call and records the terms", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, amd } = ctx;
      const before = await amd.stock.balanceOf(alice);
      const id = await write(ctx, alice, { size: EQ(2), strike: USDG(170), premium: USDG(9) });
      expect(await amd.stock.balanceOf(alice)).to.equal(before - EQ(2));
      expect(await amd.stock.balanceOf(desk)).to.equal(EQ(2));
      const o = await desk.get(id);
      expect(o.writer).to.equal(alice.address);
      expect(o.state).to.equal(State.Offered);
      expect(o.collateral).to.equal(EQ(2));
      expect(o.feeBps).to.equal(100n);
      expect(o.buyBy).to.equal(o.expiry);
      expect(await desk.idsOf(alice)).to.deep.equal([id]);
      expect(await desk.strikeValue(id)).to.equal(USDG(340));
    });

    it("locks strike x size in USDG for a cash-secured put, rounding up", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, usdg } = ctx;
      // 0.333.. tokens at 150.000001 USDG: 50.0000003.. rounds up to 50.000001
      const size = 333333333333333333n;
      const id = await write(ctx, alice, { kind: PUT, size, strike: USDG("150.000001") });
      const o = await desk.get(id);
      expect(o.collateral).to.equal(50_000001n);
      expect(await usdg.balanceOf(desk)).to.equal(50_000001n);
    });

    it("rejects bad terms", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, amd } = ctx;
      const now = await time.latest();
      const ok = { kind: CALL, size: EQ(1), strike: USDG(160), premium: USDG(5), expiry: now + DAY, buyBy: 0, minPrice: 0, maxPrice: 0 };
      const go = (o) =>
        desk.connect(alice).write(o.kind, amd.stock, o.size, o.strike, o.premium, o.expiry, o.buyBy, o.minPrice, o.maxPrice);
      await expect(go({ ...ok, kind: 2 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, size: 0 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, strike: 0 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, premium: 0 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, expiry: now + 30 * 60 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, expiry: now + 181 * DAY })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, buyBy: now - 1 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, buyBy: ok.expiry + 1 })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(go({ ...ok, minPrice: USDG(200), maxPrice: USDG(100) })).to.be.revertedWithCustomError(desk, "BadTerms");
      // below the 10 USDG minimum notional
      await expect(go({ ...ok, size: EQ("0.05") })).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(
        desk.connect(alice).write(0, ctx.usdg, EQ(1), USDG(1), USDG(1), ok.expiry, 0, 0, 0)
      ).to.be.revertedWithCustomError(desk, "UnknownMarket");
    });

    it("refuses tokens that arrive short", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, admin, alice } = ctx;
      const fee = await ethers.deployContract("MockFeeToken");
      await fee.mint(alice, EQ(10));
      await fee.connect(alice).approve(desk, ethers.MaxUint256);
      await desk.connect(admin).setMarket(fee, true);
      await expect(write(ctx, alice, { token: fee.target })).to.be.revertedWithCustomError(desk, "ShortTransfer");
    });

    it("stops new writes on delisted markets but leaves existing options alone", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, admin, alice, bob, amd } = ctx;
      const id = await write(ctx, alice);
      await desk.connect(admin).setMarket(amd.stock, false);
      await expect(write(ctx, alice)).to.be.revertedWithCustomError(desk, "UnknownMarket");
      await desk.connect(bob).buy(id);
      await desk.connect(bob).exercise(id);
      expect(await desk.tokens()).to.deep.equal([amd.stock.target]);
    });
  });

  describe("buying", function () {
    it("pays the premium to the writer, less the fee to the FeeRouter", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, usdg, feeRouter } = ctx;
      const id = await write(ctx, alice, { premium: USDG(8) });
      const a0 = await usdg.balanceOf(alice);
      await expect(desk.connect(bob).buy(id)).to.emit(desk, "Bought").withArgs(id, bob.address, USDG(8), USDG("0.08"));
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG("7.92"));
      expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("0.08"));
      const o = await desk.get(id);
      expect(o.state).to.equal(State.Active);
      expect(o.holder).to.equal(bob.address);
      expect(await desk.idsOf(bob)).to.deep.equal([id]);
    });

    it("cannot be bought twice, by the writer, or after the buying window", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, carol } = ctx;
      const now = await time.latest();
      const id = await write(ctx, alice, { buyBy: now + 2 * HOUR });
      await expect(desk.connect(alice).buy(id)).to.be.revertedWithCustomError(desk, "NotAllowed");
      const late = await write(ctx, alice, { buyBy: now + 2 * HOUR });
      await desk.connect(bob).buy(id);
      await expect(desk.connect(carol).buy(id)).to.be.revertedWithCustomError(desk, "WrongState");
      await time.increase(2 * HOUR);
      await expect(desk.connect(carol).buy(late)).to.be.revertedWithCustomError(desk, "TooLate");
      await expect(desk.connect(carol).buy(99)).to.be.revertedWithCustomError(desk, "UnknownOption");
    });

    it("can only be bought while the oracle price is inside the writer's band", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, amd } = ctx;
      const id = await write(ctx, alice, { minPrice: USDG(148), maxPrice: USDG(152) });
      await amd.feed.setAnswer(ethers.parseUnits("153", 8));
      await expect(desk.connect(bob).buy(id)).to.be.revertedWithCustomError(desk, "OutsideBand").withArgs(USDG(153));
      await amd.feed.setAnswer(ethers.parseUnits("147.5", 8));
      await expect(desk.connect(bob).buy(id)).to.be.revertedWithCustomError(desk, "OutsideBand");
      await amd.stock.setOraclePaused(true);
      await expect(desk.connect(bob).buy(id)).to.be.revertedWithCustomError(ctx.oracle, "Unpriced");
      await amd.stock.setOraclePaused(false);
      await amd.feed.setAnswer(ethers.parseUnits("151", 8));
      await desk.connect(bob).buy(id);
    });

    it("keeps the fee an option was written with", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, admin, alice, bob, feeRouter, usdg } = ctx;
      const id = await write(ctx, alice, { premium: USDG(10) });
      await desk.connect(admin).setFee(300);
      await expect(desk.connect(admin).setFee(301)).to.be.revertedWithCustomError(desk, "InvalidConfig");
      await desk.connect(bob).buy(id);
      expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("0.1"));
      const id2 = await write(ctx, alice, { premium: USDG(10) });
      await desk.connect(bob).buy(id2);
      expect(await usdg.balanceOf(feeRouter)).to.equal(USDG("0.4"));
    });
  });

  describe("exercise", function () {
    it("call: the holder pays the strike value and receives the tokens", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, usdg, amd } = ctx;
      const id = await write(ctx, alice, { size: EQ(3), strike: USDG(160) });
      await desk.connect(bob).buy(id);
      const [a0, b0, bs0] = [await usdg.balanceOf(alice), await usdg.balanceOf(bob), await amd.stock.balanceOf(bob)];
      await expect(desk.connect(bob).exercise(id)).to.emit(desk, "Exercised").withArgs(id, bob.address);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(480));
      expect(b0 - (await usdg.balanceOf(bob))).to.equal(USDG(480));
      expect((await amd.stock.balanceOf(bob)) - bs0).to.equal(EQ(3));
      expect(await amd.stock.balanceOf(desk)).to.equal(0n);
      expect((await desk.get(id)).state).to.equal(State.Exercised);
    });

    it("put: the holder delivers the tokens and receives the locked USDG", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, usdg, amd } = ctx;
      const id = await write(ctx, alice, { kind: PUT, size: EQ(2), strike: USDG(140) });
      await desk.connect(bob).buy(id);
      const [as0, b0] = [await amd.stock.balanceOf(alice), await usdg.balanceOf(bob)];
      await desk.connect(bob).exercise(id);
      expect((await amd.stock.balanceOf(alice)) - as0).to.equal(EQ(2));
      expect((await usdg.balanceOf(bob)) - b0).to.equal(USDG(280));
      expect(await usdg.balanceOf(desk)).to.equal(0n);
    });

    it("is for the holder only and only before expiry, and works with a stale or missing price", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, carol, amd } = ctx;
      const id = await write(ctx, alice);
      await expect(desk.connect(bob).exercise(id)).to.be.revertedWithCustomError(desk, "WrongState");
      await desk.connect(bob).buy(id);
      await expect(desk.connect(carol).exercise(id)).to.be.revertedWithCustomError(desk, "NotAllowed");
      await amd.stock.setOraclePaused(true);
      await time.increase(2 * DAY); // feeds are long stale now
      await desk.connect(bob).exercise(id);

      const late = await write(ctx, alice, { expiry: (await time.latest()) + 2 * HOUR });
      await desk.connect(bob).buy(late);
      await time.increase(2 * HOUR);
      await expect(desk.connect(bob).exercise(late)).to.be.revertedWithCustomError(desk, "TooLate");
    });

    it("transfers to a new holder who can then exercise", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, carol } = ctx;
      const id = await write(ctx, alice);
      await desk.connect(bob).buy(id);
      await expect(desk.connect(carol).transfer(id, carol)).to.be.revertedWithCustomError(desk, "NotAllowed");
      await expect(desk.connect(bob).transfer(id, ethers.ZeroAddress)).to.be.revertedWithCustomError(desk, "BadTerms");
      await expect(desk.connect(bob).transfer(id, carol)).to.emit(desk, "Transferred").withArgs(id, bob.address, carol.address);
      await expect(desk.connect(bob).exercise(id)).to.be.revertedWithCustomError(desk, "NotAllowed");
      await desk.connect(carol).exercise(id);
      expect(await desk.idsOf(carol)).to.deep.equal([id]);
    });
  });

  describe("expiry and cancelling", function () {
    it("returns collateral to the writer after expiry; anyone may call", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, carol, usdg } = ctx;
      const now = await time.latest();
      const id = await write(ctx, alice, { kind: PUT, size: EQ(1), strike: USDG(100), expiry: now + DAY });
      await desk.connect(bob).buy(id);
      await expect(desk.connect(carol).expire(id)).to.be.revertedWithCustomError(desk, "TooEarly");
      await time.increase(DAY);
      const a0 = await usdg.balanceOf(alice);
      await expect(desk.connect(carol).expire(id)).to.emit(desk, "Expired").withArgs(id);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG(100));
      await expect(desk.connect(carol).expire(id)).to.be.revertedWithCustomError(desk, "WrongState");
    });

    it("an unsold offer is cancelled by its writer at any time, or by anyone after expiry", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, amd } = ctx;
      const now = await time.latest();
      const a = await write(ctx, alice, { expiry: now + DAY });
      const b = await write(ctx, alice, { expiry: now + DAY });
      await expect(desk.connect(bob).cancel(a)).to.be.revertedWithCustomError(desk, "NotAllowed");
      const s0 = await amd.stock.balanceOf(alice);
      await desk.connect(alice).cancel(a);
      expect((await amd.stock.balanceOf(alice)) - s0).to.equal(EQ(1));
      await expect(desk.connect(alice).cancel(a)).to.be.revertedWithCustomError(desk, "WrongState");
      await time.increase(DAY);
      await expect(desk.connect(bob).expire(b)).to.emit(desk, "Cancelled").withArgs(b);
      expect((await desk.get(b)).state).to.equal(State.Cancelled);
    });

    it("pausing stops writes and purchases only", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, admin, guardian, alice, bob } = ctx;
      const sold = await write(ctx, alice);
      const unsold = await write(ctx, alice);
      await desk.connect(bob).buy(sold);
      await expect(desk.connect(alice).pause()).to.be.reverted;
      await desk.connect(guardian).pause();
      await expect(write(ctx, alice)).to.be.revertedWithCustomError(desk, "EnforcedPause");
      await expect(desk.connect(bob).buy(unsold)).to.be.revertedWithCustomError(desk, "EnforcedPause");
      await desk.connect(alice).cancel(unsold);
      await desk.connect(bob).exercise(sold);
      await expect(desk.connect(guardian).unpause()).to.be.reverted;
      await desk.connect(admin).unpause();
      await write(ctx, alice);
    });
  });

  describe("payments that cannot be delivered", function () {
    it("books them as owed instead of blocking the other side", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, usdg, amd } = ctx;
      const id = await write(ctx, alice, { size: EQ(1), strike: USDG(160), premium: USDG(5) });
      await usdg.setBlocked(alice, true);
      await desk.connect(bob).buy(id);
      expect(await desk.owed(usdg, alice)).to.equal(USDG("4.95"));
      await desk.connect(bob).exercise(id); // strike payment to a frozen writer is held too
      expect(await desk.owed(usdg, alice)).to.equal(USDG("164.95"));
      expect(await amd.stock.balanceOf(desk)).to.equal(0n);
      await expect(desk.connect(alice).claim(usdg)).to.be.reverted;
      await usdg.setBlocked(alice, false);
      const a0 = await usdg.balanceOf(alice);
      await desk.connect(alice).claim(usdg);
      expect((await usdg.balanceOf(alice)) - a0).to.equal(USDG("164.95"));
      await expect(desk.connect(alice).claim(usdg)).to.be.revertedWithCustomError(desk, "NothingOwed");
    });

    it("holds everything it is owed: collateral plus booked payments", async function () {
      const ctx = await loadFixture(deskFixture);
      const { desk, alice, bob, carol, usdg, amd } = ctx;
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await write(ctx, i % 2 ? alice : carol, { kind: i % 2 ? PUT : CALL, strike: USDG(150 + i) }));
      await usdg.setBlocked(carol, true);
      for (const id of ids) await desk.connect(bob).buy(id);
      await desk.connect(bob).exercise(ids[0]);
      await desk.connect(bob).exercise(ids[1]);
      let usdgOwed = 0n;
      let stockOwed = 0n;
      for (const id of ids) {
        const o = await desk.get(id);
        if (o.state === State.Active) {
          if (o.kind === 0n) stockOwed += o.collateral;
          else usdgOwed += o.collateral;
        }
      }
      for (const who of [alice, bob, carol]) {
        usdgOwed += await desk.owed(usdg, who);
        stockOwed += await desk.owed(amd.stock, who);
      }
      expect(await usdg.balanceOf(desk)).to.equal(usdgOwed);
      expect(await amd.stock.balanceOf(desk)).to.equal(stockOwed);
    });
  });

  it("lists options in pages", async function () {
    const ctx = await loadFixture(deskFixture);
    const { desk, alice } = ctx;
    for (let i = 0; i < 3; i++) await write(ctx, alice, { strike: USDG(160 + i) });
    expect(await desk.count()).to.equal(3n);
    const page = await desk.list(1, 10);
    expect(page.length).to.equal(2);
    expect(page[1].strike).to.equal(USDG(162));
    expect((await desk.list(5, 9)).length).to.equal(0);
  });

  it("only the admin lists markets and sets limits", async function () {
    const ctx = await loadFixture(deskFixture);
    const { desk, alice, usdg } = ctx;
    await expect(desk.connect(alice).setMarket(usdg, true)).to.be.reverted;
    await expect(desk.connect(alice).setFee(0)).to.be.reverted;
    await expect(desk.connect(alice).setMinNotional(0)).to.be.reverted;
    await expect(desk.connect(ctx.admin).setMarket(usdg, true)).to.be.revertedWithCustomError(desk, "InvalidConfig");
  });
});

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { HOUR, DAY, vaultFixture, USDG, EQ } = require("./desk.fixtures");

describe("XStockFiIncomeVault with payments the desk had to hold", function () {
  it("counts them as the vault's own, so exits keep their share and deposits pay for it", async function () {
    const ctx = await vaultFixture();
    const { vault, desk, alice, bob, carol, keeper, amd, usdg } = ctx;
    await vault.connect(alice).deposit(USDG(10_000));
    await amd.stock.mint(vault, EQ(10)); // stands in for stock assigned by an earlier put
    const expiry = (await time.latest()) + 7 * DAY;
    await vault.connect(keeper).startRound(expiry);
    const id = await desk.count();
    await vault.connect(keeper).sellCall(USDG(160), EQ(10), USDG(10), HOUR);
    await desk.connect(bob).buy(id);

    const aliceShares = await vault.balanceOf(alice);
    await vault.connect(alice).withdraw(aliceShares / 2n); // queued exit
    await vault.connect(carol).deposit(USDG(10_000)); // queued deposit

    await time.increaseTo(expiry + 1);
    await amd.stock.setBlocked(vault, true); // the token refuses transfers to the vault for a while
    await vault.connect(carol).closeRound(); // anyone may close; call expires, stock is booked as owed
    expect(await desk.owed(amd.stock, vault)).to.equal(EQ(10));
    expect(await vault.reservedStock()).to.equal(EQ(5)); // alice's queued half keeps its half of the stock
    expect(await vault.freeStock()).to.equal(EQ(5));
    expect(await vault.depositEpoch()).to.equal(0n); // with stock on hand, only the keeper prices deposits

    // alice's payout cannot reach her while the token blocks the vault: it is booked, not lost
    await vault.connect(alice).claim();
    expect((await vault.owed(alice))[1]).to.equal(EQ(5));

    await amd.stock.setBlocked(vault, false);
    await vault.collectOwed();
    const a0 = await amd.stock.balanceOf(alice);
    await vault.connect(alice).claimOwed();
    expect((await amd.stock.balanceOf(alice)) - a0).to.equal(EQ(5));

    await ctx.amd.feed.setAnswer(ethers.parseUnits("150", 8));
    await ctx.usdgFeed.setAnswer(ethers.parseUnits("1", 8));
    await vault.connect(keeper).processDeposits();
    await vault.connect(carol).claim();
    const [u, s] = await vault.previewWithdraw(await vault.balanceOf(carol));
    const carolValue = u + (s * USDG(150)) / EQ(1);
    expect(carolValue).to.be.lt(USDG(10_000)); // she paid the entry spread on the stock, gained nothing
  });
});

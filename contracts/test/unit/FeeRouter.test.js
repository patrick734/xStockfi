const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, baseFixture } = require("./fixtures");

const DELAY = 48n * 3600n;

describe("XStockFiFeeRouter", function () {
  async function routerFixture() {
    const ctx = await baseFixture();
    const other = await ethers.deployContract("MockERC20", ["Other", "OTH", 18]);
    const [, , , , , , next, next2] = await ethers.getSigners();
    return { ...ctx, other, next, next2 };
  }

  describe("constructor", function () {
    it("stores the owner and destination", async function () {
      const { feeRouter, admin, buyBurn } = await loadFixture(routerFixture);
      expect(await feeRouter.owner()).to.equal(admin.address);
      expect(await feeRouter.buyBurn()).to.equal(await buyBurn.getAddress());
      expect(await feeRouter.pendingBuyBurn()).to.equal(ethers.ZeroAddress);
      expect(await feeRouter.pendingSince()).to.equal(0n);
      expect(await feeRouter.CHANGE_DELAY()).to.equal(DELAY);
    });

    it("rejects a zero destination and a zero owner", async function () {
      const { admin, buyBurn } = await loadFixture(routerFixture);
      const F = await ethers.getContractFactory("XStockFiFeeRouter");
      await expect(F.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidAddress");
      await expect(F.deploy(ethers.ZeroAddress, buyBurn)).to.be.revertedWithCustomError(F, "OwnableInvalidOwner");
    });
  });

  describe("routing", function () {
    it("lets anyone forward the whole balance to BuyBurn", async function () {
      const { feeRouter, usdg, buyBurn, carol } = await loadFixture(routerFixture);
      await usdg.mint(feeRouter, USDG(123));
      expect(await feeRouter.connect(carol).route.staticCall(usdg)).to.equal(USDG(123));
      const before = await usdg.balanceOf(buyBurn);
      await expect(feeRouter.connect(carol).route(usdg))
        .to.emit(feeRouter, "Routed")
        .withArgs(await usdg.getAddress(), await buyBurn.getAddress(), USDG(123));
      expect((await usdg.balanceOf(buyBurn)) - before).to.equal(USDG(123));
      expect(await usdg.balanceOf(feeRouter)).to.equal(0n);
      expect(await feeRouter.totalRouted(usdg)).to.equal(USDG(123));
    });

    it("is a no-op on an empty balance", async function () {
      const { feeRouter, usdg, carol } = await loadFixture(routerFixture);
      expect(await feeRouter.connect(carol).route.staticCall(usdg)).to.equal(0n);
      await expect(feeRouter.connect(carol).route(usdg)).not.to.emit(feeRouter, "Routed");
      expect(await feeRouter.totalRouted(usdg)).to.equal(0n);
    });

    it("accumulates totalRouted per token across calls", async function () {
      const { feeRouter, usdg, other, bob } = await loadFixture(routerFixture);
      await usdg.mint(feeRouter, USDG(10));
      await feeRouter.connect(bob).route(usdg);
      await usdg.mint(feeRouter, USDG(5));
      await feeRouter.connect(bob).route(usdg);
      expect(await feeRouter.totalRouted(usdg)).to.equal(USDG(15));
      expect(await feeRouter.totalRouted(other)).to.equal(0n);
    });

    it("routes many tokens at once, skipping empty ones", async function () {
      const { feeRouter, usdg, other, amd, buyBurn, bob } = await loadFixture(routerFixture);
      await usdg.mint(feeRouter, USDG(7));
      await other.mint(feeRouter, EQ(3));
      const tx = feeRouter.connect(bob).routeMany([usdg, amd.stock, other]);
      await expect(tx)
        .to.emit(feeRouter, "Routed")
        .withArgs(await usdg.getAddress(), await buyBurn.getAddress(), USDG(7));
      await expect(tx)
        .to.emit(feeRouter, "Routed")
        .withArgs(await other.getAddress(), await buyBurn.getAddress(), EQ(3));
      expect(await usdg.balanceOf(feeRouter)).to.equal(0n);
      expect(await other.balanceOf(buyBurn)).to.equal(EQ(3));
      expect(await feeRouter.totalRouted(amd.stock)).to.equal(0n);
      await feeRouter.connect(bob).routeMany([]);
    });

    it("forwards a Vault's harvested protocol share end to end", async function () {
      const ctx = await loadFixture(routerFixture);
      const { feeRouter, usdg, buyBurn, amd, alice, carol } = ctx;
      await usdg.connect(alice).approve(amd.vault, USDG(1_000));
      await amd.vault.connect(alice).deposit(USDG(1_000), alice.address);
      await amd.position.accrueFees(EQ(1), USDG(100));
      await amd.vault.connect(carol).harvest();
      const bpsShare = await amd.vault.protocolShareBps();
      const expectedUsdg = (USDG(100) * bpsShare) / 10_000n;
      expect(await usdg.balanceOf(feeRouter)).to.equal(expectedUsdg);
      const before = await usdg.balanceOf(buyBurn);
      await feeRouter.connect(carol).routeMany([usdg, amd.stock]);
      expect((await usdg.balanceOf(buyBurn)) - before).to.equal(expectedUsdg);
      expect(await amd.stock.balanceOf(buyBurn)).to.equal((EQ(1) * bpsShare) / 10_000n);
    });
  });

  describe("destination change", function () {
    it("only the owner can propose, execute or cancel", async function () {
      const { feeRouter, guardian, carol, next } = await loadFixture(routerFixture);
      for (const s of [guardian, carol]) {
        await expect(feeRouter.connect(s).proposeDestination(next.address))
          .to.be.revertedWithCustomError(feeRouter, "OwnableUnauthorizedAccount")
          .withArgs(s.address);
        await expect(feeRouter.connect(s).executeDestination()).to.be.revertedWithCustomError(
          feeRouter,
          "OwnableUnauthorizedAccount"
        );
        await expect(feeRouter.connect(s).cancelDestination()).to.be.revertedWithCustomError(
          feeRouter,
          "OwnableUnauthorizedAccount"
        );
      }
    });

    it("rejects a zero or unchanged destination", async function () {
      const { feeRouter, admin, buyBurn } = await loadFixture(routerFixture);
      await expect(feeRouter.connect(admin).proposeDestination(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        feeRouter,
        "InvalidAddress"
      );
      await expect(feeRouter.connect(admin).proposeDestination(buyBurn)).to.be.revertedWithCustomError(
        feeRouter,
        "InvalidAddress"
      );
    });

    it("reverts execute and cancel when nothing is pending", async function () {
      const { feeRouter, admin } = await loadFixture(routerFixture);
      await expect(feeRouter.connect(admin).executeDestination()).to.be.revertedWithCustomError(
        feeRouter,
        "NothingPending"
      );
      await expect(feeRouter.connect(admin).cancelDestination()).to.be.revertedWithCustomError(
        feeRouter,
        "NothingPending"
      );
    });

    it("enforces the 48h delay, then redirects future routes", async function () {
      const { feeRouter, admin, usdg, buyBurn, next, carol } = await loadFixture(routerFixture);
      const tx = await feeRouter.connect(admin).proposeDestination(next.address);
      const proposedAt = BigInt(await time.latest());
      await expect(tx).to.emit(feeRouter, "DestinationProposed").withArgs(next.address, proposedAt + DELAY);
      expect(await feeRouter.pendingBuyBurn()).to.equal(next.address);
      expect(await feeRouter.pendingSince()).to.equal(proposedAt);

      // routes keep going to the current destination while the change is pending
      await usdg.mint(feeRouter, USDG(1));
      await feeRouter.connect(carol).route(usdg);
      expect(await usdg.balanceOf(buyBurn)).to.be.gte(USDG(1));
      expect(await usdg.balanceOf(next)).to.equal(0n);

      await time.setNextBlockTimestamp(proposedAt + DELAY - 1n);
      await expect(feeRouter.connect(admin).executeDestination()).to.be.revertedWithCustomError(feeRouter, "NotReady");

      await time.setNextBlockTimestamp(proposedAt + DELAY);
      await expect(feeRouter.connect(admin).executeDestination())
        .to.emit(feeRouter, "DestinationChanged")
        .withArgs(await buyBurn.getAddress(), next.address);
      expect(await feeRouter.buyBurn()).to.equal(next.address);
      expect(await feeRouter.pendingBuyBurn()).to.equal(ethers.ZeroAddress);
      expect(await feeRouter.pendingSince()).to.equal(0n);
      await expect(feeRouter.connect(admin).executeDestination()).to.be.revertedWithCustomError(
        feeRouter,
        "NothingPending"
      );

      await usdg.mint(feeRouter, USDG(2));
      await expect(feeRouter.connect(carol).route(usdg))
        .to.emit(feeRouter, "Routed")
        .withArgs(await usdg.getAddress(), next.address, USDG(2));
      expect(await usdg.balanceOf(next)).to.equal(USDG(2));
    });

    it("restarts the clock when a new destination is proposed", async function () {
      const { feeRouter, admin, next, next2 } = await loadFixture(routerFixture);
      await feeRouter.connect(admin).proposeDestination(next.address);
      await time.increase(DELAY - 10n);
      await feeRouter.connect(admin).proposeDestination(next2.address);
      const second = BigInt(await time.latest());
      await time.increase(20);
      await expect(feeRouter.connect(admin).executeDestination()).to.be.revertedWithCustomError(feeRouter, "NotReady");
      await time.setNextBlockTimestamp(second + DELAY);
      await feeRouter.connect(admin).executeDestination();
      expect(await feeRouter.buyBurn()).to.equal(next2.address);
    });

    it("lets the owner cancel a pending change", async function () {
      const { feeRouter, admin, buyBurn, next } = await loadFixture(routerFixture);
      await feeRouter.connect(admin).proposeDestination(next.address);
      await expect(feeRouter.connect(admin).cancelDestination())
        .to.emit(feeRouter, "DestinationProposalCancelled")
        .withArgs(next.address);
      expect(await feeRouter.pendingBuyBurn()).to.equal(ethers.ZeroAddress);
      expect(await feeRouter.pendingSince()).to.equal(0n);
      await time.increase(DELAY);
      await expect(feeRouter.connect(admin).executeDestination()).to.be.revertedWithCustomError(
        feeRouter,
        "NothingPending"
      );
      expect(await feeRouter.buyBurn()).to.equal(await buyBurn.getAddress());
    });
  });

  describe("ownership (two-step)", function () {
    it("hands control over only once the new owner accepts", async function () {
      const { feeRouter, admin, carol, bob, next } = await loadFixture(routerFixture);
      await feeRouter.connect(admin).transferOwnership(carol.address);
      expect(await feeRouter.owner()).to.equal(admin.address);
      expect(await feeRouter.pendingOwner()).to.equal(carol.address);
      await expect(feeRouter.connect(bob).acceptOwnership())
        .to.be.revertedWithCustomError(feeRouter, "OwnableUnauthorizedAccount")
        .withArgs(bob.address);
      await feeRouter.connect(carol).acceptOwnership();
      expect(await feeRouter.owner()).to.equal(carol.address);
      await expect(feeRouter.connect(admin).proposeDestination(next.address)).to.be.revertedWithCustomError(
        feeRouter,
        "OwnableUnauthorizedAccount"
      );
      await feeRouter.connect(carol).proposeDestination(next.address);
    });
  });
});

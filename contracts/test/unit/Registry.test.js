const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const Kind = { LiquidityVault: 0n, CreditLine: 1n, IncomeVault: 2n };

describe("XStockFiRegistry", function () {
  async function registryFixture() {
    const [owner, other, newOwner, vaultA, vaultB, desk, program] = await ethers.getSigners();
    const registry = await ethers.deployContract("XStockFiRegistry", [owner.address]);
    return { registry, owner, other, newOwner, vaultA, vaultB, desk, program };
  }

  function asPlain(e) {
    return { target: e.target, kind: e.kind, ticker: e.ticker, listed: e.listed };
  }

  it("starts empty with the given owner", async function () {
    const { registry, owner, vaultA } = await loadFixture(registryFixture);
    expect(await registry.owner()).to.equal(owner.address);
    expect(await registry.entries()).to.deep.equal([]);
    expect(await registry.indexPlusOne(vaultA)).to.equal(0n);
  });

  it("rejects a zero owner", async function () {
    const F = await ethers.getContractFactory("XStockFiRegistry");
    await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "OwnableInvalidOwner");
  });

  it("lists Liquidity Vaults, credit lines and Income Vaults in order", async function () {
    const { registry, owner, vaultA, desk, program } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD"))
      .to.emit(registry, "Listed")
      .withArgs(vaultA.address, Kind.LiquidityVault, "AMD");
    await registry.connect(owner).list(desk.address, Kind.CreditLine, "clAMD");
    await registry.connect(owner).list(program.address, Kind.IncomeVault, "TSLA");

    const e = (await registry.entries()).map(asPlain);
    expect(e).to.deep.equal([
      { target: vaultA.address, kind: Kind.LiquidityVault, ticker: "AMD", listed: true },
      { target: desk.address, kind: Kind.CreditLine, ticker: "clAMD", listed: true },
      { target: program.address, kind: Kind.IncomeVault, ticker: "TSLA", listed: true },
    ]);
    expect(await registry.indexPlusOne(vaultA)).to.equal(1n);
    expect(await registry.indexPlusOne(desk)).to.equal(2n);
    expect(await registry.indexPlusOne(program)).to.equal(3n);
  });

  it("rejects listing the same target twice", async function () {
    const { registry, owner, vaultA } = await loadFixture(registryFixture);
    await registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD");
    await expect(registry.connect(owner).list(vaultA.address, Kind.CreditLine, "OTHER")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("delists by flag, keeping the entry and its index", async function () {
    const { registry, owner, vaultA, vaultB } = await loadFixture(registryFixture);
    await registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD");
    await registry.connect(owner).list(vaultB.address, Kind.LiquidityVault, "TSLA");
    await expect(registry.connect(owner).delist(vaultA.address)).to.emit(registry, "Delisted").withArgs(vaultA.address);
    const e = (await registry.entries()).map(asPlain);
    expect(e[0]).to.deep.equal({ target: vaultA.address, kind: Kind.LiquidityVault, ticker: "AMD", listed: false });
    expect(e[1].listed).to.equal(true);
    expect(await registry.indexPlusOne(vaultA)).to.equal(1n);
    // a delisted target keeps its slot, so it cannot be listed again
    await expect(registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("rejects delisting an unknown target", async function () {
    const { registry, owner, vaultA } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).delist(vaultA.address)).to.be.revertedWithCustomError(registry, "Unknown");
  });

  it("restricts list and delist to the owner", async function () {
    const { registry, owner, other, vaultA } = await loadFixture(registryFixture);
    await expect(registry.connect(other).list(vaultA.address, Kind.LiquidityVault, "AMD"))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
    await registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD");
    await expect(registry.connect(other).delist(vaultA.address))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
  });

  it("transfers ownership in two steps", async function () {
    const { registry, owner, other, newOwner, vaultA } = await loadFixture(registryFixture);
    await registry.connect(owner).transferOwnership(newOwner.address);
    expect(await registry.pendingOwner()).to.equal(newOwner.address);
    await expect(registry.connect(other).acceptOwnership()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    // still the old owner until accepted
    await registry.connect(owner).list(vaultA.address, Kind.LiquidityVault, "AMD");
    await registry.connect(newOwner).acceptOwnership();
    expect(await registry.owner()).to.equal(newOwner.address);
    await expect(registry.connect(owner).delist(vaultA.address)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    await registry.connect(newOwner).delist(vaultA.address);
  });
});

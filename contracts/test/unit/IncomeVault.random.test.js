// Random rounds against the Income Vault: users deposit, exit, cancel and claim at random while traders buy and
// exercise its options at random prices. After every step the vault must hold what it owes, and at the end every
// holder must be able to leave with the vault emptied down to rounding dust.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { State, HOUR, DAY, vaultFixture, refresh, USDG, EQ, FEED, rate } = require("./desk.fixtures");

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function checkSolvent(ctx) {
  const { vault, usdg, amd } = ctx;
  const [u, s] = [await usdg.balanceOf(vault), await amd.stock.balanceOf(vault)];
  expect(u).to.be.gte((await vault.pendingUsdg()) + (await vault.reservedUsdg()));
  expect(s).to.be.gte(await vault.reservedStock());
  expect(await vault.balanceOf(vault)).to.be.gte((await vault.queuedShares()) + (await vault.unclaimedShares()));
}

for (const seed of [7, 42, 1234]) {
  describe(`XStockFiIncomeVault random rounds (seed ${seed})`, function () {
    it("stays solvent and lets everyone leave", async function () {
      const ctx = await loadFixture(vaultFixture);
      const { vault, desk, keeper, alice, bob, carol, usdg, amd } = ctx;
      const users = [alice, bob, carol];
      const rand = rng(seed);
      const pick = (a) => a[Math.floor(rand() * a.length)];
      let price = 150;

      await vault.connect(alice).deposit(USDG(5_000));

      for (let r = 0; r < 6; r++) {
        await refresh(ctx, price);
        await vault.connect(keeper).startRound((await time.latest()) + 2 * DAY);
        const spot = price;
        const ids = [];
        const freeStock = await vault.freeStock();
        if (freeStock > 0n) {
          const strike = Math.ceil(spot * 1.05);
          ids.push(await desk.count());
          const size = freeStock / 2n > 0n ? freeStock / 2n : freeStock;
          await vault.connect(keeper).sellCall(USDG(strike), size, USDG(20), 2 * HOUR);
        }
        const freeUsdg = await vault.freeUsdg();
        const value = await vault.roundStartValue();
        const budget = (value * 7n) / 10n < freeUsdg ? (value * 7n) / 10n : freeUsdg;
        const strike = Math.floor(spot * 0.95);
        const size = (budget * 10n ** 18n) / USDG(strike) / 2n;
        if (size > EQ("0.1")) {
          ids.push(await desk.count());
          const collateral = (size * USDG(strike)) / 10n ** 18n;
          await vault.connect(keeper).sellPut(USDG(strike), size, collateral / 100n + 1n, 2 * HOUR);
        }

        for (let step = 0; step < 8; step++) {
          const u = pick(users);
          const roll = rand();
          if (roll < 0.25) await vault.connect(u).deposit(USDG(100 + Math.floor(rand() * 2_000)));
          else if (roll < 0.45) {
            const bal = await vault.balanceOf(u);
            if (bal > 0n) await vault.connect(u).withdraw(bal / 3n + 1n);
          } else if (roll < 0.52) await vault.connect(u).cancelDeposit().catch(() => {});
          else if (roll < 0.58) await vault.connect(u).cancelWithdraw().catch(() => {});
          else if (roll < 0.65) await vault.connect(u).claim();
          await checkSolvent(ctx);
        }

        // traders buy everything, then the price moves and they exercise what pays
        for (const id of ids) await desk.connect(pick(users)).buy(id).catch(() => {});
        price = Math.max(60, Math.round(price * (0.85 + rand() * 0.3)));
        await amd.feed.setAnswer(FEED(price));
        for (const id of ids) {
          const o = await desk.get(id);
          if (o.state !== State.Active) continue;
          const holder = users.find((x) => x.address === o.holder);
          const itm = o.kind === 0n ? USDG(price) > o.strike : USDG(price) < o.strike;
          if (itm) await desk.connect(holder).exercise(id);
        }
        await checkSolvent(ctx);

        await time.increase(2 * DAY);
        await refresh(ctx, price);
        await vault.connect(pick(users)).closeRound();
        await checkSolvent(ctx);

        // between rounds the keeper sometimes sells assigned tokens back to USDG
        const held = await vault.freeStock();
        if (held > 0n && rand() < 0.5) {
          await ctx.swap.setRate(amd.stock, usdg, rate(price, 18, 6));
          await vault.connect(keeper).sellStock(held, "0x");
        }
        await checkSolvent(ctx);
      }

      // everyone claims and leaves between rounds
      for (const u of users) {
        await vault.connect(u).claim();
        await vault.connect(u).cancelDeposit().catch(() => {});
      }
      await refresh(ctx, price);
      await vault.processDeposits().catch(() => {});
      for (const u of users) {
        await vault.connect(u).claim();
        const bal = await vault.balanceOf(u);
        if (bal > 0n) await vault.connect(u).withdraw(bal);
      }
      const exercised = (await desk.queryFilter(desk.filters.Exercised())).length;
      const bought = (await desk.queryFilter(desk.filters.Bought())).length;
      const queued = (await vault.queryFilter(vault.filters.ExitQueued())).length;
      if (process.env.DEBUG_RANDOM) console.log({ seed, bought, exercised, queued, price });
      expect(bought).to.be.gt(0);
      expect(await vault.totalSupply()).to.be.lte(await vault.unclaimedShares());
      expect(await usdg.balanceOf(vault)).to.be.lte(10n);
      expect(await amd.stock.balanceOf(vault)).to.be.lte(10n ** 6n);
    });
  });
}

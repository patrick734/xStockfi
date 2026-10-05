// Offline unit tests for the keeper's pure logic: option pricing and schedules, the Chainlink round search, tick
// math, rebalance planning, routes and revert decoding.
// Run with `npm test`. Needs no node or RPC, only contracts/artifacts for the ABIs.
const assert = require("assert/strict");
const { ethers } = require("ethers");
const v4 = require("../src/v4math");
const { planRebalance } = require("../src/plan");
const { buildRoute } = require("../src/routes");
const { reason } = require("../src/chain");
const abis = require("../src/abis");
const pricing = require("../src/pricing");
const { roundHint } = require("../src/rounds");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const CFG = { halfWidthTicks: 1200, edgeThresholdPct: 15, minSwapUsdg: "5", minIdleUsdg: "10", maxIdlePct: 25 };
const E18 = 10n ** 18n;
const usdg = (n) => ethers.parseUnits(String(n), 6);

// Pool state for a Stock Token at `price` USDG, as the v4 pool would store it.
function pool(price, stockIsToken0) {
  const raw = stockIsToken0 ? (price * 1e6) / 1e18 : 1e18 / (price * 1e6);
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
  return { sqrtPriceX96, poolTick: v4.tickFromPrice(raw), fair: usdg(price) };
}

function base(price, stockIsToken0, over = {}) {
  const pl = pool(price, stockIsToken0);
  return {
    cfg: CFG,
    fair: pl.fair,
    stockUnit: E18,
    stockIsToken0,
    spacing: 60,
    sqrtPriceX96: pl.sqrtPriceX96,
    poolTick: pl.poolTick,
    liquidity: 0n,
    lower: 0,
    upper: 0,
    heldS: 0n,
    heldU: 0n,
    idleS: 0n,
    idleU: 0n,
    ...over,
  };
}

const near = (a, b, tolBps) => {
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= b * BigInt(tolBps);
};

console.log("pricing");
test("normal CDF matches known values", () => {
  assert.ok(Math.abs(pricing.normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(pricing.normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(pricing.normCdf(-1) - 0.158655) < 1e-5);
});
test("Black-Scholes satisfies put-call parity with no rate", () => {
  const c = pricing.blackScholes("call", 100, 105, 7 / 365, 0.5);
  const p = pricing.blackScholes("put", 100, 105, 7 / 365, 0.5);
  assert.ok(Math.abs(c - p - (100 - 105)) < 1e-9);
  assert.ok(c > 0 && p > 5);
});
test("an at-the-money week at 50% vol is worth about 2.8% of spot", () => {
  const v = pricing.blackScholes("call", 100, 100, 7 / 365, 0.5);
  assert.ok(v > 2.6 && v < 2.9, String(v));
});
test("strikes sit out of the money on the listed grid and respect the vault minimum", () => {
  assert.equal(pricing.chooseStrike("put", 378.34, 5, 300), 355);
  assert.equal(pricing.chooseStrike("call", 378.34, 5, 300), 400);
  assert.equal(pricing.chooseStrike("put", 224.41, 5, 300), 212.5);
  // a 2% target is pushed out past the 3% minimum plus cushion
  const put = pricing.chooseStrike("put", 100, 2, 300);
  assert.ok(put <= 100 * (1 - 0.0325));
  assert.equal(pricing.strikeStep(1200), 10);
});
test("premium never goes under the vault floor", () => {
  const p = pricing.premium({ kind: "put", spot: 100, strike: 50, size: 10, years: 7 / 365, vol: 0.3, markupPct: 10, minPremiumBps: 20, exposure: 500 });
  assert.ok(Math.abs(p - (500 * 21) / 10_000) < 1e-9);
  const q = pricing.premium({ kind: "put", spot: 100, strike: 95, size: 10, years: 7 / 365, vol: 0.5, markupPct: 10, minPremiumBps: 20, exposure: 950 });
  assert.ok(q > 950 * 0.002);
});
test("next expiry is the coming Friday 20:00 UTC, at least a day away", () => {
  const mon = Date.UTC(2026, 9, 5, 15) / 1000; // Monday 5 Oct 2026, 15:00 UTC
  assert.equal(pricing.nextExpiry(mon), Date.UTC(2026, 9, 9, 20) / 1000);
  const thuLate = Date.UTC(2026, 9, 8, 21) / 1000; // under a day before Friday 20:00
  assert.equal(pricing.nextExpiry(thuLate), Date.UTC(2026, 9, 16, 20) / 1000);
  const friAfter = Date.UTC(2026, 9, 9, 20, 30) / 1000;
  assert.equal(pricing.nextExpiry(friAfter), Date.UTC(2026, 9, 16, 20) / 1000);
});
test("market hours: weekdays 14:00-20:00 UTC only", () => {
  assert.equal(pricing.marketOpen(Date.UTC(2026, 9, 5, 15) / 1000), true);
  assert.equal(pricing.marketOpen(Date.UTC(2026, 9, 5, 21) / 1000), false);
  assert.equal(pricing.marketOpen(Date.UTC(2026, 9, 10, 15) / 1000), false); // Saturday
});

// A fake feed: phase -> list of updatedAt, round n at index n-1.
function fakeFeed(phases) {
  const ids = Object.keys(phases).map(Number);
  const latestPhase = Math.max(...ids);
  const latestId = (BigInt(latestPhase) << 64n) | BigInt(phases[latestPhase].length);
  const get = (id) => {
    const p = Number(id >> 64n);
    const n = Number(id & ((1n << 64n) - 1n));
    const t = phases[p] && phases[p][n - 1];
    if (!t || n < 1) throw new Error("no round");
    return [id, BigInt(1000 + n), 0n, BigInt(t), id];
  };
  return { latestRoundData: async () => get(latestId), getRoundData: async (id) => get(BigInt(id)), latestId };
}
const id = (p, n) => (BigInt(p) << 64n) | BigInt(n);
const asyncTest = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
};
const roundTests = async () => {
  console.log("rounds");
  const feed = fakeFeed({ 1: [100, 200, 300, 400, 500, 600, 700], 2: [650, 800, 900] });
  await asyncTest("hint 0 when the latest round is already at or before the time", async () => {
    assert.equal(await roundHint(feed, 950), 0n);
  });
  await asyncTest("binary search inside the latest phase", async () => {
    assert.equal(await roundHint(feed, 850), id(2, 2));
    assert.equal(await roundHint(feed, 800), id(2, 2));
    assert.equal(await roundHint(feed, 799), id(2, 1));
  });
  await asyncTest("falls back to an older phase only when the newer one had nothing yet", async () => {
    assert.equal(await roundHint(feed, 649), id(1, 6));
    assert.equal(await roundHint(feed, 450), id(1, 4));
    assert.equal(await roundHint(feed, 100), id(1, 1));
  });
  await asyncTest("null before the first round ever", async () => {
    assert.equal(await roundHint(feed, 50), null);
  });
};

console.log("v4math");
test("tickFromPrice(1) = 0 and sign follows price", () => {
  assert.equal(v4.tickFromPrice(1), 0);
  assert.ok(v4.tickFromPrice(1.01) > 0 && v4.tickFromPrice(0.99) < 0);
});
test("rangeAround snaps outward to the spacing", () => {
  const r = v4.rangeAround(123, 1200, 60);
  assert.ok(r.lower % 60 === 0);
  assert.ok(r.upper % 60 === 0);
  assert.ok(r.lower <= 123 - 1200 && r.upper >= 123 + 1200);
  assert.deepEqual(v4.rangeAround(-123, 1200, 60), { lower: -1380, upper: 1080 });
});
test("range centred on price holds about half its value in each token", () => {
  const r = v4.rangeAround(0, 1200, 60);
  assert.ok(Math.abs(v4.token1ValueShare(1, r.lower, r.upper) - 0.5) < 0.01);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), 60, 120), 0);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), -120, -60), 1);
});

console.log("planRebalance");
for (const stockIsToken0 of [false, true]) {
  const side = stockIsToken0 ? "stock=token0" : "stock=token1";
  test(`${side}: no range + idle USDG -> place range, sell about half the USDG`, () => {
    const p = planRebalance(base(778.25, stockIsToken0, { heldU: usdg(10_000), idleU: usdg(10_000) }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "no active range");
    assert.equal(p.sellUsdg, true);
    assert.ok(near(p.amount, usdg(5_000), 200), `amount ${p.amount}`);
    assert.ok(p.target.lower <= p.status.oracleTick && p.status.oracleTick < p.target.upper);
  });
  test(`${side}: no range + stock only -> sell about half the stock`, () => {
    const heldS = ethers.parseEther("10");
    const p = planRebalance(base(224.41, stockIsToken0, { heldS, idleS: heldS }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.sellUsdg, false);
    assert.ok(near(p.amount, ethers.parseEther("5"), 200), `amount ${p.amount}`);
  });
  test(`${side}: centred range -> nothing to do`, () => {
    const b = base(336.31, stockIsToken0);
    const r = v4.rangeAround(b.poolTick, 1200, 60);
    const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("15") });
    assert.equal(p.action, "none");
  });
  test(`${side}: price moved 20% -> out of range, new range around the oracle`, () => {
    const old = base(100, stockIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(120, stockIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("40") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick out of range");
    assert.ok(p.target.lower <= now.poolTick && now.poolTick < p.target.upper);
  });
  test(`${side}: price moved 10% -> near edge triggers`, () => {
    const old = base(100, stockIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(110, stockIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("50") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick near range edge");
  });
}
test("pool at edge but oracle centred on the current range -> skip, not a pointless rebalance", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, poolTick: r.upper - 10, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldS: ethers.parseEther("50") });
  assert.equal(p.action, "skip");
});
test("large idle balance in an otherwise healthy range -> rebalance to deploy it", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(8000), heldS: ethers.parseEther("20"), idleU: usdg(4000) });
  assert.equal(p.action, "rebalance");
  assert.equal(p.why, "idle balance above maxIdlePct");
});
test("tiny imbalance below minSwapUsdg -> no swap", () => {
  const p = planRebalance(base(100, false, { heldU: usdg(10), heldS: ethers.parseEther("0.1"), idleU: usdg(10), cfg: { ...CFG, minSwapUsdg: "50" } }));
  assert.equal(p.action, "rebalance");
  assert.equal(p.amount, 0n);
});
test("dust with no range -> nothing", () => {
  assert.equal(planRebalance(base(100, false, { heldU: usdg(1), idleU: usdg(1) })).action, "none");
});

console.log("routes");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35";
const XSF = "0x1111111111111111111111111111111111111111";
const ctx = { dep: { usdg: USDG, token: XSF, markets: { META: { token: META } } } };
const decode = (r) => ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], r)[0].map(String);
test("default route for USDG collapses IN/USDG: USDG -> ETH -> XSF", () => {
  const { route, path } = buildRoute(ctx, ["IN", "USDG", "ETH", "XSF"], USDG, XSF);
  assert.deepEqual(path, [ethers.getAddress(USDG), ethers.ZeroAddress, XSF]);
  assert.deepEqual(decode(route), path);
});
test("default route for a Stock Token: META -> USDG -> ETH -> XSF", () => {
  const { path } = buildRoute(ctx, ["IN", "USDG", "ETH", "XSF"], META, XSF);
  assert.deepEqual(path, [ethers.getAddress(META), ethers.getAddress(USDG), ethers.ZeroAddress, XSF]);
});
test('"default" and [] mean the adapter default path (0x)', () => {
  assert.equal(buildRoute(ctx, "default", USDG, XSF).route, "0x");
  assert.equal(buildRoute(ctx, [], USDG, XSF).route, "0x");
});
test("a route that does not end at the token is rejected", () => {
  assert.throws(() => buildRoute(ctx, ["IN", "ETH"], USDG, XSF));
  assert.throws(() => buildRoute(ctx, ["IN", "NOPE", "XSF"], USDG, XSF));
  assert.throws(() => buildRoute({ dep: { usdg: USDG, token: null } }, ["IN", "XSF"], USDG, XSF));
});

console.log("revert decoding");
test("custom errors decode by name, including nested ones", () => {
  const bb = new ethers.Interface(abis.BuyBurn);
  assert.equal(reason({ data: bb.encodeErrorResult("TooSoon", []) }), "TooSoon()");
  const ad = new ethers.Interface(abis.SwapAdapter);
  assert.equal(reason({ error: { data: ad.encodeErrorResult("InvalidRoute", []) } }), "InvalidRoute()");
  const vault = new ethers.Interface(abis.IncomeVault);
  assert.equal(reason({ data: vault.encodeErrorResult("NotSettled", [7]) }), "NotSettled(7)");
  const bin = new ethers.Interface(abis.Binaries);
  assert.equal(reason({ data: bin.encodeErrorResult("BadHint", []) }), "BadHint()");
});

roundTests().then(() => console.log(process.exitCode ? "\nunit tests FAILED" : `\nall ${passed} unit tests passed`));

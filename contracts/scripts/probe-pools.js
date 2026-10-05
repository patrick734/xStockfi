// Reads live Robinhood Chain state: finds the hookless Stock Token / USDG v4 pools and checks every price feed.
// Usage: node scripts/probe-pools.js
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const POOLS_SLOT = 6n;
const FEE_TIERS = [
  [3000, 60],
  [10000, 200],
  [500, 10],
  [100, 1],
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId);
  const pm = new ethers.Contract(
    config.uniswap.poolManager,
    ["function extsload(bytes32) view returns (bytes32)"],
    provider
  );
  const posm = new ethers.Contract(
    config.uniswap.positionManager,
    ["function poolManager() view returns (address)", "function nextTokenId() view returns (uint256)"],
    provider
  );
  console.log("chainId", (await provider.getNetwork()).chainId);
  console.log("positionManager.poolManager()", await posm.poolManager(), "nextTokenId", await posm.nextTokenId());

  const usdg = config.tokens.usdg.address;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const results = {};

  for (const [ticker, t] of Object.entries(config.stockTokens)) {
    const feed = new ethers.Contract(
      t.chainlinkFeed,
      ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function description() view returns (string)"],
      provider
    );
    const [, answer, , updatedAt] = await feed.latestRoundData();
    const oraclePrice = Number(answer) / 1e8;
    const [c0, c1] = BigInt(t.address) < BigInt(usdg) ? [t.address, usdg] : [usdg, t.address];
    const stockIsToken0 = c0.toLowerCase() === t.address.toLowerCase();

    let best = null;
    for (const [fee, spacing] of FEE_TIERS) {
      const key = coder.encode(
        ["address", "address", "uint24", "int24", "address"],
        [c0, c1, fee, spacing, ethers.ZeroAddress]
      );
      const id = ethers.keccak256(key);
      const slot = ethers.keccak256(ethers.concat([id, ethers.toBeHex(POOLS_SLOT, 32)]));
      const data = BigInt(await pm.extsload(slot));
      const sqrtP = data & ((1n << 160n) - 1n);
      if (sqrtP === 0n) continue;
      const liqSlot = ethers.toBeHex(BigInt(slot) + 3n, 32);
      const liquidity = BigInt(await pm.extsload(liqSlot)) & ((1n << 128n) - 1n);
      const raw = Number(sqrtP) / 2 ** 96;
      const price1per0 = raw * raw;
      const usdgPerStock = stockIsToken0 ? (price1per0 * 1e18) / 1e6 : 1e18 / 1e6 / price1per0;
      const offBps = Math.round(((usdgPerStock - oraclePrice) / oraclePrice) * 10_000);
      const entry = { fee, tickSpacing: spacing, poolId: id, spotUsdg: +usdgPerStock.toFixed(4), offBps, liquidity: liquidity.toString() };
      if (!best || liquidity > BigInt(best.liquidity)) best = entry;
    }
    results[ticker] = { oracleUsd: oraclePrice, updatedAt: new Date(Number(updatedAt) * 1000).toISOString(), pool: best };
    console.log(ticker.padEnd(6), "oracle", oraclePrice.toFixed(2), "pool", best ? `${best.fee}/${best.tickSpacing} spot ${best.spotUsdg} off ${best.offBps}bps L=${best.liquidity}` : "none");
  }
  require("fs").writeFileSync(require("path").join(__dirname, "../config/robinhood.pools.json"), JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

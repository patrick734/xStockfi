# xStockFi keeper

A small Node.js bot (ethers v6) that runs the protocol's routine duties, one cycle at a time:

| Duty | Calls | Who may call |
|---|---|---|
| Income Vault rounds: start a round during US market hours, quote puts (and covered calls on assigned stock), withdraw quotes that went stale, close the round at expiry | `startRound`, `sellPut`, `sellCall`, `withdrawOffer`, `closeRound` | keeper (close: anyone) |
| Corporate actions: record when a stock token raises and lowers `oraclePaused` | `Binaries.notePause`, `noteResume` | anyone |
| Settle binaries after expiry, finding the Chainlink round that was current then; refund bets nobody joined | `Binaries.settle`, `cancel` | anyone |
| Hand writers back the collateral of options that expired or never sold | `Options.expire` | anyone |
| Liquidity Vaults: keep the range around the Chainlink price, collect fees | `rebalance`, `harvest` | keeper / anyone |
| Credit lines: claim reserves | `claimReserves` | anyone |
| Forward fees, then buy and burn the token | `FeeRouter.routeMany`, `BuyBurn.buyAndBurn` | anyone / keeper |

Every call is simulated from the keeper address first. A call whose simulation reverts is logged and skipped, so one
failing vault or bet never stops the rest of the cycle.

## Running

The keeper reads ABIs from `contracts/artifacts` (run `npx hardhat compile` there first) and addresses from
`contracts/deployments/<KEEPER_NETWORK>.json`.

```bash
node src/index.js --once                                   # dry run: simulates, sends nothing
DRY_RUN=0 KEEPER_PRIVATE_KEY=... node src/index.js         # live, looping
```

**Recommended:** GitHub Actions (`.github/workflows/keeper.yml`). The key lives only in the repository secret
`KEEPER_PRIVATE_KEY`, created by `node tools/wallet.js keeper-secret patrick734/xStockfi`, which prints the address and
never the key. The workflow runs a cycle about every 15 minutes and stays in dry-run mode until the repository variable
`KEEPER_LIVE` is `1`.

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | Required when `DRY_RUN=0`. Read from the environment only, never logged. |
| `DRY_RUN` | dry run | Only `DRY_RUN=0` sends transactions. |
| `RPC_URL` | public Robinhood RPC | JSON-RPC endpoint. |
| `KEEPER_NETWORK` | `robinhood` | Picks the deployment file. |
| `KEEPER_CONFIG` | none | JSON file merged over `config.json`. |
| `KEEPER_STATE_FILE` | none | Keeps harvest times and scan positions between one-shot runs. |
| `LOG_JSON`, `LOG_LEVEL` | off, `info` | Log format and verbosity. |

## Income Vault quotes (`config.json` → `incomeVaults`)

| Key | Default | Meaning |
|---|---|---|
| `marketHoursOnly` | true | Start rounds and quote only on weekdays 14:00 to 20:00 UTC, when the stock feeds are live. |
| `expiryWeekday`, `expiryHourUtc` | 5, 20 | Rounds end on Friday 20:00 UTC, at least the vault's `minRound` away. |
| `putOtmPct`, `callOtmPct` | 5, 5 | Strike distance from Chainlink, snapped to a listed-options grid, never inside the vault's own minimum. |
| `volatility` | per ticker | Annual volatility for the Black-Scholes premium. |
| `markupPct` | 10 | Added on top of the model price. The vault's `minPremiumBps` is the floor. |
| `putSizeFraction` | 0.95 | Share of the free commitment room each put uses. |
| `buyWindowSeconds` | 14400 | How long each quote can be bought (capped by the vault's `maxBuyWindow`). Stale quotes are withdrawn and requoted. |
| `stopQuotingHoursBeforeExpiry` | 24 | No new quotes in the last day of a round. |
| `sellAssignedStock` | false | Between rounds, sell stock received from an exercised put back to USDG (within `maxSwapLossBps`) instead of writing calls on it. |

The rest of `config.json` covers Liquidity Vault rebalancing (`rebalance`, `harvest`), binaries and options upkeep
(`binaries`, `options`, with `maxPerCycle` caps), credit lines and buy-and-burn (`buyBurn.defaultRoute` is
`["IN","USDG","ETH","XSF"]`: the fee token, USDG, native ETH, then the token's Pons pool).

Until the token's Pons pool is registered on the swap adapter (`./govern.sh register-pool`, after graduation), buy-and-burn
quotes revert and fees simply wait in BuyBurn.

## Tests

```bash
npm test                                         # offline: pricing, schedules, round search, tick math, routes
```

End to end against a local node (port 8547):

```bash
cd ../contracts && npx hardhat node --port 8547                       # terminal 1
npx hardhat run scripts/deploy.js --network keeper                    # terminal 2
cd ../keeper && npm run smoke
```

The smoke test runs a dry cycle (asserts nothing was sent), a live cycle mid-round (quotes go up), a cycle after expiry
(binaries settle, unjoined bets refund, rounds close, fees bought and burned), a cycle that opens and quotes new rounds,
and one after the desk's own options expire (collateral returned). It only runs on chain id 31337.

## Safety

- Nothing is sent unless `DRY_RUN=0`.
- The keeper key holds only `KEEPER_ROLE` plus gas. The contracts bound what it can do: strikes, premiums, commitment and
  quote windows on the Income Vaults; registered pools and swap-loss limits on rebalances; per-run caps and a minimum
  interval on buy-and-burn. The guardian can pause the vaults and halt buy-and-burn.
- Run one live keeper per key; nonces are managed locally.

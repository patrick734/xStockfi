# xStockFi

Options on Robinhood Stock Tokens, settled on Robinhood Chain (chain id 4663) in USDG.

- **XStockFiOptions**: peer-to-peer covered calls and cash-secured puts. Writers lock the full collateral; buyers pay the
  premium and can exercise until expiry. Physically settled, so no price feed decides who gets paid.
- **XStockFiBinaries**: two traders stake the same amount on opposite sides of a strike; the winner takes both stakes on
  the Chainlink round that was current at expiry. No house and no pool.
- **XStockFiIncomeVault**: deposit USDG; the vault runs the wheel on one stock through the options desk in weekly rounds
  (cash-secured puts below the market, covered calls on assigned stock) inside limits written into the contract.
- **XStockFiLiquidityVault** and **XStockFiCreditDesk** (based on the MIT-licensed Stonkwell): managed Uniswap v4
  liquidity in one stock's pool, valued at Chainlink, and an isolated lending market against its shares.
- **XStockFiOracle**, **XStockFiFeeRouter**, **XStockFiBuyBurn**, **XStockFiSwapAdapter**, **XStockFiRegistry** and
  **XStockFiTimelock** (48 hours) around them. Every fee ends up buying and burning the xStockFi token.

| Folder | Contents |
|---|---|
| `contracts/` | Hardhat project: the contracts, their tests and the deploy, verify and governance scripts |
| `keeper/` | The keeper bot: Income Vault rounds and quotes, binaries settlement, expired collateral, vault upkeep, buy and burn |
| `web/` | Next.js site (static export): options desk, binaries, vaults, borrowing, docs |
| `tools/` | Wallet tools: encrypted keystores, the keeper key straight into a GitHub secret |

## Tests

```bash
cd contracts && npm install && npx hardhat test
cd ../keeper && npm install && npm test
```

The keeper also has an end-to-end smoke test against a local node; see `keeper/README.md`.

## Running the site locally

```bash
cd contracts && npx hardhat node                                  # terminal 1
npx hardhat run scripts/deploy.js --network localhost && npm run export-abis
cd ../web && npm install && NEXT_PUBLIC_ENABLE_LOCAL=1 npm run dev  # seeded local demo
```

Not independently audited. Nothing here is investment advice.

import type { Metadata } from "next";
import { catalog } from "@/generated/catalog";
import { DEPLOYMENT, addressUrl } from "@/lib/deployment";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS = [
  ["overview", "Overview"],
  ["options", "Options desk"],
  ["binaries", "Binaries"],
  ["income", "Income Vaults"],
  ["liquidity", "Liquidity Vaults"],
  ["credit", "Credit lines"],
  ["fees", "Fees"],
  ["prices", "Prices and Chainlink"],
  ["governance", "Governance and roles"],
  ["risks", "Risks"],
  ["contracts", "Contracts"],
] as const;

function contracts(): [string, string][] {
  const d = DEPLOYMENT;
  if (!d) return [];
  const rows: [string, string][] = [
    ["XStockFiOptions", d.options],
    ["XStockFiBinaries", d.binaries],
    ["XStockFiOracle", d.oracle],
    ["XStockFiFeeRouter", d.feeRouter],
    ["XStockFiBuyBurn", d.buyBurn],
    ["XStockFiSwapAdapter", d.swapAdapter],
    ["XStockFiRegistry", d.registry],
    ["XStockFiTimelock", d.timelock],
  ];
  for (const [t, v] of Object.entries(d.incomeVaults)) rows.push([`XStockFiIncomeVault (${t})`, v.vault]);
  for (const [t, v] of Object.entries(d.liquidityVaults)) {
    rows.push([`XStockFiLiquidityVault (${t})`, v.vault]);
    rows.push([`XStockFiPosition (${t})`, v.position]);
  }
  for (const [t, a] of Object.entries(d.creditLines)) rows.push([`XStockFiCreditDesk (${t})`, a]);
  if (d.token) rows.push([`Token${d.tokenSymbol ? ` ($${d.tokenSymbol})` : ""}`, d.token]);
  return rows;
}

export default function Docs() {
  const rows = contracts();
  const markets = Object.keys(DEPLOYMENT?.markets ?? {}).length ? Object.keys(DEPLOYMENT!.markets) : catalog.launch.markets;
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Docs</p>
          <h1>How xStockFi works</h1>
        </div>
      </div>
      <div className="docs">
        <nav aria-label="Sections">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <article className="prose">
          <h2 id="overview">Overview</h2>
          <p>
            xStockFi is a set of contracts on Robinhood Chain (chain id 4663) for trading and earning on Robinhood Stock Tokens with USDG.
            There are five parts: a peer-to-peer options desk, peer-to-peer binaries, Income Vaults that sell options, Liquidity Vaults
            that provide Uniswap v4 liquidity, and credit lines that lend against Liquidity Vault shares. Markets at launch: {markets.join(", ")}.
          </p>
          <p>
            Every position is fully funded on-chain. There is no order book run by a company, no account and no custody: the contracts
            hold collateral and move it according to rules anyone can read.
          </p>

          <h2 id="options">Options desk</h2>
          <p>
            <code>XStockFiOptions</code> lists covered calls and cash-secured puts written by anyone. A strike is the USDG price for one
            whole Stock Token.
          </p>
          <ul>
            <li>
              <b>Write.</b> Choose call or put, the number of shares, the strike, the total premium and the expiry (1 hour to 180 days). A
              call locks the shares; a put locks strike × shares in USDG, rounded up. The strike value has to be at least the desk&apos;s
              minimum (10 USDG at launch).
            </li>
            <li>
              <b>Protect the quote.</b> Optionally limit how long the offer can be bought, and the Chainlink price range it can be bought
              in. Outside that range the buy reverts, so nobody can pick off a stale premium.
            </li>
            <li>
              <b>Buy.</b> The buyer pays the premium. The writer receives it at once, less the protocol fee that was in force when the
              option was written.
            </li>
            <li>
              <b>Exercise.</b> Any time before expiry. A call holder pays the strike value in USDG and receives the shares; a put holder
              delivers the shares and receives the locked USDG. No price feed is involved.
            </li>
            <li>
              <b>Expire.</b> After expiry anyone can return the collateral of an unexercised option, or of an unsold offer, to its writer.
              The keeper does this automatically. Writers can cancel unsold offers at any time.
            </li>
          </ul>
          <p>
            A payment that a token refuses to deliver (for example to a frozen address) is held in the contract for its owner to claim,
            so it can never block the other side.
          </p>

          <h2 id="binaries">Binaries</h2>
          <p>
            <code>XStockFiBinaries</code> matches two traders on opposite sides of a strike, in USD with 6 decimals. The maker opens with
            a side (above or below), a strike, a stake and an expiry (15 minutes to 30 days). Anyone can take the other side with the same
            stake until the join deadline, which is at most halfway to expiry. The maker can cancel an unmatched bet at any time, and
            anyone can refund it after the deadline.
          </p>
          <p>
            Settlement uses the Chainlink round that was current at expiry; the contract checks that no later round existed by then, also
            across aggregator changes. The feed is copied into the bet when it opens, so later oracle changes cannot affect it. Settlement
            opens five minutes after expiry. The winner receives both stakes less the fee. Both stakes are refunded with no fee if the price
            equals the strike, if the last update before expiry is more than four days old, if expiry fell inside a recorded corporate
            action on the token, or if nobody has settled seven days after expiry.
          </p>

          <h2 id="income">Income Vaults</h2>
          <p>
            <code>XStockFiIncomeVault</code> runs the wheel on one stock through the options desk, in rounds that each end on one
            expiry (weekly, Friday 20:00 UTC, by default).
          </p>
          <ul>
            <li>Holding USDG, it sells cash-secured puts below the market. If a put is exercised it receives the shares.</li>
            <li>Holding shares, it sells covered calls above the market, or the keeper sells the shares back to USDG between rounds.</li>
            <li>Premiums are paid to the vault the moment an option is bought, and stay in the vault for its holders.</li>
          </ul>
          <p>Limits written into the contract, which the keeper cannot exceed:</p>
          <table>
            <tbody>
              <tr>
                <th>Strike distance</th>
                <td>At least 3% out of the money against Chainlink when quoted (hard floor 0.5%).</td>
              </tr>
              <tr>
                <th>Premium floor</th>
                <td>At least 0.2% of the collateral (hard floor 0.05%).</td>
              </tr>
              <tr>
                <th>Commitment</th>
                <td>At most 80% of the round&apos;s starting value in options at once (hard cap 90%).</td>
              </tr>
              <tr>
                <th>Quote protection</th>
                <td>Each offer is buyable for at most 6 hours, and only while Chainlink stays within 1% of the quoted price.</td>
              </tr>
              <tr>
                <th>Round length</th>
                <td>1 to 14 days. At most 20 options per round.</td>
              </tr>
              <tr>
                <th>Selling shares</th>
                <td>Between rounds only, at no worse than 1% under Chainlink.</td>
              </tr>
            </tbody>
          </table>
          <h3>Deposits and exits</h3>
          <p>
            Exits are always your share of what the vault holds: USDG, plus shares of the stock if a put was exercised. That needs no price,
            so exits always work. Between rounds they pay at once; during a round they are queued and paid at the close. Once a round has
            expired, anyone can close it.
          </p>
          <p>
            Deposits mint shares at once between rounds while the vault holds only USDG. Otherwise they are queued: priced at the close
            when the vault holds only USDG, or by the keeper when it holds shares, which are then marked up by 1% so a lagging feed
            cannot be used to buy in cheaply. A queued deposit can be cancelled until its round expires. Queued deposits never share in
            premiums earned before they joined.
          </p>

          <h2 id="liquidity">Liquidity Vaults</h2>
          <p>
            <code>XStockFiLiquidityVault</code> is an ERC-4626 vault in USDG over one stock&apos;s hookless Uniswap v4 pool. The keeper keeps
            a single concentrated range around the Chainlink price. Holdings are valued at Chainlink, never at pool spot, so a swap in the
            same block cannot move the share price. Deposits and rebalances revert if the pool is more than 2% away from Chainlink.
          </p>
          <p>
            Swap fees are collected on every deposit, exit and harvest: 70% compounds into the share price and 30% goes to the FeeRouter.
            Exits in USDG sell the stock part with at most 1% slippage, which the exiting holder bears. <code>redeemInKind</code> pays your
            share of the stock and USDG with no swap and no price check, and works while paused or when markets are closed. Each vault
            has a deposit cap.
          </p>

          <h2 id="credit">Credit lines</h2>
          <p>
            <code>XStockFiCreditDesk</code> is an isolated lending market per Liquidity Vault. Lenders supply USDG and hold ERC-4626 lender
            shares. Borrowers pledge vault shares and borrow USDG at a variable rate from a kinked model. At launch: 40% max LTV,
            liquidation at 55%, a 6% liquidation bonus, a 50% close factor, and at most 30% of a vault&apos;s shares pledged in total.
            Borrowing and liquidation need a fresh price; repaying never does. Any bad debt is written off inside that market only. 10% of
            interest goes to the FeeRouter.
          </p>

          <h2 id="fees">Fees</h2>
          <table>
            <tbody>
              <tr>
                <th>Options</th>
                <td>1% of the premium, taken when the option is bought (adjustable up to 3% by governance; each option keeps its fee).</td>
              </tr>
              <tr>
                <th>Binaries</th>
                <td>1% of the pot of a settled bet (up to 3%). No fee on refunds.</td>
              </tr>
              <tr>
                <th>Liquidity Vaults</th>
                <td>30% of swap fees (at most 30%).</td>
              </tr>
              <tr>
                <th>Credit lines</th>
                <td>10% of interest as reserves (at most 50%).</td>
              </tr>
              <tr>
                <th>Income Vaults</th>
                <td>None of their own; their options pay the desk fee like any other.</td>
              </tr>
            </tbody>
          </table>
          <p>
            Every fee goes to <code>XStockFiFeeRouter</code>, which anyone can call to forward it to <code>XStockFiBuyBurn</code>. BuyBurn
            can only spend what it holds on the xStockFi token, and burns every token it buys. It has no withdrawal function. Runs are
            capped per token and spaced at least an hour apart. Changing the FeeRouter&apos;s destination takes an extra 48 hours on top of
            the timelock.
          </p>

          <h2 id="prices">Prices and Chainlink</h2>
          <p>
            <code>XStockFiOracle</code> reads Robinhood Chain&apos;s Chainlink feeds for each stock and converts them through the USDG / USD
            feed, so a USDG depeg is priced in. A price counts only if it is positive and updated within 26 hours (the feeds beat every
            24 hours and pause on weekends and holidays). It is refused while the stock token reports a corporate action
            (<code>oraclePaused</code>) and, once Chainlink publishes one for this chain, while the sequencer is down. The feeds include
            each token&apos;s split multiplier, so strikes stay meaningful across splits.
          </p>
          <p>Calls and puts never read a price to settle. Binaries read the round at expiry. Vaults read prices to value shares.</p>

          <h2 id="governance">Governance and roles</h2>
          <table>
            <tbody>
              <tr>
                <th>Timelock (48 hours)</th>
                <td>
                  Owns every contract&apos;s settings: listing markets and feeds, fees within their caps, vault limits, caps, unpausing. Every
                  change is scheduled in public first.
                </td>
              </tr>
              <tr>
                <th>Guardian</th>
                <td>Can pause new writes, buys, bets, deposits and rounds, lower caps and halt BuyBurn. Cannot unpause, raise anything or move funds.</td>
              </tr>
              <tr>
                <th>Keeper</th>
                <td>
                  A bot. Starts Income Vault rounds and quotes within the limits above, rebalances Liquidity Vaults within their swap-loss and
                  pool-deviation limits, settles binaries, returns expired collateral and runs BuyBurn within its caps.
                </td>
              </tr>
              <tr>
                <th>Anyone</th>
                <td>Can expire options, settle and refund binaries, close expired rounds, harvest vaults, route fees and burn held tokens.</td>
              </tr>
            </tbody>
          </table>
          <p>No contract can be upgraded, and none has a function that lets an admin take user funds.</p>

          <h2 id="risks">Risks</h2>
          <ul>
            <li>
              <b>Market risk.</b> A written put can be exercised far below the strike; a written call caps your upside. Bought options and
              binary stakes can expire worthless.
            </li>
            <li>
              <b>Income Vault risk.</b> The vault is short options. A sharp fall can leave it holding shares bought above the market, and
              exits are then paid partly in those shares.
            </li>
            <li>
              <b>Oracle risk.</b> Settlement of binaries and the value of vault shares depend on Chainlink. Feeds pause when markets are
              closed and prices can gap at the open.
            </li>
            <li>
              <b>Liquidity and borrowing risk.</b> Liquidity Vaults hold a concentrated range and carry impermanent loss. Borrowers can be
              liquidated when prices gap.
            </li>
            <li>
              <b>Smart contract risk.</b> The contracts are tested but not independently audited. Use amounts you can afford to lose.
            </li>
            <li>
              <b>Token risk.</b> Stock Tokens and USDG are issued by third parties that can freeze addresses or pause transfers.
            </li>
          </ul>

          <h2 id="contracts">Contracts</h2>
          {rows.length ? (
            <table>
              <tbody>
                {rows.map(([name, a]) => (
                  <tr key={a + name}>
                    <th>{name}</th>
                    <td>
                      <a href={addressUrl(a)} target="_blank" rel="noopener">
                        {a}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>The addresses appear here as soon as the contracts are deployed.</p>
          )}
          <p>All source code is MIT-licensed and verified on the Robinhood Chain explorer.</p>
        </article>
      </div>
    </div>
  );
}

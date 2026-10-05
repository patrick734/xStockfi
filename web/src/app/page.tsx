import Link from "next/link";
import { Stats, Tape, Ticket, TokenPanel } from "@/components/Home";

const icons = {
  call: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </svg>
  ),
  binary: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M5 8l3-3 3 3" />
      <path d="M13 16l3 3 3-3" />
    </svg>
  ),
  income: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v8M9.5 10.5c0-1.2 1.1-2 2.5-2s2.5.8 2.5 2-1.1 1.6-2.5 1.6-2.5.6-2.5 1.8 1.1 2 2.5 2 2.5-.8 2.5-2" />
    </svg>
  ),
  pool: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 15c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <path d="M3 19c3 0 3-2 6-2s3 2 6 2 3-2 6-2" />
      <path d="M8 9l4-5 4 5" />
    </svg>
  ),
  credit: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 15h4" />
    </svg>
  ),
};

const FAQ: [string, string][] = [
  [
    "What exactly is an option here?",
    "A contract between two wallets. The writer locks collateral and sets a strike, an expiry and a premium. Whoever buys it pays the premium and can exercise until expiry: a call buys the writer's Stock Tokens at the strike, a put sells Stock Tokens to the writer at the strike. If it is never exercised, the writer gets the collateral back at expiry.",
  ],
  [
    "Who sets the prices?",
    "Writers do. Anyone can write an option at any premium; the Income Vaults quote theirs from a pricing model and refresh them as the market moves. Calls and puts settle physically, so no price feed decides who gets paid. Chainlink is used to value vaults, settle binaries and, if a writer asks for it, to stop a quote from being bought after the market has moved.",
  ],
  [
    "Can a writer fail to pay?",
    "No. Collateral is locked before an option can be sold: the full number of shares for a call, the full strike value in USDG for a put. Exercising moves that collateral directly.",
  ],
  [
    "How do binaries settle?",
    "On the Chainlink round that was current at expiry. Anyone can settle once the expiry has passed, and the keeper does it automatically. A price exactly on the strike, a price older than four days at expiry, or a corporate action at expiry refunds both sides with no fee.",
  ],
  [
    "Can I always get my money out of a vault?",
    "Yes. Income Vault exits are paid as your share of what the vault holds and need no price: at once between rounds, at the close during a round, and anyone can close a round once it expires. Liquidity Vaults pay in USDG, or in kind (the stock plus USDG) with no price check at all, even while paused.",
  ],
  [
    "Who controls the contracts?",
    "Settings sit behind a 48-hour timelock, so every change is public two days before it takes effect. A guardian can only pause new activity and lower caps; it cannot unpause, raise limits or move funds, and exits never pause. The keeper is a bot that runs vault rounds and rebalances inside limits written into the contracts.",
  ],
  [
    "Do I own the stock?",
    "Robinhood Stock Tokens track listed shares, and the contracts move the tokens themselves. Holding a token is not holding the share: no votes, and corporate actions are applied by the token's issuer.",
  ],
];

export default function Home() {
  return (
    <>
      <div className="wrap">
        <section className="hero">
          <div>
            <p className="eyebrow">Robinhood Chain · Stock Tokens</p>
            <h1>
              Options on tokenized stocks.
              <br />
              <span className="grad" style={{ whiteSpace: "nowrap" }}>Settled on&#8209;chain.</span>
            </h1>
            <p className="lead">
              Buy and write covered calls and cash-secured puts on TSLA, NVDA, AAPL and more. Bet above or below a strike against
              another trader. Or let a vault sell options for you and collect the premiums in USDG.
            </p>
            <div className="row">
              <Link className="btn primary" href="/trade/">
                Open the desk
              </Link>
              <Link className="btn ghost" href="/vaults/">
                Earn with vaults
              </Link>
            </div>
          </div>
          <Ticket />
        </section>
      </div>
      <Tape />
      <div className="wrap">
        <Stats />

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">Products</p>
            <h2>Five ways to use a Stock Token.</h2>
            <p>Everything is fully collateralized and runs from your wallet. Nothing to sign up for.</p>
          </div>
          <div className="prod">
            <Link className="card big" href="/trade/">
              <span className="icon">{icons.call}</span>
              <h3>Options desk</h3>
              <p>
                Covered calls and cash-secured puts. Writers lock the shares or the USDG and set their price; buyers pay the premium and
                can exercise any time before expiry.
              </p>
              <div className="foot">
                <span className="tag">Physical settlement</span>
                <span className="tag">American exercise</span>
              </div>
            </Link>
            <Link className="card big" href="/binaries/">
              <span className="icon">{icons.binary}</span>
              <h3>Binaries</h3>
              <p>
                Pick above or below a strike and a stake. Someone takes the other side with the same stake, and the winner takes both on
                the Chainlink price at expiry.
              </p>
              <div className="foot">
                <span className="tag">Peer to peer</span>
                <span className="tag">Chainlink settlement</span>
              </div>
            </Link>
            <Link className="card" href="/vaults/">
              <span className="icon">{icons.income}</span>
              <h3>Income Vaults</h3>
              <p>Deposit USDG. Each week the vault sells puts below the market, and covered calls on any stock it is assigned.</p>
              <div className="foot">
                <span className="tag violet">Premiums in USDG</span>
              </div>
            </Link>
            <Link className="card" href="/vaults/">
              <span className="icon">{icons.pool}</span>
              <h3>Liquidity Vaults</h3>
              <p>Deposit USDG and earn one stock&apos;s Uniswap v4 trading fees from a range kept around the Chainlink price.</p>
              <div className="foot">
                <span className="tag violet">Fees compound</span>
              </div>
            </Link>
            <Link className="card" href="/borrow/">
              <span className="icon">{icons.credit}</span>
              <h3>Credit lines</h3>
              <p>Lend USDG for interest, or borrow USDG against Liquidity Vault shares in an isolated market.</p>
              <div className="foot">
                <span className="tag violet">Isolated risk</span>
              </div>
            </Link>
          </div>
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">How an option trade works</p>
            <h2>Lock, sell, settle.</h2>
          </div>
          <div className="steps">
            <div className="card">
              <h3>The writer locks collateral</h3>
              <p>
                Shares for a call, strike times size in USDG for a put. It sits in the options contract, which has no owner function that
                can touch it.
              </p>
            </div>
            <div className="card">
              <h3>A buyer pays the premium</h3>
              <p>
                The premium goes straight to the writer, less the protocol fee. Writers can limit how long an offer stays up and the price
                range it can be bought in.
              </p>
            </div>
            <div className="card">
              <h3>Exercise or expire</h3>
              <p>
                Until expiry the holder can exercise and swap at the strike. After expiry the collateral goes back to the writer; anyone
                can trigger that, and the keeper does.
              </p>
            </div>
          </div>
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">Safety</p>
            <h2>What the code guarantees.</h2>
            <p>Read it yourself: every contract is published and verified on the Robinhood Chain explorer.</p>
          </div>
          <ul className="checks">
            <li>
              <span>
                <b>Full collateral.</b> No option can be sold before the writer has locked everything it could ever pay out.
              </span>
            </li>
            <li>
              <span>
                <b>No house.</b> Binaries are matched between two traders, so the contract never owes more than it holds.
              </span>
            </li>
            <li>
              <span>
                <b>Exits never pause.</b> Exercising, expiring, cancelling and every vault exit keep working while new activity is paused.
              </span>
            </li>
            <li>
              <span>
                <b>Frozen payouts can&apos;t block anyone.</b> A payment a token refuses is held for its owner instead of reverting the
                other side&apos;s action.
              </span>
            </li>
            <li>
              <span>
                <b>48-hour timelock.</b> Every settings change is public two days before it runs. The guardian can only pause and tighten.
              </span>
            </li>
            <li>
              <span>
                <b>Chainlink, checked.</b> Stale feeds, a down USDG peg and the token issuer&apos;s corporate-action flag all stop pricing
                instead of being trusted.
              </span>
            </li>
          </ul>
          <TokenPanel />
        </section>

        <section className="sec">
          <div className="sec-h">
            <p className="eyebrow">FAQ</p>
            <h2>Questions, answered.</h2>
          </div>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="cta">
          <h2>Trade options on Stock Tokens from your wallet.</h2>
          <div className="row">
            <Link className="btn primary" href="/trade/">
              Open the desk
            </Link>
            <Link className="btn ghost" href="/docs/">
              Read the docs
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}

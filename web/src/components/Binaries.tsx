"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { binariesAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { BetState, marketOf, useBalances, useBets, useMarkets, useNow, type Bet, type Market } from "@/lib/data";
import { bps, countdown, fromInputUtc, parse, price, short, toInputUtc, usdg, when } from "@/lib/format";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { useOpenWallet } from "./Wallet";
import { MarketStrip, Stock } from "./Stock";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

const ABOVE = 0;
const HOUR = 3600;

function useFacts() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["binFacts", CHAIN_ID],
    enabled: Boolean(client && d),
    staleTime: 300_000,
    queryFn: async () => {
      const [feeBps, minStake] = await Promise.all([
        client!.readContract({ address: d!.binaries, abi: binariesAbi, functionName: "feeBps" }),
        client!.readContract({ address: d!.binaries, abi: binariesAbi, functionName: "minStake" }),
      ]);
      return { feeBps: Number(feeBps), minStake };
    },
  });
}

export function Binaries() {
  const d = DEPLOYMENT;
  const { data: markets } = useMarkets();
  const { data: bets } = useBets();
  const now = useNow();
  const [ticker, setTicker] = useState("");
  const [tab, setTab] = useState<"open" | "mine">("open");
  useEffect(() => {
    if (!ticker && markets?.length) setTicker(markets[0].ticker);
  }, [ticker, markets]);
  const joinable = useMemo(() => (bets ?? []).filter((b) => b.state === BetState.Open && now < b.joinBy), [bets, now]);

  if (!d) return <NotLive />;
  const market = markets?.find((m) => m.ticker === ticker);

  return (
    <div className="split">
      <div className="card">
        <div className="card-h">
          <Seg
            value={tab}
            onChange={setTab}
            options={[
              ["open", `Open bets${joinable.length ? ` · ${joinable.length}` : ""}`],
              ["mine", "Your bets"],
            ]}
          />
        </div>
        {tab === "open" && <OpenBets bets={joinable} markets={markets ?? []} now={now} />}
        {tab === "mine" && <MyBets bets={bets ?? []} now={now} />}
      </div>
      <div className="card">
        <div className="card-h">
          <h3>Make a call</h3>
          <span className="note">Someone takes the other side</span>
        </div>
        {markets && <MarketStrip markets={markets} value={ticker} onChange={setTicker} />}
        {market && <NewBet market={market} now={now} />}
      </div>
    </div>
  );
}

function OpenBets({ bets, markets, now }: { bets: Bet[]; markets: Market[]; now: number }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const openWallet = useOpenWallet();
  const tx = useTx();
  if (!bets.length) return <Empty title="No open bets right now.">Make the first call on the right: pick a stock, a strike and a side.</Empty>;
  const sorted = [...bets].sort((a, b) => a.joinBy - b.joinBy);
  return (
    <div className="pos">
      {sorted.map((b) => {
        const m = marketOf(b.token);
        const spot = markets.find((x) => x.ticker === m?.ticker)?.price;
        const takerSide = b.side === ABOVE ? "below" : "above";
        const win = b.stake * 2n - (b.stake * 2n * BigInt(b.feeBps)) / 10_000n;
        const mine = address && b.maker.toLowerCase() === address.toLowerCase();
        return (
          <div className="bet" key={b.id}>
            <div>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <Stock ticker={m?.ticker ?? "?"} size="sm" />
                <span className={`tag ${b.side === ABOVE ? "down" : "up"}`}>You take {takerSide.toUpperCase()}</span>
                {spot && <span className="note num">now {price(spot)}</span>}
              </div>
              <div className="line">
                Win <b>{usdg(win)}</b> if {m?.ticker} finishes <b>{takerSide}</b> <b>{price(b.strike)}</b> at {when(b.expiry)}.
              </div>
              <div className="meta">
                Stake {usdg(b.stake)} · join within {countdown(b.joinBy, now)} · maker {short(b.maker)}
              </div>
            </div>
            <div>
              {mine ? (
                <span className="tag">Your bet</span>
              ) : address ? (
                <button
                  className="btn primary small"
                  disabled={tx.busy}
                  onClick={() =>
                    tx.run("Joining the bet", async ({ approve, call }) => {
                      await approve(d.usdg, d.binaries, b.stake);
                      return call({ address: d.binaries, abi: binariesAbi, functionName: "join", args: [BigInt(b.id)] });
                    })
                  }
                >
                  Take it · {usdg(b.stake)}
                </button>
              ) : (
                <button className="btn primary small" onClick={openWallet}>
                  Take it · {usdg(b.stake)}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <TxStatus {...tx} />
    </div>
  );
}

function NewBet({ market, now }: { market: Market; now: number }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: balances } = useBalances();
  const { data: facts } = useFacts();
  const tx = useTx();
  const [side, setSide] = useState<"above" | "below">("above");
  const [strike, setStrike] = useState("");
  const [stake, setStake] = useState("50");
  const [expiry, setExpiry] = useState(() => toInputUtc(Math.floor(Date.now() / 1000 / HOUR) * HOUR + 24 * HOUR));

  useEffect(() => {
    if (market.price) setStrike(Number(formatUnits(market.price, 6)).toFixed(2));
  }, [market.ticker, market.price]);

  const strikeWei = parse(strike, 6);
  const stakeWei = parse(stake, 6);
  const expiryTs = fromInputUtc(expiry);
  const joinBy = now + Math.floor((expiryTs - now) / 2);
  const pot = stakeWei ? stakeWei * 2n : 0n;
  const fee = facts ? (pot * BigInt(facts.feeBps)) / 10_000n : 0n;

  let problem = "";
  if (!strikeWei || !stakeWei) problem = "Enter a strike and a stake.";
  else if (facts && stakeWei < facts.minStake) problem = `The smallest stake is ${usdg(facts.minStake, 0)}.`;
  else if (!(expiryTs >= now + 15 * 60)) problem = "Expiry must be at least 15 minutes away.";
  else if (expiryTs > now + 30 * 86400) problem = "Expiry can be at most 30 days away.";
  else if (!market.fresh) problem = `${market.ticker}'s Chainlink price is stale (market closed), so new bets wait until it updates.`;
  else if (balances && stakeWei > balances.USDG) problem = "Not enough USDG in your wallet.";

  const open = () =>
    tx.run("Opening the bet", async ({ approve, call }) => {
      await approve(d.usdg, d.binaries, stakeWei!);
      return call({
        address: d.binaries,
        abi: binariesAbi,
        functionName: "open",
        args: [market.token, side === "above" ? 0 : 1, strikeWei!, stakeWei!, BigInt(expiryTs), 0n],
      });
    });

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      <Seg
        value={side}
        onChange={setSide}
        options={[
          ["above", "Finishes above", "above"],
          ["below", "Finishes below", "below"],
        ]}
      />
      <div className="grid2">
        <Field label="Strike">
          <NumberInput value={strike} onChange={setStrike} unit="USD" />
        </Field>
        <Field label="Your stake">
          <NumberInput value={stake} onChange={setStake} unit="USDG" />
        </Field>
      </div>
      <Field label="Expiry (UTC)">
        <span className="input">
          <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </span>
      </Field>
      <div className="chips">
        {[
          ["1h", 1],
          ["4h", 4],
          ["1d", 24],
          ["3d", 72],
          ["1w", 168],
        ].map(([l, h]) => (
          <button key={l} type="button" onClick={() => setExpiry(toInputUtc(Math.ceil((now + (h as number) * HOUR) / 300) * 300))}>
            {l}
          </button>
        ))}
      </div>
      <div className="summary">
        <KV
          rows={[
            ["If you are right", pot ? usdg(pot - fee) : "—"],
            ["If you are wrong", stakeWei ? `lose ${usdg(stakeWei)}` : "—"],
            ["Exactly on the strike", "both refunded"],
            ["Open to takers until", expiryTs > now ? when(joinBy) : "—"],
            ["Fee on the pot", facts ? bps(facts.feeBps) : "…"],
          ]}
        />
      </div>
      {address ? (
        <button className="btn primary wide" disabled={Boolean(problem) || tx.busy} onClick={open}>
          Open bet
        </button>
      ) : (
        <Connect wide />
      )}
      {problem && address && <p className="note">{problem}</p>}
      <TxStatus {...tx} />
      <p className="note">
        Settles on the Chainlink price that was current at expiry. Unmatched bets can be cancelled any time and are refunded automatically
        after the join deadline.
      </p>
    </div>
  );
}

/** The Chainlink round current at `time`, the same rule the contract checks (see keeper/src/rounds.js). */
async function roundHint(client: NonNullable<ReturnType<typeof usePublicClient>>, feed: Address, time: number): Promise<bigint | null> {
  const abi = [
    { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
    { type: "function", name: "getRoundData", stateMutability: "view", inputs: [{ type: "uint80" }], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  ] as const;
  const t = BigInt(time);
  const MASK = (1n << 64n) - 1n;
  const at = async (id: bigint) => {
    try {
      const r = await client.readContract({ address: feed, abi, functionName: "getRoundData", args: [id] });
      return r[3] === 0n ? null : r[3];
    } catch {
      return null;
    }
  };
  const latest = await client.readContract({ address: feed, abi, functionName: "latestRoundData" });
  if (latest[3] !== 0n && latest[3] <= t) return 0n;
  const latestPhase = latest[0] >> 64n;
  for (let phase = latestPhase; phase >= 1n; phase--) {
    const base = phase << 64n;
    const first = await at(base | 1n);
    if (first === null || first > t) continue;
    let lo = 1n;
    let hi = latest[0] & MASK;
    if (phase !== latestPhase) {
      hi = 2n;
      while ((await at(base | hi)) !== null) hi *= 2n;
    }
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      const u = await at(base | mid);
      if (u !== null && u <= t) lo = mid;
      else hi = mid - 1n;
    }
    return base | lo;
  }
  return null;
}

function MyBets({ bets, now }: { bets: Bet[]; now: number }) {
  const d = DEPLOYMENT!;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  const tx = useTx();
  const me = address?.toLowerCase();
  const { data: owed } = useQuery({
    queryKey: ["binOwed", CHAIN_ID, address],
    enabled: Boolean(client && address),
    refetchInterval: 30_000,
    queryFn: () => client!.readContract({ address: d.binaries, abi: binariesAbi, functionName: "owed", args: [address!] }),
  });
  if (!address) return <Empty title="Connect a wallet to see your bets.">{null}</Empty>;
  const mine = bets.filter((b) => b.maker.toLowerCase() === me || b.taker.toLowerCase() === me).sort((a, b) => b.id - a.id);
  if (!mine.length && !owed) return <Empty title="No bets yet.">Take an open bet or make your own call.</Empty>;

  return (
    <div className="pos">
      {owed ? (
        <div className="pos-item">
          <div>
            <div className="title">Winnings waiting for you</div>
            <div className="meta">{usdg(owed)} could not be delivered when the bet settled.</div>
          </div>
          <div className="acts">
            <button className="btn ghost small" disabled={tx.busy} onClick={() => tx.run("Claiming", ({ call }) => call({ address: d.binaries, abi: binariesAbi, functionName: "claim" }))}>
              Claim
            </button>
          </div>
        </div>
      ) : null}
      {mine.map((b) => {
        const m = marketOf(b.token);
        const maker = b.maker.toLowerCase() === me;
        const mySide = maker ? b.side : 1 - b.side;
        const won = b.state === BetState.Settled && (b.makerWon === maker);
        const status =
          b.state === BetState.Open
            ? now < b.joinBy
              ? "Waiting for a taker"
              : "Unmatched"
            : b.state === BetState.Matched
              ? now <= b.expiry
                ? `Live · ends in ${countdown(b.expiry, now)}`
                : "Ready to settle"
              : b.state === BetState.Settled
                ? won
                  ? "Won"
                  : "Lost"
                : b.state === BetState.Void
                  ? "Refunded"
                  : "Cancelled";
        const settleable = b.state === BetState.Matched && now > b.expiry + 300;
        return (
          <div className="pos-item" key={b.id}>
            <div>
              <div className="title">
                <Stock ticker={m?.ticker ?? "?"} size="sm" />
                <span className={`tag ${mySide === ABOVE ? "up" : "down"}`}>{mySide === ABOVE ? "ABOVE" : "BELOW"}</span>
                <span className="num">{price(b.strike)}</span>
                <span className={`tag ${status === "Won" ? "up" : status === "Lost" ? "down" : ""}`}>{status}</span>
              </div>
              <div className="meta">
                Stake {usdg(b.stake)} · expiry {when(b.expiry)}
                {b.state === BetState.Settled && <> · settled at {price(b.settlePrice)}</>}
              </div>
            </div>
            <div className="acts">
              {b.state === BetState.Open && (maker || now >= b.joinBy) && (
                <button
                  className="btn ghost small"
                  disabled={tx.busy}
                  onClick={() => tx.run("Cancelling", ({ call }) => call({ address: d.binaries, abi: binariesAbi, functionName: "cancel", args: [BigInt(b.id)] }))}
                >
                  {maker ? "Cancel" : "Refund maker"}
                </button>
              )}
              {settleable && (
                <button
                  className="btn primary small"
                  disabled={tx.busy}
                  onClick={() =>
                    tx.run("Settling", async ({ call }) => {
                      const hint = await roundHint(client!, b.feed, b.expiry);
                      if (hint === null) throw new Error("No Chainlink price exists for that expiry yet.");
                      return call({ address: d.binaries, abi: binariesAbi, functionName: "settle", args: [BigInt(b.id), hint] });
                    })
                  }
                >
                  Settle
                </button>
              )}
              {b.state === BetState.Matched && now > b.expiry + 7 * 86400 && (
                <button
                  className="btn ghost small"
                  disabled={tx.busy}
                  onClick={() => tx.run("Refunding", ({ call }) => call({ address: d.binaries, abi: binariesAbi, functionName: "voidStale", args: [BigInt(b.id)] }))}
                >
                  Refund both
                </button>
              )}
            </div>
          </div>
        );
      })}
      <TxStatus {...tx} />
    </div>
  );
}


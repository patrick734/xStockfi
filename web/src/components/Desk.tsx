"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { optionsAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "@/lib/config";
import { ONE, OptionState, incomeVaultTicker, marketOf, useBalances, useMarkets, useNow, useOptions, type Market, type Option } from "@/lib/data";
import { amount, bps, countdown, fromInputUtc, parse, price, short, toInputUtc, usdg, when } from "@/lib/format";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { useOpenWallet } from "./Wallet";
import { MarketStrip, Stock } from "./Stock";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

const CALL = 0;
const PUT = 1;
const DAY = 86400;

export function Desk() {
  const d = DEPLOYMENT;
  const { data: markets } = useMarkets();
  const { data: options } = useOptions();
  const now = useNow();
  const [ticker, setTicker] = useState<string>("");
  const [tab, setTab] = useState<"buy" | "write" | "mine">("buy");

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("m");
    if (q && d?.markets[q.toUpperCase()]) setTicker(q.toUpperCase());
  }, [d]);

  // Default to the stock with the most open offers.
  const open = useMemo(() => (options ?? []).filter((o) => o.state === OptionState.Offered && now < o.buyBy), [options, now]);
  useEffect(() => {
    if (ticker || !markets?.length) return;
    const counts = new Map<string, number>();
    for (const o of open) {
      const t = marketOf(o.token)?.ticker;
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    setTicker(best ?? markets[0].ticker);
  }, [ticker, markets, open]);

  if (!d) return <NotLive />;
  const market = markets?.find((m) => m.ticker === ticker);

  return (
    <>
      {markets && <MarketStrip markets={markets} value={ticker} onChange={setTicker} />}
      {market && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="desk-head">
            <div className="row" style={{ gap: 16 }}>
              <Stock ticker={market.ticker} name={market.name} size="lg" />
              <div className="desk-price">
                <b>{price(market.price)}</b>
                <span className="row muted" style={{ gap: 6, fontSize: 12.5 }}>
                  <i className={`dot${market.fresh ? "" : " stale"}`} />
                  {market.fresh ? "Chainlink" : "Chainlink · market closed"}
                </span>
              </div>
            </div>
            <Seg
              value={tab}
              onChange={setTab}
              options={[
                ["buy", "Buy"],
                ["write", "Write"],
                ["mine", "Your options"],
              ]}
            />
          </div>
          {tab === "buy" && <Chain market={market} offers={open.filter((o) => o.token.toLowerCase() === market.token.toLowerCase())} now={now} />}
          {tab === "write" && <Write market={market} now={now} />}
          {tab === "mine" && <Mine options={options ?? []} markets={markets ?? []} now={now} />}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ buy side */

function Chain({ market, offers, now }: { market: Market; offers: Option[]; now: number }) {
  const sorted = [...offers].sort((a, b) => a.expiry - b.expiry || Number(a.strike - b.strike));
  return (
    <div className="chain-cols">
      {[CALL, PUT].map((kind) => (
        <div key={kind}>
          <div className="side-h">
            <span className={`tag ${kind === CALL ? "up" : "down"}`}>{kind === CALL ? "CALLS" : "PUTS"}</span>
            <span className="note">{kind === CALL ? "Right to buy at the strike" : "Right to sell at the strike"}</span>
          </div>
          <Offers market={market} offers={sorted.filter((o) => o.kind === kind)} kind={kind} now={now} />
        </div>
      ))}
    </div>
  );
}

function Offers({ market, offers, kind, now }: { market: Market; offers: Option[]; kind: number; now: number }) {
  const { address } = useAccount();
  const openWallet = useOpenWallet();
  const tx = useTx();
  const d = DEPLOYMENT!;
  if (!offers.length) {
    return (
      <div className="card tight" style={{ background: "var(--bg-2)" }}>
        <Empty title={`No ${kind === CALL ? "calls" : "puts"} on ${market.ticker} for sale right now.`}>Write one from the Write tab, or check another stock.</Empty>
      </div>
    );
  }
  const buy = (o: Option) =>
    tx.run("Buying the option", async ({ approve, call }) => {
      await approve(d.usdg, d.options, o.premium);
      return call({ address: d.options, abi: optionsAbi, functionName: "buy", args: [BigInt(o.id)] });
    });
  return (
    <div className="scroll-x">
      <table className="tbl">
        <thead>
          <tr>
            <th>Strike</th>
            <th>Expiry</th>
            <th>Shares</th>
            <th>Premium</th>
            <th>Breakeven</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {offers.map((o) => {
            const perShare = (o.premium * ONE) / o.size;
            const breakeven = kind === CALL ? o.strike + perShare : o.strike > perShare ? o.strike - perShare : 0n;
            const outside = market.price !== undefined && ((o.minPrice !== 0n && market.price < o.minPrice) || (o.maxPrice !== 0n && market.price > o.maxPrice));
            const vault = incomeVaultTicker(o.writer);
            const mine = address && o.writer.toLowerCase() === address.toLowerCase();
            return (
              <tr key={o.id}>
                <td>
                  <b>{price(o.strike)}</b>
                  <div className="note" style={{ fontSize: 11.5 }}>
                    {vault ? <span className="tag violet">Income Vault</span> : <span title={o.writer}>{short(o.writer)}</span>}
                  </div>
                </td>
                <td>
                  {when(o.expiry).split(" · ")[0]}
                  <div className="note" style={{ fontSize: 11.5 }}>
                    buy within {countdown(o.buyBy, now)}
                  </div>
                </td>
                <td>{amount(o.size, 18, 4)}</td>
                <td>
                  {usdg(o.premium)}
                  <div className="note" style={{ fontSize: 11.5 }}>
                    {price(perShare)}/sh
                  </div>
                </td>
                <td>{price(breakeven)}</td>
                <td>
                  {mine ? (
                    <span className="tag">Yours</span>
                  ) : !address ? (
                    <button className="btn buy small" onClick={openWallet}>
                      Buy
                    </button>
                  ) : (
                    <button className="btn buy small" disabled={tx.busy || outside} title={outside ? "The price moved outside the writer's range" : undefined} onClick={() => buy(o)}>
                      {outside ? "Paused" : "Buy"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <TxStatus {...tx} />
    </div>
  );
}

/* ------------------------------------------------------------------ write side */

function useDeskFacts() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["deskFacts", CHAIN_ID],
    enabled: Boolean(client && d),
    staleTime: 300_000,
    queryFn: async () => {
      const [feeBps, minNotional] = await Promise.all([
        client!.readContract({ address: d!.options, abi: optionsAbi, functionName: "feeBps" }),
        client!.readContract({ address: d!.options, abi: optionsAbi, functionName: "minNotional" }),
      ]);
      return { feeBps: Number(feeBps), minNotional };
    },
  });
}

function nextClose(now: number, days: number) {
  const t = new Date((now + days * DAY) * 1000);
  return Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 20) / 1000);
}

function Write({ market, now }: { market: Market; now: number }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: balances } = useBalances();
  const { data: facts } = useDeskFacts();
  const tx = useTx();
  const spot = market.price ? Number(formatUnits(market.price, 6)) : undefined;

  const [kind, setKind] = useState<"call" | "put">("call");
  const [size, setSize] = useState("1");
  const [strike, setStrike] = useState("");
  const [premium, setPremium] = useState("");
  const [expiry, setExpiry] = useState(() => toInputUtc(nextClose(Math.floor(Date.now() / 1000), 7)));
  const [windowH, setWindowH] = useState("");
  const [bandPct, setBandPct] = useState("");

  useEffect(() => {
    if (!spot) return;
    const step = spot < 100 ? 1 : spot < 250 ? 2.5 : 5;
    const k = kind === "call" ? Math.ceil((spot * 1.05) / step) * step : Math.floor((spot * 0.95) / step) * step;
    setStrike(String(k));
    setPremium("");
  }, [kind, market.ticker, spot]);

  const sizeWei = parse(size, 18);
  const strikeWei = parse(strike, 6);
  const premiumWei = parse(premium, 6);
  const expiryTs = fromInputUtc(expiry);
  const notional = sizeWei && strikeWei ? (sizeWei * strikeWei + ONE - 1n) / ONE : null;
  const collateral = kind === "call" ? sizeWei : notional;
  const have = kind === "call" ? balances?.[market.ticker] : balances?.USDG;
  const fee = premiumWei && facts ? (premiumWei * BigInt(facts.feeBps)) / 10_000n : 0n;
  const years = (expiryTs - now) / (365 * DAY);
  const yieldOnCollateral =
    premiumWei && notional && years > 0 ? Number(premiumWei - fee) / Number(kind === "call" && spot && sizeWei ? (sizeWei * BigInt(Math.round(spot * 1e6))) / ONE : notional) / years : null;
  const buyBy = windowH ? Math.min(now + Math.round(Number(windowH) * 3600), expiryTs) : 0;
  const band = Number(bandPct) > 0 && market.price ? (market.price * BigInt(Math.round(Number(bandPct) * 100))) / 10_000n : 0n;

  let problem = "";
  if (!sizeWei || !strikeWei || !premiumWei) problem = "Enter size, strike and premium.";
  else if (!(expiryTs > now + 3600)) problem = "Expiry must be at least an hour away.";
  else if (expiryTs > now + 180 * DAY) problem = "Expiry can be at most 180 days away.";
  else if (facts && notional !== null && notional < facts.minNotional) problem = `Strike x size must be at least ${usdg(facts.minNotional, 0)}.`;
  else if (have !== undefined && collateral !== null && collateral > have) problem = `Not enough ${kind === "call" ? market.ticker : "USDG"} in your wallet.`;

  const write = () =>
    tx.run(`Writing the ${kind}`, async ({ approve, call }) => {
      await approve(kind === "call" ? market.token : d.usdg, d.options, collateral!);
      return call({
        address: d.options,
        abi: optionsAbi,
        functionName: "write",
        args: [
          kind === "call" ? CALL : PUT,
          market.token,
          sizeWei!,
          strikeWei!,
          premiumWei!,
          BigInt(expiryTs),
          BigInt(buyBy),
          band ? market.price! - band : 0n,
          band ? market.price! + band : 0n,
        ],
      });
    });

  return (
    <div className="split">
      <div className="stack">
        <div className="row between">
          <Seg
            value={kind}
            onChange={setKind}
            options={[
              ["call", "Covered call", "call"],
              ["put", "Cash-secured put", "put"],
            ]}
          />
          <span className="note">
            {kind === "call" ? `Lock ${market.ticker}, earn a premium, sell at the strike if exercised.` : `Lock USDG, earn a premium, buy ${market.ticker} at the strike if exercised.`}
          </span>
        </div>
        <div className="grid3">
          <Field label="Shares" hint={have !== undefined && kind === "call" ? <button type="button" onClick={() => setSize(formatUnits(have, 18))}>Max {amount(have, 18, 4)}</button> : undefined}>
            <NumberInput value={size} onChange={setSize} unit={market.ticker} />
          </Field>
          <Field label="Strike">
            <NumberInput value={strike} onChange={setStrike} unit="USD" />
          </Field>
          <Field label="Premium (total)">
            <NumberInput value={premium} onChange={setPremium} unit="USDG" />
          </Field>
        </div>
        <Field label="Expiry (UTC)">
          <span className="input">
            <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          </span>
        </Field>
        <div className="chips">
          {[
            ["1D", 1],
            ["3D", 3],
            ["1W", 7],
            ["2W", 14],
            ["1M", 30],
          ].map(([l, days]) => (
            <button key={l} type="button" onClick={() => setExpiry(toInputUtc(nextClose(now, days as number)))}>
              {l}
            </button>
          ))}
        </div>
        <details>
          <summary className="note" style={{ cursor: "pointer" }}>
            Protect your quote (optional)
          </summary>
          <div className="grid2" style={{ marginTop: 12 }}>
            <Field label="Buyable for">
              <NumberInput value={windowH} onChange={setWindowH} unit="hours" placeholder="until expiry" />
            </Field>
            <Field label="Only while the price stays within">
              <NumberInput value={bandPct} onChange={setBandPct} unit="% of now" placeholder="any price" />
            </Field>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            A premium is only fair at today&apos;s price. Limit how long the offer stays up, or let it be bought only while Chainlink stays close to where it is now.
          </p>
        </details>
      </div>
      <div className="stack">
        <div className="summary">
          <KV
            rows={[
              ["You lock now", collateral ? (kind === "call" ? `${amount(collateral, 18)} ${market.ticker}` : usdg(collateral)) : "—"],
              ["You receive when bought", premiumWei ? usdg(premiumWei - fee) : "—"],
              ["Protocol fee", facts ? bps(facts.feeBps) : "…"],
              ["Annualized on collateral", yieldOnCollateral ? `${(yieldOnCollateral * 100).toFixed(1)}%` : "—"],
              [kind === "call" ? "If exercised you sell" : "If exercised you buy", sizeWei && notional ? `${amount(sizeWei, 18)} ${market.ticker} for ${usdg(notional)}` : "—"],
              ["If not, at expiry", "Collateral comes back"],
            ]}
          />
        </div>
        {address ? (
          <button className="btn primary wide" disabled={Boolean(problem) || tx.busy} onClick={write}>
            {kind === "call" ? "Write covered call" : "Write cash-secured put"}
          </button>
        ) : (
          <Connect wide />
        )}
        {problem && address && <p className="note">{problem}</p>}
        <TxStatus {...tx} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ positions */

function useOwed(tokens: Address[]) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["deskOwed", CHAIN_ID, address, tokens.join()],
    enabled: Boolean(client && d && address),
    refetchInterval: 30_000,
    queryFn: async () => {
      const out: { token: Address; amount: bigint }[] = [];
      for (const token of tokens) {
        const amount = await client!.readContract({ address: d!.options, abi: optionsAbi, functionName: "owed", args: [token, address!] });
        if (amount > 0n) out.push({ token, amount });
      }
      return out;
    },
  });
}

function Mine({ options, markets, now }: { options: Option[]; markets: Market[]; now: number }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const tx = useTx();
  const me = address?.toLowerCase();
  const mine = options.filter((o) => me && (o.writer.toLowerCase() === me || o.holder.toLowerCase() === me)).sort((a, b) => b.id - a.id);
  const { data: owed } = useOwed([d.usdg, ...markets.map((m) => m.token)]);

  if (!address) return <Empty title="Connect a wallet to see the options you wrote or bought.">{null}</Empty>;
  if (!mine.length && !owed?.length) return <Empty title="No options yet.">Buy one from the Buy tab or write your own.</Empty>;

  const STATE = ["", "For sale", "Active", "Exercised", "Expired", "Cancelled"];
  const act = (label: string, fn: string, o: Option, approveFirst?: { token: Address; amount: bigint }) =>
    tx.run(label, async ({ approve, call }) => {
      if (approveFirst) await approve(approveFirst.token, d.options, approveFirst.amount);
      return call({ address: d.options, abi: optionsAbi, functionName: fn, args: [BigInt(o.id)] });
    });

  return (
    <div className="pos">
      {owed?.map((w) => {
        const t = w.token.toLowerCase() === d.usdg.toLowerCase() ? "USDG" : marketOf(w.token)?.ticker ?? short(w.token);
        return (
          <div className="pos-item" key={w.token}>
            <div>
              <div className="title">Payment waiting for you</div>
              <div className="meta">
                {t === "USDG" ? usdg(w.amount) : `${amount(w.amount)} ${t}`} could not be delivered when it was due, usually because the token blocked the transfer.
              </div>
            </div>
            <div className="acts">
              <button
                className="btn ghost small"
                disabled={tx.busy}
                onClick={() => tx.run("Claiming", ({ call }) => call({ address: d.options, abi: optionsAbi, functionName: "claim", args: [w.token] }))}
              >
                Claim
              </button>
            </div>
          </div>
        );
      })}
      {mine.map((o) => {
        const m = marketOf(o.token);
        const t = m?.ticker ?? "?";
        const spot = markets.find((x) => x.ticker === t)?.price;
        const holder = o.holder.toLowerCase() === me;
        const writer = o.writer.toLowerCase() === me;
        const expired = now >= o.expiry;
        const strikeValue = (o.size * o.strike + ONE - 1n) / ONE;
        const intrinsic =
          spot === undefined ? undefined : o.kind === CALL ? (spot > o.strike ? ((spot - o.strike) * o.size) / ONE : 0n) : o.strike > spot ? ((o.strike - spot) * o.size) / ONE : 0n;
        return (
          <div className="pos-item" key={o.id}>
            <div>
              <div className="title">
                <Stock ticker={t} size="sm" />
                <span className={`tag ${o.kind === CALL ? "up" : "down"}`}>{o.kind === CALL ? "CALL" : "PUT"}</span>
                <span className="num">{price(o.strike)}</span>
                <span className="tag">{holder ? "Holder" : "Writer"}</span>
                <span className="tag">{STATE[o.state]}</span>
              </div>
              <div className="meta">
                {amount(o.size)} shares · premium {usdg(o.premium)} · expires {when(o.expiry)}
                {o.state === OptionState.Active && !expired && holder && intrinsic !== undefined && intrinsic > 0n && <> · worth {usdg(intrinsic)} if exercised now</>}
              </div>
            </div>
            <div className="acts">
              {holder && o.state === OptionState.Active && !expired && (
                <button
                  className="btn primary small"
                  disabled={tx.busy}
                  onClick={() =>
                    o.kind === CALL
                      ? act("Exercising", "exercise", o, { token: d.usdg, amount: strikeValue })
                      : act("Exercising", "exercise", o, { token: o.token, amount: o.size })
                  }
                >
                  Exercise {o.kind === CALL ? `· pay ${usdg(strikeValue)}` : `· get ${usdg(o.collateral)}`}
                </button>
              )}
              {writer && o.state === OptionState.Offered && !expired && (
                <button className="btn ghost small" disabled={tx.busy} onClick={() => act("Cancelling", "cancel", o)}>
                  Cancel offer
                </button>
              )}
              {(o.state === OptionState.Active || o.state === OptionState.Offered) && expired && (
                <button className="btn ghost small" disabled={tx.busy} onClick={() => act("Returning the collateral", "expire", o)}>
                  {writer ? "Reclaim collateral" : "Close out"}
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


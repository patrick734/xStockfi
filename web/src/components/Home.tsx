"use client";

import Link from "next/link";
import { useMemo } from "react";
import { BRAND } from "@/lib/brand";
import { DEPLOYMENT } from "@/lib/config";
import { ONE, OptionState, incomeVaultTicker, marketOf, useBets, useIncomeVaults, useLiquidityVaults, useMarkets, useNow, useOptions } from "@/lib/data";
import { compactUsd, countdown, price, usdg, when } from "@/lib/format";
import { CopyCA } from "./Chrome";
import { Logo, Stock } from "./Stock";

/** Live prices running under the hero. Renders nothing until prices load. */
export function Tape() {
  const { data } = useMarkets();
  const priced = (data ?? []).filter((m) => m.price);
  if (!priced.length) return null;
  const items = [...priced, ...priced];
  return (
    <div className="tape" aria-label="Chainlink prices">
      <div className="tape-in">
        {items.map((m, i) => (
          <span key={i}>
            <Logo ticker={m.ticker} size="sm" />
            <b>{m.ticker}</b>
            {price(m.price)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A real offer from the desk, or live prices when nothing is for sale. */
export function Ticket() {
  const { data: options } = useOptions();
  const { data: markets } = useMarkets();
  const now = useNow();
  const offer = useMemo(() => {
    const open = (options ?? []).filter((o) => o.state === OptionState.Offered && now < o.buyBy);
    return open.sort((a, b) => Number(incomeVaultTicker(b.writer) !== undefined) - Number(incomeVaultTicker(a.writer) !== undefined) || a.expiry - b.expiry)[0];
  }, [options, now]);

  if (offer) {
    const m = marketOf(offer.token);
    const spot = markets?.find((x) => x.ticker === m?.ticker)?.price;
    const perShare = (offer.premium * ONE) / offer.size;
    const vault = incomeVaultTicker(offer.writer);
    return (
      <div className="ticket">
        <div className="row between" style={{ marginBottom: 14 }}>
          <Stock ticker={m?.ticker ?? "?"} name={m?.name} size="lg" />
          <span className={`tag ${offer.kind === 0 ? "up" : "down"}`}>{offer.kind === 0 ? "CALL" : "PUT"}</span>
        </div>
        <div className="ticket-row">
          <span>Strike</span>
          <b>{price(offer.strike)}</b>
        </div>
        <div className="ticket-row">
          <span>Now</span>
          <b>{price(spot)}</b>
        </div>
        <div className="ticket-row">
          <span>Expiry</span>
          <b>{when(offer.expiry)}</b>
        </div>
        <div className="ticket-row">
          <span>Premium</span>
          <b>
            {usdg(offer.premium)} <span className="muted">({price(perShare)}/sh)</span>
          </b>
        </div>
        <div className="ticket-row">
          <span>Written by</span>
          <b>{vault ? `${vault} Income Vault` : "a trader"}</b>
        </div>
        <Link className="btn primary wide" style={{ marginTop: 16 }} href={`/trade/?m=${m?.ticker ?? ""}`}>
          Buy on the desk · {countdown(offer.buyBy, now)} left
        </Link>
      </div>
    );
  }

  const top = (markets ?? []).filter((m) => m.price).slice(0, 6);
  if (!top.length) return null;
  return (
    <div className="ticket">
      <p className="eyebrow" style={{ marginBottom: 10 }}>
        Chainlink prices
      </p>
      {top.map((m) => (
        <div className="ticket-row" key={m.ticker}>
          <Stock ticker={m.ticker} name={m.name} size="sm" />
          <b>{price(m.price)}</b>
        </div>
      ))}
      <Link className="btn primary wide" style={{ marginTop: 16 }} href="/trade/">
        Open the options desk
      </Link>
    </div>
  );
}

/** Live protocol figures. Each one appears only when it is above zero. */
export function Stats() {
  const { data: options } = useOptions();
  const { data: bets } = useBets();
  const { data: income } = useIncomeVaults();
  const { data: liquidity } = useLiquidityVaults();
  const { data: markets } = useMarkets();
  if (!DEPLOYMENT) return null;

  const px = new Map((markets ?? []).map((m) => [m.token.toLowerCase(), m.price ?? 0n]));
  let openInterest = 0n;
  let premiums = 0n;
  for (const o of options ?? []) {
    if (o.state === OptionState.Active) openInterest += o.kind === 1 ? o.collateral : (o.collateral * (px.get(o.token.toLowerCase()) ?? 0n)) / ONE;
    if (o.state >= OptionState.Active) premiums += o.premium;
  }
  const staked = (bets ?? []).filter((b) => b.state >= 2).reduce((s, b) => s + b.stake * 2n, 0n);
  const vaults =
    (income ?? []).reduce((s, v) => s + ((v.live ? v.roundStartValue : v.totalValue) ?? 0n), 0n) + (liquidity ?? []).reduce((s, v) => s + (v.heldValue ?? 0n), 0n);
  const items = [
    ["In vaults", vaults],
    ["Open interest", openInterest],
    ["Premiums paid to writers", premiums],
    ["Staked in binaries", staked],
  ].filter(([, v]) => (v as bigint) > 0n) as [string, bigint][];
  if (!items.length) return null;
  return (
    <div className="stats">
      {items.map(([label, v]) => (
        <div key={label}>
          <b>{compactUsd(v)}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export function TokenPanel() {
  const t = BRAND.token;
  if (!t) return null;
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="row between">
        <div>
          <p className="eyebrow">${t.symbol}</p>
          <h3 style={{ marginTop: 8 }}>Protocol fees buy and burn ${t.symbol}</h3>
          <p className="note" style={{ marginTop: 6, maxWidth: 560 }}>
            BuyBurn can only spend what it holds on ${t.symbol}, and burns every token it buys. It has no withdrawal function.
          </p>
        </div>
        <div className="stack" style={{ gap: 10, minWidth: 0, maxWidth: "100%" }}>
          <CopyCA address={t.address} />
          <a className="btn ghost small" href={t.ponsUrl} target="_blank" rel="noopener">
            Trade ${t.symbol} on Pons ↗
          </a>
        </div>
      </div>
    </div>
  );
}

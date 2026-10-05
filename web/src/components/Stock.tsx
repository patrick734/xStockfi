"use client";

import { useState } from "react";
import type { Market } from "@/lib/data";
import { price as fmtPrice } from "@/lib/format";

function logoSources(ticker: string) {
  const s = encodeURIComponent(ticker.toUpperCase());
  return [`https://financialmodelingprep.com/image-stock/${s}.png`, `https://assets.parqet.com/logos/symbol/${s}?format=png`];
}

/** Company logo for a ticker, falling back to a monogram if no logo loads. */
export function Logo({ ticker, size = "" }: { ticker: string; size?: "" | "sm" | "lg" }) {
  const [attempt, setAttempt] = useState(0);
  const sources = logoSources(ticker);
  if (attempt < sources.length) {
    return (
      <img
        key={sources[attempt]}
        className={`tk-dot ${size}`}
        src={sources[attempt]}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setAttempt((a) => a + 1)}
      />
    );
  }
  return (
    <span className={`tk-dot ${size}`} aria-hidden="true">
      {ticker.slice(0, 2)}
    </span>
  );
}

export function Stock({ ticker, name, size }: { ticker: string; name?: string; size?: "" | "sm" | "lg" }) {
  return (
    <span className="tk">
      <Logo ticker={ticker} size={size} />
      <span>
        <b>{ticker}</b>
        {name && <small>{name}</small>}
      </span>
    </span>
  );
}

/** Horizontal picker of every listed stock with its live price. */
export function MarketStrip({ markets, value, onChange }: { markets: Market[]; value: string; onChange: (t: string) => void }) {
  return (
    <div className="markets" role="tablist" aria-label="Stocks">
      {markets.map((m) => (
        <button key={m.ticker} role="tab" aria-selected={m.ticker === value} className={`mkt${m.ticker === value ? " on" : ""}`} onClick={() => onChange(m.ticker)}>
          <Logo ticker={m.ticker} size="sm" />
          <span>
            <b>{m.ticker}</b>
            <span>{m.price ? fmtPrice(m.price) : m.name}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

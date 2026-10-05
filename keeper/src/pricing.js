// Quotes for the Income Vaults: strikes, premiums and round expiries. Pure functions, unit-tested in
// scripts/unit.js. Floating point is fine here: every number sent on-chain is re-checked by the vault's limits.

const YEAR = 365 * 24 * 3600;

// Standard normal CDF (Abramowitz and Stegun 26.2.17, error below 7.5e-8).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** Black-Scholes value of one option on one share, with no interest (USDG earns nothing while it is collateral). */
function blackScholes(kind, spot, strike, years, vol) {
  if (years <= 0 || vol <= 0) return Math.max(0, kind === "call" ? spot - strike : strike - spot);
  const sd = vol * Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + (sd * sd) / 2) / sd;
  const d2 = d1 - sd;
  return kind === "call" ? spot * normCdf(d1) - strike * normCdf(d2) : strike * normCdf(-d2) - spot * normCdf(-d1);
}

/** Strike grid like listed equity options: tighter for cheap stocks. */
function strikeStep(price) {
  if (price < 25) return 0.5;
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  if (price < 1000) return 5;
  return 10;
}

/**
 * Strike `otmPct` out of the money, snapped to the grid away from the money, and never closer than the vault's
 * own minimum (`minOtmBps`, plus a small cushion for the price moving before the quote lands).
 */
function chooseStrike(kind, spot, otmPct, minOtmBps) {
  const step = strikeStep(spot);
  const pct = Math.max(otmPct, minOtmBps / 100 + 0.25);
  if (kind === "put") return Math.floor((spot * (1 - pct / 100)) / step) * step;
  return Math.ceil((spot * (1 + pct / 100)) / step) * step;
}

/**
 * Total premium in USDG for `size` shares: Black-Scholes plus `markupPct`, and at least the vault's floor
 * (`minPremiumBps` of `exposure`) with a small margin.
 */
function premium({ kind, spot, strike, size, years, vol, markupPct, minPremiumBps, exposure }) {
  const fair = blackScholes(kind, spot, strike, years, vol) * size * (1 + markupPct / 100);
  const floor = (exposure * (minPremiumBps + 1)) / 10_000;
  return Math.max(fair, floor);
}

/**
 * The next round expiry: the configured weekday and UTC hour (Friday 20:00 UTC, the US close in summer, by
 * default), at least `minSeconds` away. Returns unix seconds.
 */
function nextExpiry(nowSec, { weekday = 5, hourUtc = 20, minSeconds = 86_400 } = {}) {
  const d = new Date(nowSec * 1000);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc);
  let candidate = t / 1000 + ((weekday - d.getUTCDay() + 7) % 7) * 86_400;
  while (candidate < nowSec + minSeconds) candidate += 7 * 86_400;
  return candidate;
}

/** A conservative US cash-session window in UTC (14:00 to 20:00 on weekdays), whatever the daylight saving. */
function marketOpen(nowSec) {
  const d = new Date(nowSec * 1000);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return day >= 1 && day <= 5 && hour >= 14 && hour < 20;
}

module.exports = { YEAR, normCdf, blackScholes, strikeStep, chooseStrike, premium, nextExpiry, marketOpen };

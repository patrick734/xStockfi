import { formatUnits, parseUnits } from "viem";

// Display rule: a zero is never shown. Formatters return DASH for zero and LOADING while a value loads.
export const DASH = "—";
export const LOADING = "…";

export const USDG_DECIMALS = 6;

export function usdg(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, USDG_DECIMALS));
  const s = n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (Number(s.replace(/,/g, "")) === 0) return `<$${(10 ** -digits).toFixed(digits)}`;
  return `$${s}`;
}

/** A USD price with 6 decimals (strikes, oracle prices). */
export function price(value: bigint | undefined): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, 6));
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: n < 10 ? 4 : 2 })}`;
}

export function amount(value: bigint | undefined, decimals = 18, digits = 4): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, decimals));
  const s = n.toLocaleString("en-US", { maximumFractionDigits: digits });
  if (Number(s.replace(/,/g, "")) === 0) return `<${(10 ** -digits).toFixed(digits)}`;
  return s;
}

export function compactUsd(value: bigint | undefined): string {
  if (value === undefined) return LOADING;
  if (value === 0n) return DASH;
  const n = Number(formatUnits(value, USDG_DECIMALS));
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: n >= 100_000 ? 1 : 0 });
}

export function percent(fraction: number | null | undefined, digits = 1): string {
  if (fraction === undefined) return LOADING;
  if (fraction === null || !Number.isFinite(fraction)) return DASH;
  const s = (fraction * 100).toFixed(digits);
  return Number(s) === 0 ? DASH : `${s}%`;
}

export function bps(value: number | bigint | undefined): string {
  if (value === undefined) return LOADING;
  if (Number(value) === 0) return DASH;
  const n = Number(value) / 100;
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}%`;
}

export const nonZero = (v: bigint | undefined): v is bigint => v !== undefined && v !== 0n;

/** Parses typed input; null if it is not a positive number. */
export function parse(input: string, decimals: number): bigint | null {
  if (!input || !/^\d*\.?\d*$/.test(input) || input === ".") return null;
  try {
    const [w, f = ""] = input.split(".");
    const v = parseUnits(`${w || "0"}.${f.slice(0, decimals)}`, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const TIME_FMT = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** "Fri, Oct 16 · 20:00 UTC" */
export function when(ts: bigint | number | undefined): string {
  if (ts === undefined) return LOADING;
  const d = new Date(Number(ts) * 1000);
  return `${DAY_FMT.format(d)} · ${TIME_FMT.format(d)} UTC`;
}

/** "3d 4h", "5h 12m", "14m"; "ended" once past. */
export function countdown(ts: bigint | number | undefined, now: number): string {
  if (ts === undefined) return LOADING;
  const s = Number(ts) - now;
  if (s <= 0) return "ended";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

/** Datetime-local value ("2026-10-16T20:00") in UTC for a unix time, and back. */
export const toInputUtc = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16);
export const fromInputUtc = (v: string) => Math.floor(Date.parse(`${v}:00Z`) / 1000);

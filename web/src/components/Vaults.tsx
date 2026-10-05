"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, formatUnits, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { incomeVaultAbi, liquidityVaultAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT, addressUrl } from "@/lib/config";
import {
  OptionState,
  useIncomePosition,
  useIncomeVaults,
  useLiquidityVaults,
  useMarkets,
  useNow,
  useOptions,
  type IncomeVault,
  type LiquidityVault,
  type Market,
  type Option,
} from "@/lib/data";
import { amount, bps, compactUsd, countdown, nonZero, parse, price, usdg, when } from "@/lib/format";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { Stock } from "./Stock";
import { Empty, Field, KV, NotLive, NumberInput, Seg } from "./ui";

const SHARE_UNIT = 10n ** 18n;
const LP_SHARE_DECIMALS = 12;

export function Vaults() {
  const d = DEPLOYMENT;
  const { data: income } = useIncomeVaults();
  const { data: liquidity } = useLiquidityVaults();
  const { data: markets } = useMarkets();
  const { data: options } = useOptions();
  const now = useNow();
  if (!d) return <NotLive />;
  return (
    <>
      <section className="stack">
        <div className="row between">
          <div>
            <p className="eyebrow">Income Vaults</p>
            <h2 style={{ fontSize: 28, marginTop: 8 }}>Earn option premiums in USDG</h2>
          </div>
        </div>
        <p className="note" style={{ maxWidth: 760, fontSize: 14.5 }}>
          Each vault sells options on one stock every week through the options desk. Holding USDG it sells cash-secured puts below the
          market; if a put is exercised it owns the stock and sells covered calls above the market until the shares are called away.
          Premiums are paid to the vault the moment an option is bought.
        </p>
        {income?.map((v) => (
          <IncomeCard key={v.vault} v={v} market={markets?.find((m) => m.ticker === v.ticker)} options={options ?? []} now={now} />
        ))}
      </section>

      <section className="stack" style={{ marginTop: 56 }}>
        <div>
          <p className="eyebrow">Liquidity Vaults</p>
          <h2 style={{ fontSize: 28, marginTop: 8 }}>Earn one stock&apos;s trading fees</h2>
        </div>
        <p className="note" style={{ maxWidth: 760, fontSize: 14.5 }}>
          Deposit USDG and the vault keeps a concentrated Uniswap v4 position in that stock&apos;s pool, centred on the Chainlink price.
          Swap fees compound into the share price after the protocol share. Shares are valued at Chainlink, never at the pool price.
        </p>
        <div className="grid2">
          {liquidity?.map((v) => (
            <LiquidityCard key={v.vault} v={v} market={markets?.find((m) => m.ticker === v.ticker)} />
          ))}
        </div>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ Income Vault */

function IncomeCard({ v, market, options, now }: { v: IncomeVault; market?: Market; options: Option[]; now: number }) {
  const ids = new Set(v.options.map(Number));
  const round = options.filter((o) => ids.has(o.id));
  const sold = round.filter((o) => o.state !== OptionState.Offered && o.state !== OptionState.Cancelled);
  const premiums = sold.reduce((s, o) => s + o.premium - (o.premium * BigInt(o.feeBps)) / 10_000n, 0n);
  const value = v.live ? v.roundStartValue : v.totalValue;
  const fill = v.depositCap > 0n && value ? Number((value * 1000n) / v.depositCap) / 10 : 0;
  const ret = v.live && premiums > 0n && v.roundStartValue > 0n ? Number(premiums) / Number(v.roundStartValue) : null;

  return (
    <div className="card vault">
      <div className="vault-top">
        <div className="row" style={{ gap: 14 }}>
          <Stock ticker={v.ticker} name={`${v.name} · Income Vault`} size="lg" />
        </div>
        <div className="row">
          {v.paused && <span className="tag warn">Deposits paused</span>}
          {v.live ? (
            <span className="tag violet">
              Round {Number(v.round) + 1} · ends {when(v.roundExpiry)} · {countdown(v.roundExpiry, now)}
            </span>
          ) : (
            <span className="tag">Between rounds</span>
          )}
          <a className="note" href={addressUrl(v.vault)} target="_blank" rel="noopener">
            Contract ↗
          </a>
        </div>
      </div>
      <div className="vault-stats">
        <div className="stat">
          <span>{v.live ? "Value at round start" : "Vault value"}</span>
          <b>{usdg(value, 0)}</b>
        </div>
        <div className="stat">
          <span>Premiums this round</span>
          <b className={premiums > 0n ? "up" : undefined}>{usdg(premiums)}</b>
        </div>
        <div className="stat">
          <span>Round return</span>
          <b>{ret ? `${(ret * 100).toFixed(2)}%` : "—"}</b>
        </div>
        <div className="stat">
          <span>Holding</span>
          <b style={{ fontSize: 15 }}>
            {v.freeStock > 0n ? `${amount(v.freeStock, 18, 3)} ${v.ticker} + ${usdg(v.freeUsdg, 0)}` : v.live ? "USDG + open options" : "USDG"}
          </b>
        </div>
      </div>
      {v.depositCap > 0n && value !== undefined && value > 0n && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="row between note">
            <span>Capacity</span>
            <span className="num">
              {compactUsd(value)} of {compactUsd(v.depositCap)}
            </span>
          </div>
          <div className="progress">
            <i style={{ width: `${Math.min(100, Math.max(fill, 1))}%` }} />
          </div>
        </div>
      )}
      <div className="split side">
        <RoundOffers round={round} market={market} now={now} v={v} />
        <IncomeActions v={v} market={market} now={now} />
      </div>
    </div>
  );
}

function RoundOffers({ round, market, now, v }: { round: Option[]; market?: Market; now: number; v: IncomeVault }) {
  const STATE: Record<number, [string, string]> = {
    1: ["For sale", "violet"],
    2: ["Sold", "up"],
    3: ["Exercised", "warn"],
    4: ["Expired", ""],
    5: ["Withdrawn", ""],
  };
  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h3 style={{ fontSize: 15 }}>This round&apos;s options</h3>
        <span className="note">
          {market?.price ? `${v.ticker} ${price(market.price)} · ` : ""}strikes at least {bps(v.limits.minOtmBps)} out of the money
        </span>
      </div>
      {round.length === 0 ? (
        <Empty title={v.live ? "Quotes go up during US market hours." : "The next round starts with the next market session."}>
          {v.live ? "The keeper posts each quote on the options desk, where anyone can buy it." : "Deposits made now join at the start."}
        </Empty>
      ) : (
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Option</th>
                <th>Strike</th>
                <th>Shares</th>
                <th>Premium</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {round.map((o) => {
                const [label, tone] = STATE[o.state] ?? ["", ""];
                return (
                  <tr key={o.id}>
                    <td>
                      <span className={`tag ${o.kind === 0 ? "up" : "down"}`}>{o.kind === 0 ? "CALL" : "PUT"}</span>
                    </td>
                    <td>{price(o.strike)}</td>
                    <td>{amount(o.size, 18, 3)}</td>
                    <td>{usdg(o.premium)}</td>
                    <td>
                      <span className={`tag ${tone}`}>{o.state === OptionState.Offered && now >= o.buyBy ? "Closed" : label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IncomeActions({ v, market, now }: { v: IncomeVault; market?: Market; now: number }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: p } = useIncomePosition(v.vault);
  const tx = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [input, setInput] = useState("");
  const [pct, setPct] = useState(100);

  const amt = parse(input, 6);
  const instant = !v.live && v.freeStock === 0n;
  const shares = p ? (p.shares * BigInt(pct)) / 100n : 0n;
  const stockPx = market?.price ?? 0n;
  // During a round the collateral sits on the desk, so a holder's slice is shown at the round's starting value.
  const posValue = !p
    ? undefined
    : v.live
      ? v.totalSupply > 0n
        ? (p.shares * v.roundStartValue) / v.totalSupply
        : 0n
      : p.preview.usdg + (p.preview.stock * stockPx) / SHARE_UNIT;
  const pendingNow = p && p.pending.amount > 0n && p.pending.epoch === p.depositEpoch;
  const queuedNow = p && p.queued.shares > 0n && p.queued.round === v.round;
  const ready = p && (p.claimable.shares > 0n || p.claimable.usdg > 0n || p.claimable.stock > 0n);
  const owed = p && (p.owed.usdg > 0n || p.owed.stock > 0n);
  const canCancelDeposit = pendingNow && !(v.live && now >= v.roundExpiry);

  const deposit = () =>
    tx.run(instant ? "Depositing" : "Queueing the deposit", async ({ approve, call }) => {
      await approve(d.usdg, v.vault, amt!);
      return call({ address: v.vault, abi: incomeVaultAbi, functionName: "deposit", args: [amt!] });
    });
  const withdraw = () =>
    tx.run(v.live ? "Queueing the exit" : "Withdrawing", ({ call }) => call({ address: v.vault, abi: incomeVaultAbi, functionName: "withdraw", args: [shares] }));
  const simple = (label: string, fn: "cancelDeposit" | "cancelWithdraw" | "claim" | "claimOwed") =>
    tx.run(label, ({ call }) => call({ address: v.vault, abi: incomeVaultAbi, functionName: fn }));

  return (
    <div className="stack">
      <div className="summary">
        <KV
          rows={[
            [v.live ? "Your share at round start" : "Your position", address ? (posValue !== undefined ? usdg(posValue) : "…") : "—"],
            ...(p && !v.live && p.preview.stock > 0n ? ([["Of which stock", `${amount(p.preview.stock, 18, 4)} ${v.ticker}`]] as [string, string][]) : []),
            ...(pendingNow ? ([["Deposit waiting", `${usdg(p!.pending.amount)} · priced at close`]] as [string, string][]) : []),
            ...(queuedNow ? ([["Exit waiting", `${amount(p!.queued.shares, 18, 2)} shares · paid at close`]] as [string, string][]) : []),
          ]}
        />
      </div>
      <Seg
        value={mode}
        onChange={setMode}
        options={[
          ["deposit", "Deposit"],
          ["withdraw", "Withdraw"],
        ]}
      />
      {mode === "deposit" ? (
        <>
          <Field label="Amount" hint={p && nonZero(p.usdgBalance) ? <button type="button" onClick={() => setInput(formatUnits(p.usdgBalance, 6))}>Wallet {usdg(p.usdgBalance)}</button> : undefined}>
            <NumberInput value={input} onChange={setInput} unit="USDG" />
          </Field>
          <p className="note">
            {instant
              ? "Between rounds: your shares are minted right away at the vault's value."
              : v.live
                ? "A round is running: your USDG waits and joins at the close, priced then. You can cancel until the round expires."
                : "The vault holds stock from an exercised put: deposits are priced by the keeper at the next market session."}
          </p>
          {address ? (
            <button className="btn primary wide" disabled={!amt || tx.busy || v.paused || (p && amt > p.usdgBalance)} onClick={deposit}>
              {v.paused ? "Deposits paused" : instant ? "Deposit" : "Queue deposit"}
            </button>
          ) : (
            <Connect wide />
          )}
        </>
      ) : (
        <>
          <div className="chips">
            {[25, 50, 75, 100].map((x) => (
              <button key={x} type="button" style={x === pct ? { borderColor: "var(--accent-hi)", color: "var(--ink)" } : undefined} onClick={() => setPct(x)}>
                {x}%
              </button>
            ))}
          </div>
          <p className="note">
            {v.live
              ? "A round is running: your shares wait and are paid out at the close, as your share of whatever the vault holds then."
              : "Paid now: your share of the vault's USDG, plus stock if it holds any. No price is needed, so this always works."}
          </p>
          {address ? (
            <button className="btn primary wide" disabled={!shares || tx.busy} onClick={withdraw}>
              {v.live ? "Queue exit" : "Withdraw"} {posValue && shares ? `≈ ${usdg((posValue * BigInt(pct)) / 100n)}` : ""}
            </button>
          ) : (
            <Connect wide />
          )}
        </>
      )}
      {(canCancelDeposit || queuedNow || ready || owed) && (
        <div className="row">
          {canCancelDeposit && (
            <button className="btn ghost small" disabled={tx.busy} onClick={() => simple("Cancelling the deposit", "cancelDeposit")}>
              Cancel deposit
            </button>
          )}
          {queuedNow && (
            <button className="btn ghost small" disabled={tx.busy} onClick={() => simple("Cancelling the exit", "cancelWithdraw")}>
              Cancel exit
            </button>
          )}
          {ready && (
            <button className="btn ghost small" disabled={tx.busy} onClick={() => simple("Claiming", "claim")}>
              Claim {p!.claimable.usdg > 0n ? usdg(p!.claimable.usdg) : p!.claimable.shares > 0n ? "shares" : ""}
              {p!.claimable.stock > 0n ? ` + ${amount(p!.claimable.stock, 18, 3)} ${v.ticker}` : ""}
            </button>
          )}
          {owed && (
            <button className="btn ghost small" disabled={tx.busy} onClick={() => simple("Retrying the payout", "claimOwed")}>
              Retry payout
            </button>
          )}
        </div>
      )}
      <TxStatus {...tx} />
    </div>
  );
}

/* ------------------------------------------------------------------ Liquidity Vault */

function useLpAccount(vault: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["lpAccount", CHAIN_ID, vault, address],
    enabled: Boolean(client && d && address),
    refetchInterval: 20_000,
    queryFn: async () => {
      const shares = await client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "balanceOf", args: [address!] });
      const [value, maxWithdraw, maxDeposit, usdgBalance] = await Promise.all([
        shares > 0n ? client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "convertToAssets", args: [shares] }).catch(() => undefined) : 0n,
        client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "maxWithdraw", args: [address!] }),
        client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "maxDeposit", args: [address!] }),
        client!.readContract({ address: d!.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address!] }),
      ]);
      return { shares, value, maxWithdraw, maxDeposit, usdgBalance };
    },
  });
}

function LiquidityCard({ v, market }: { v: LiquidityVault; market?: Market }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: a } = useLpAccount(v.vault);
  const tx = useTx();
  const [mode, setMode] = useState<"deposit" | "withdraw" | "kind">("deposit");
  const [input, setInput] = useState("");
  const amt = parse(input, mode === "kind" ? LP_SHARE_DECIMALS : 6);
  const fill = v.cap && v.heldValue ? Number((v.heldValue * 1000n) / v.cap) / 10 : 0;
  const [stockHeld, usdgHeld] = v.holdings ?? [0n, 0n];
  const depositorShare = v.protocolShareBps !== undefined ? 10_000 - v.protocolShareBps : undefined;

  const run = () => {
    if (!amt || !address) return;
    if (mode === "deposit")
      return tx.run("Depositing", async ({ approve, call }) => {
        await approve(d.usdg, v.vault, amt);
        return call({ address: v.vault, abi: liquidityVaultAbi, functionName: "deposit", args: [amt, address] });
      });
    if (mode === "withdraw")
      return tx.run("Withdrawing", ({ call }) => call({ address: v.vault, abi: liquidityVaultAbi, functionName: "withdraw", args: [amt, address, address] }));
    return tx.run("Redeeming in kind", ({ call }) => call({ address: v.vault, abi: liquidityVaultAbi, functionName: "redeemInKind", args: [amt, address, address, 0n, 0n] }));
  };

  const limit = mode === "deposit" ? (a ? (a.usdgBalance < a.maxDeposit ? a.usdgBalance : a.maxDeposit) : undefined) : mode === "withdraw" ? a?.maxWithdraw : a?.shares;
  const blocked =
    mode === "deposit" && v.paused ? "Deposits paused" : mode !== "kind" && v.priceFresh === false ? "Price stale: use in kind" : amt && limit !== undefined && amt > limit ? "More than available" : null;

  return (
    <div className="card vault">
      <div className="vault-top">
        <Stock ticker={v.ticker} name={`${v.name} · Liquidity Vault`} size="lg" />
        <div className="row">
          {v.priceFresh === false && <span className="tag warn">Market closed</span>}
          <a className="note" href={addressUrl(v.vault)} target="_blank" rel="noopener">
            Contract ↗
          </a>
        </div>
      </div>
      <KV
        rows={[
          ["Vault value", usdg(v.heldValue, 0)],
          ["In the pool", stockHeld > 0n || usdgHeld > 0n ? `${amount(stockHeld, 18, 3)} ${v.ticker} + ${usdg(usdgHeld, 0)}` : "—"],
          ["Fees to depositors", depositorShare !== undefined ? bps(depositorShare) : "…"],
          [`${v.ticker} price`, price(market?.price)],
          ["Your shares", address ? (a ? usdg(a.value) : "…") : "—"],
        ]}
      />
      {v.cap && v.heldValue ? (
        <div className="progress" title={`${fill}% of the cap`}>
          <i style={{ width: `${Math.min(100, Math.max(fill, 1))}%` }} />
        </div>
      ) : null}
      <Seg
        value={mode}
        onChange={(m) => {
          setMode(m);
          setInput("");
        }}
        options={[
          ["deposit", "Deposit"],
          ["withdraw", "Withdraw"],
          ["kind", "In kind"],
        ]}
      />
      <Field
        label={mode === "kind" ? "Shares" : "USDG"}
        hint={
          nonZero(limit) ? (
            <button type="button" onClick={() => setInput(formatUnits(limit, mode === "kind" ? LP_SHARE_DECIMALS : 6))}>
              Max {mode === "kind" ? amount(limit, LP_SHARE_DECIMALS, 2) : usdg(limit)}
            </button>
          ) : undefined
        }
      >
        <NumberInput value={input} onChange={setInput} unit={mode === "kind" ? `xl${v.ticker}` : "USDG"} />
      </Field>
      <p className="note">
        {mode === "deposit"
          ? "Joins the pool at the next rebalance. Shares are priced at Chainlink."
          : mode === "withdraw"
            ? "Pays USDG; selling the stock part costs at most the vault's swap-loss limit, which you bear, not the other holders."
            : "Your share of the stock and USDG, no swap and no price needed. Works when markets are closed or the vault is paused."}
      </p>
      {address ? (
        <button className="btn primary wide" disabled={!amt || tx.busy || Boolean(blocked)} onClick={run}>
          {blocked ?? (mode === "deposit" ? "Deposit" : mode === "withdraw" ? "Withdraw" : "Redeem in kind")}
        </button>
      ) : (
        <Connect wide />
      )}
      <TxStatus {...tx} />
    </div>
  );
}

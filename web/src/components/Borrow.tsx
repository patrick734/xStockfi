"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, formatUnits, maxUint256, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { creditDeskAbi, liquidityVaultAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT, addressUrl } from "@/lib/config";
import { amount, bps, nonZero, parse, percent, usdg } from "@/lib/format";
import { TxStatus, useTx } from "@/lib/tx";
import { Connect } from "./Chrome";
import { Stock } from "./Stock";
import { Field, KV, NotLive, NumberInput, Seg } from "./ui";

const TABS = [
  ["lend", "Lend"],
  ["withdraw", "Withdraw"],
  ["pledge", "Pledge"],
  ["borrow", "Borrow"],
  ["repay", "Repay"],
  ["release", "Release"],
] as const;
type Tab = (typeof TABS)[number][0];
const SHARE_DECIMALS = 12;
const WAD = 10n ** 18n;

export function Borrow() {
  const d = DEPLOYMENT;
  if (!d) return <NotLive />;
  const lines = Object.entries(d.creditLines);
  return (
    <div className="stack">
      {lines.map(([ticker, desk]) => (
        <CreditLine key={desk} ticker={ticker} desk={desk} vault={d.liquidityVaults[ticker].vault} name={d.liquidityVaults[ticker].name} />
      ))}
    </div>
  );
}

function useLine(desk: Address, vault: Address) {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { address } = useAccount();
  const d = DEPLOYMENT!;
  return useQuery({
    queryKey: ["credit", CHAIN_ID, desk, address],
    enabled: Boolean(client),
    refetchInterval: 20_000,
    queryFn: async () => {
      const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
        client!.readContract({ address: desk, abi: creditDeskAbi, functionName, args } as never) as Promise<T>;
      const [supplied, debt, utilization, borrowRate, supplyRate, risk, supplyCap, borrowCap, paused, totalPledged, vaultSupply] = await Promise.all([
        r<bigint>("totalAssets"),
        r<bigint>("totalDebt"),
        r<bigint>("utilization"),
        r<bigint>("borrowRatePerYear"),
        r<bigint>("supplyRatePerYear"),
        r<readonly [number, number, number, number, number, number]>("risk"),
        r<bigint>("supplyCap"),
        r<bigint>("borrowCap"),
        r<boolean>("paused"),
        r<bigint>("totalCollateralShares"),
        client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "totalSupply" }),
      ]);
      let me = null;
      if (address) {
        const [lent, acct, myDebt, collateral, borrowable, health, shares, usdgBal, maxDeposit] = await Promise.all([
          r<bigint>("maxWithdraw", [address]),
          r<readonly [bigint, bigint]>("accounts", [address]),
          r<bigint>("debtOf", [address]),
          r<bigint>("collateralValue", [address]).catch(() => undefined),
          r<bigint>("borrowable", [address]),
          r<bigint>("healthFactor", [address]).catch(() => undefined),
          client!.readContract({ address: vault, abi: liquidityVaultAbi, functionName: "balanceOf", args: [address] }),
          client!.readContract({ address: d.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          r<bigint>("maxDeposit", [address]),
        ]);
        me = { lent, pledged: acct[0], debt: myDebt, collateral, borrowable, health, shares, usdgBal, maxDeposit };
      }
      return { supplied, debt, utilization, borrowRate, supplyRate, risk, supplyCap, borrowCap, paused, totalPledged, vaultSupply, me };
    },
  });
}

function CreditLine({ ticker, desk, vault, name }: { ticker: string; desk: Address; vault: Address; name: string }) {
  const d = DEPLOYMENT!;
  const { address } = useAccount();
  const { data: s } = useLine(desk, vault);
  const tx = useTx();
  const [tab, setTab] = useState<Tab>("lend");
  const [input, setInput] = useState("");
  const shares = tab === "pledge" || tab === "release";
  const amt = parse(input, shares ? SHARE_DECIMALS : 6);
  const me = s?.me;
  const min = (a?: bigint, b?: bigint) => (a === undefined || b === undefined ? undefined : a < b ? a : b);
  const pledgeRoom = s ? (() => {
    const cap = (s.vaultSupply * BigInt(s.risk[4])) / 10_000n;
    return cap > s.totalPledged ? cap - s.totalPledged : 0n;
  })() : undefined;
  const limit: bigint | undefined = me
    ? { lend: min(me.usdgBal, me.maxDeposit), withdraw: me.lent, pledge: min(me.shares, pledgeRoom), borrow: me.borrowable, repay: min(me.debt, me.usdgBal), release: me.pledged }[tab]
    : undefined;

  const go = () => {
    if (!amt || !address) return;
    const c = (fn: string, args: readonly unknown[]) => ({ address: desk, abi: creditDeskAbi, functionName: fn, args });
    const map: Record<Tab, () => void> = {
      lend: () =>
        tx.run("Lending", async ({ approve, call }) => {
          await approve(d.usdg, desk, amt);
          return call(c("deposit", [amt, address]));
        }),
      withdraw: () => tx.run("Withdrawing", ({ call }) => call(c("withdraw", [amt, address, address]))),
      pledge: () =>
        tx.run("Pledging", async ({ approve, call }) => {
          await approve(vault, desk, amt);
          return call(c("pledge", [amt]));
        }),
      borrow: () => tx.run("Borrowing", ({ call }) => call(c("borrow", [amt, address]))),
      repay: () =>
        tx.run("Repaying", async ({ approve, call }) => {
          // Interest keeps accruing until the transaction lands: repaying in full sends the max and lets the desk cap it.
          const full = me && amt >= me.debt;
          await approve(d.usdg, desk, full ? amt + amt / 1000n + 1n : amt);
          return call(c("repay", [full ? maxUint256 : amt, address]));
        }),
      release: () => tx.run("Releasing", ({ call }) => call(c("release", [amt, address]))),
    };
    map[tab]();
    setInput("");
  };

  const blurb: Record<Tab, string> = {
    lend: `Lend USDG to borrowers and earn the lend rate. You receive xc${ticker} lender shares.`,
    withdraw: "Take lent USDG back, up to the cash the credit line holds right now.",
    pledge: `Pledge ${ticker} Liquidity Vault shares (xl${ticker}) as collateral.`,
    borrow: "Borrow USDG against what you pledged, up to the max LTV. Needs a fresh Chainlink price. The rate is variable.",
    repay: "Repay any part of your debt at any time. Repaying never waits for a price.",
    release: "Take pledged shares back. With debt open, what stays pledged must still cover it at the max LTV.",
  };
  const paused = s?.paused && (tab === "lend" || tab === "pledge" || tab === "borrow");
  const blocked = paused ? "Paused by the guardian" : amt && limit !== undefined && amt > limit ? "More than available" : null;
  const health = me?.health;
  const healthText = health === undefined ? "…" : health > 1000n * WAD ? "∞" : Number(formatUnits(health, 18)).toFixed(2);

  return (
    <div className="card vault">
      <div className="vault-top">
        <Stock ticker={ticker} name={`${name} · Credit line`} size="lg" />
        <div className="row">
          {s?.paused && <span className="tag warn">Paused</span>}
          <a className="note" href={addressUrl(desk)} target="_blank" rel="noopener">
            Contract ↗
          </a>
        </div>
      </div>
      <div className="vault-stats">
        <div className="stat">
          <span>Supplied</span>
          <b>{usdg(s?.supplied, 0)}</b>
        </div>
        <div className="stat">
          <span>Borrowed</span>
          <b>{usdg(s?.debt, 0)}</b>
        </div>
        <div className="stat">
          <span>Borrow rate</span>
          <b>{s ? percent(Number(formatUnits(s.borrowRate, 18)), 2) : "…"}</b>
        </div>
        <div className="stat">
          <span>Lend rate</span>
          <b>{s ? percent(Number(formatUnits(s.supplyRate, 18)), 2) : "…"}</b>
        </div>
      </div>
      <p className="note">
        {s ? `Max LTV ${bps(s.risk[0])} · liquidation at ${bps(s.risk[1])} · liquidation bonus ${bps(s.risk[2])}` : "…"}
        {s && nonZero(s.utilization) ? ` · ${percent(Number(formatUnits(s.utilization, 18)), 0)} of supplied USDG is lent out` : ""}
      </p>
      <div className="split even">
        <div className="stack">
          <h3 style={{ fontSize: 15 }}>Your credit line</h3>
          {!address ? (
            <p className="note">Connect a wallet to see what you have lent, pledged and borrowed.</p>
          ) : (
            <KV
              rows={[
                ["Lent", usdg(me?.lent)],
                ["Pledged", me && nonZero(me.pledged) ? `${amount(me.pledged, SHARE_DECIMALS, 2)} xl${ticker}${me.collateral ? ` · ${usdg(me.collateral)}` : ""}` : "—"],
                ["Debt", usdg(me?.debt)],
                ["Can still borrow", usdg(me?.borrowable)],
                ["Health", me && (nonZero(me.debt) || nonZero(me.pledged)) ? healthText : "—"],
              ]}
            />
          )}
          <p className="note">
            Below a health of 1.00 anyone can repay part of your debt and take pledged shares at a discount. Prices pause outside market
            hours and can gap at the open.
          </p>
        </div>
        <div className="stack">
          <Seg
            value={tab}
            onChange={(t) => {
              setTab(t);
              setInput("");
            }}
            options={TABS}
          />
          <p className="note">{blurb[tab]}</p>
          <Field
            label={shares ? "Shares" : "USDG"}
            hint={nonZero(limit) ? <button type="button" onClick={() => setInput(formatUnits(limit, shares ? SHARE_DECIMALS : 6))}>Max {shares ? amount(limit, SHARE_DECIMALS, 2) : usdg(limit)}</button> : undefined}
          >
            <NumberInput value={input} onChange={setInput} unit={shares ? `xl${ticker}` : "USDG"} />
          </Field>
          {address ? (
            <button className="btn primary wide" disabled={!amt || tx.busy || Boolean(blocked)} onClick={go}>
              {blocked ?? TABS.find(([t]) => t === tab)![1]}
            </button>
          ) : (
            <Connect wide />
          )}
          <TxStatus {...tx} />
        </div>
      </div>
    </div>
  );
}

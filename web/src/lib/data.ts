"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { erc20Abi, type Address } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { binariesAbi, incomeVaultAbi, liquidityVaultAbi, optionsAbi, oracleAbi } from "@/generated/abis";
import { CHAIN_ID, DEPLOYMENT } from "./config";

export const ONE = 10n ** 18n; // every Robinhood Stock Token has 18 decimals
const PAGE = 200n;
const REFRESH = 20_000;

export type Market = { ticker: string; name: string; token: Address; price?: bigint; fresh?: boolean };

export const OptionState = { None: 0, Offered: 1, Active: 2, Exercised: 3, Expired: 4, Cancelled: 5 } as const;
export const BetState = { None: 0, Open: 1, Matched: 2, Settled: 3, Void: 4, Cancelled: 5 } as const;

export type Option = {
  id: number;
  writer: Address;
  expiry: number;
  buyBy: number;
  kind: number;
  state: number;
  holder: Address;
  feeBps: number;
  token: Address;
  size: bigint;
  strike: bigint;
  premium: bigint;
  collateral: bigint;
  minPrice: bigint;
  maxPrice: bigint;
};

export type Bet = {
  id: number;
  maker: Address;
  expiry: number;
  joinBy: number;
  side: number;
  state: number;
  taker: Address;
  feeBps: number;
  makerWon: boolean;
  token: Address;
  feed: Address;
  stake: bigint;
  strike: bigint;
  settlePrice: bigint;
};

/** Seconds since epoch, ticking. */
export function useNow(every = 15_000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function useClient() {
  return usePublicClient({ chainId: CHAIN_ID });
}

type Client = NonNullable<ReturnType<typeof useClient>>;
type Read = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
type Result = { status: "success" | "failure"; result?: unknown; error?: unknown };

/** Batched reads through Multicall3 where the chain has it, one by one otherwise (the local demo chain). */
async function readMany(client: Client, contracts: readonly Read[]): Promise<Result[]> {
  if (client.chain?.contracts?.multicall3) {
    return (await client.multicall({ allowFailure: true, contracts: contracts as never })) as Result[];
  }
  return Promise.all(
    contracts.map((c) =>
      client.readContract(c as never).then(
        (result): Result => ({ status: "success", result }),
        (error): Result => ({ status: "failure", error }),
      ),
    ),
  );
}

async function readAll(client: Client, contracts: readonly Read[]): Promise<unknown[]> {
  const out = await readMany(client, contracts);
  return out.map((r) => {
    if (r.status === "failure") throw r.error;
    return r.result;
  });
}

/** Every listed stock with its Chainlink price in USDG. */
export function useMarkets() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["markets", CHAIN_ID],
    enabled: Boolean(client && d),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<Market[]> => {
      const list = Object.entries(d!.markets).map(([ticker, m]) => ({ ticker, name: m.name, token: m.token }));
      const reads = await readMany(client!, list.flatMap((m) => [
          { address: d!.oracle, abi: oracleAbi, functionName: "isFresh", args: [m.token] } as const,
          { address: d!.oracle, abi: oracleAbi, functionName: "usdgValue", args: [m.token, ONE] } as const,
        ]),
      );
      return list.map((m, i) => ({
        ...m,
        fresh: reads[2 * i].status === "success" ? (reads[2 * i].result as boolean) : false,
        price: reads[2 * i + 1].status === "success" ? (reads[2 * i + 1].result as bigint) : undefined,
      }));
    },
  });
}

export function useOptions() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["options", CHAIN_ID],
    enabled: Boolean(client && d),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<Option[]> => {
      const count = await client!.readContract({ address: d!.options, abi: optionsAbi, functionName: "count" });
      const out: Option[] = [];
      for (let from = 0n; from < count; from += PAGE) {
        const page = await client!.readContract({ address: d!.options, abi: optionsAbi, functionName: "list", args: [from, from + PAGE] });
        page.forEach((o, i) =>
          out.push({
            ...o,
            id: Number(from) + i,
            expiry: Number(o.expiry),
            buyBy: Number(o.buyBy),
            kind: Number(o.kind),
            state: Number(o.state),
            feeBps: Number(o.feeBps),
          }),
        );
      }
      return out;
    },
  });
}

export function useBets() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["bets", CHAIN_ID],
    enabled: Boolean(client && d),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<Bet[]> => {
      const count = await client!.readContract({ address: d!.binaries, abi: binariesAbi, functionName: "count" });
      const out: Bet[] = [];
      for (let from = 0n; from < count; from += PAGE) {
        const page = await client!.readContract({ address: d!.binaries, abi: binariesAbi, functionName: "list", args: [from, from + PAGE] });
        page.forEach((b, i) =>
          out.push({
            ...b,
            id: Number(from) + i,
            expiry: Number(b.expiry),
            joinBy: Number(b.joinBy),
            side: Number(b.side),
            state: Number(b.state),
            feeBps: Number(b.feeBps),
          }),
        );
      }
      return out;
    },
  });
}

/** Wallet balances of USDG and every listed stock. */
export function useBalances() {
  const client = useClient();
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["balances", CHAIN_ID, address],
    enabled: Boolean(client && d && address),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<Record<string, bigint>> => {
      const tokens: [string, Address][] = [["USDG", d!.usdg], ...Object.entries(d!.markets).map(([t, m]) => [t, m.token] as [string, Address])];
      const reads = await readMany(client!, tokens.map(([, a]) => ({ address: a, abi: erc20Abi, functionName: "balanceOf", args: [address!] }) as const),
      );
      return Object.fromEntries(tokens.map(([t], i) => [t, reads[i].status === "success" ? (reads[i].result as bigint) : 0n]));
    },
  });
}

export type IncomeVault = {
  ticker: string;
  name: string;
  vault: Address;
  stock: Address;
  live: boolean;
  round: bigint;
  roundExpiry: number;
  roundStartValue: bigint;
  totalValue?: bigint;
  freeUsdg: bigint;
  freeStock: bigint;
  pendingUsdg: bigint;
  queuedShares: bigint;
  totalSupply: bigint;
  depositCap: bigint;
  paused: boolean;
  committed: bigint;
  options: bigint[];
  limits: { minOtmBps: number; minPremiumBps: number; maxCommitBps: number; quoteBandBps: number; entrySpreadBps: number };
};

export function useIncomeVaults() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["incomeVaults", CHAIN_ID],
    enabled: Boolean(client && d),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<IncomeVault[]> => {
      const list = Object.entries(d!.incomeVaults);
      const fns = [
        "live",
        "round",
        "roundExpiry",
        "roundStartValue",
        "totalValue",
        "freeUsdg",
        "freeStock",
        "pendingUsdg",
        "queuedShares",
        "totalSupply",
        "depositCap",
        "paused",
        "committed",
        "roundOptions",
        "limits",
      ] as const;
      const reads = await readMany(client!, list.flatMap(([, v]) => fns.map((functionName) => ({ address: v.vault, abi: incomeVaultAbi, functionName }) as const)),
      );
      return list.map(([ticker, v], i) => {
        const r = (k: number) => {
          const x = reads[i * fns.length + k];
          return x.status === "success" ? (x.result as unknown) : undefined;
        };
        const l = r(14) as readonly number[] | undefined;
        return {
          ticker,
          name: v.name,
          vault: v.vault,
          stock: v.stock,
          live: Boolean(r(0)),
          round: (r(1) as bigint) ?? 0n,
          roundExpiry: Number(r(2) ?? 0),
          roundStartValue: (r(3) as bigint) ?? 0n,
          totalValue: r(4) as bigint | undefined,
          freeUsdg: (r(5) as bigint) ?? 0n,
          freeStock: (r(6) as bigint) ?? 0n,
          pendingUsdg: (r(7) as bigint) ?? 0n,
          queuedShares: (r(8) as bigint) ?? 0n,
          totalSupply: (r(9) as bigint) ?? 0n,
          depositCap: (r(10) as bigint) ?? 0n,
          paused: Boolean(r(11)),
          committed: (r(12) as bigint) ?? 0n,
          options: ((r(13) as readonly bigint[]) ?? []).slice(),
          limits: {
            minOtmBps: Number(l?.[0] ?? 0),
            minPremiumBps: Number(l?.[1] ?? 0),
            maxCommitBps: Number(l?.[2] ?? 0),
            quoteBandBps: Number(l?.[3] ?? 0),
            entrySpreadBps: Number(l?.[5] ?? 0),
          },
        };
      });
    },
  });
}

export type IncomePosition = {
  shares: bigint;
  pending: { amount: bigint; epoch: bigint };
  queued: { shares: bigint; round: bigint };
  claimable: { shares: bigint; usdg: bigint; stock: bigint };
  owed: { usdg: bigint; stock: bigint };
  preview: { usdg: bigint; stock: bigint };
  depositEpoch: bigint;
  usdgBalance: bigint;
  allowance: bigint;
};

export function useIncomePosition(vault: Address | undefined) {
  const client = useClient();
  const { address } = useAccount();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["incomePosition", CHAIN_ID, vault, address],
    enabled: Boolean(client && d && vault && address),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<IncomePosition> => {
      const v = { address: vault!, abi: incomeVaultAbi } as const;
      const [shares, pending, queued, claimable, owed, depositEpoch, usdgBalance, allowance] = (await readAll(client!, [
          { ...v, functionName: "balanceOf", args: [address!] },
          { ...v, functionName: "pendingOf", args: [address!] },
          { ...v, functionName: "queuedOf", args: [address!] },
          { ...v, functionName: "claimable", args: [address!] },
          { ...v, functionName: "owed", args: [address!] },
          { ...v, functionName: "depositEpoch" },
          { address: d!.usdg, abi: erc20Abi, functionName: "balanceOf", args: [address!] },
          { address: d!.usdg, abi: erc20Abi, functionName: "allowance", args: [address!, vault!] },
        ])) as [bigint, readonly [bigint, bigint], readonly [bigint, bigint], readonly [bigint, bigint, bigint], readonly [bigint, bigint], bigint, bigint, bigint];
      const [pu, ps] = await client!.readContract({ ...v, functionName: "previewWithdraw", args: [shares] });
      return {
        shares,
        pending: { amount: pending[0], epoch: pending[1] },
        queued: { shares: queued[0], round: queued[1] },
        claimable: { shares: claimable[0], usdg: claimable[1], stock: claimable[2] },
        owed: { usdg: owed[0], stock: owed[1] },
        preview: { usdg: pu, stock: ps },
        depositEpoch,
        usdgBalance,
        allowance,
      };
    },
  });
}

export type LiquidityVault = {
  ticker: string;
  name: string;
  vault: Address;
  stock: Address;
  heldValue?: bigint;
  cap?: bigint;
  priceFresh?: boolean;
  paused?: boolean;
  totalSupply?: bigint;
  sharePrice?: bigint;
  holdings?: readonly [bigint, bigint];
  protocolShareBps?: number;
};

export function useLiquidityVaults() {
  const client = useClient();
  const d = DEPLOYMENT;
  return useQuery({
    queryKey: ["liquidityVaults", CHAIN_ID],
    enabled: Boolean(client && d),
    refetchInterval: REFRESH,
    queryFn: async (): Promise<LiquidityVault[]> => {
      const list = Object.entries(d!.liquidityVaults);
      const fns = [
        ["totalAssets", []],
        ["heldValueCap", []],
        ["priceFresh", []],
        ["paused", []],
        ["totalSupply", []],
        ["convertToAssets", [10n ** 12n]],
        ["holdings", []],
        ["protocolShareBps", []],
      ] as const;
      const reads = await readMany(client!, list.flatMap(([, v]) =>
          fns.map(([functionName, args]) => ({ address: v.vault, abi: liquidityVaultAbi, functionName, args }) as never),
        ),
      );
      return list.map(([ticker, v], i) => {
        const r = <T,>(k: number) => {
          const x = reads[i * fns.length + k];
          return x.status === "success" ? (x.result as T) : undefined;
        };
        return {
          ticker,
          name: v.name,
          vault: v.vault,
          stock: v.stock,
          heldValue: r<bigint>(0),
          cap: r<bigint>(1),
          priceFresh: r<boolean>(2),
          paused: r<boolean>(3),
          totalSupply: r<bigint>(4),
          sharePrice: r<bigint>(5),
          holdings: r<readonly [bigint, bigint]>(6),
          protocolShareBps: r<number>(7),
        };
      });
    },
  });
}

export function marketOf(token: Address | undefined) {
  if (!token || !DEPLOYMENT) return undefined;
  const hit = Object.entries(DEPLOYMENT.markets).find(([, m]) => m.token.toLowerCase() === token.toLowerCase());
  return hit ? { ticker: hit[0], name: hit[1].name } : undefined;
}

/** Writers that are Income Vaults show as such on the desk. */
export function incomeVaultTicker(writer: Address) {
  if (!DEPLOYMENT) return undefined;
  const hit = Object.entries(DEPLOYMENT.incomeVaults).find(([, v]) => v.vault.toLowerCase() === writer.toLowerCase());
  return hit?.[0];
}

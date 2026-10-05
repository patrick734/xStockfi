"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { erc20Abi, type Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { CHAIN, CHAIN_ID, txUrl } from "./config";
import { walletError } from "@/components/Wallet";

type TxState = { busy: boolean; message?: string; error?: string; hash?: Hash };

/** Runs one user action: switch chain if needed, approve if needed, send, wait, refresh every read. */
export function useTx() {
  const client = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<TxState>({ busy: false });

  async function wait(hash: Hash) {
    if (!client) throw new Error("No connection to the chain");
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The transaction reverted on-chain. Only gas was spent.");
  }

  async function approve(token: Address, spender: Address, amount: bigint) {
    if (!client || !address) throw new Error("Connect a wallet first");
    const current = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [address, spender] });
    if (current >= amount) return;
    setState({ busy: true, message: "Approve in your wallet…" });
    await wait(await writeContractAsync({ address: token, abi: erc20Abi, chainId: CHAIN_ID, functionName: "approve", args: [spender, amount] }));
  }

  /** Simulates first, so a call that would revert explains itself before the wallet opens. */
  async function call(params: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<Hash> {
    if (!client || !address) throw new Error("Connect a wallet first");
    const { request } = await client.simulateContract({ ...params, account: address } as Parameters<typeof client.simulateContract>[0]);
    return writeContractAsync({ ...(request as Parameters<typeof writeContractAsync>[0]), chainId: CHAIN_ID });
  }

  async function run(label: string, send: (h: { approve: typeof approve; call: typeof call }) => Promise<Hash>) {
    setState({ busy: true, message: `${label}…` });
    try {
      if (chainId !== CHAIN_ID) {
        setState({ busy: true, message: `Switch your wallet to ${CHAIN.name}…` });
        await switchChainAsync({ chainId: CHAIN_ID });
      }
      const hash = await send({ approve, call });
      setState({ busy: true, message: `${label}: confirming…`, hash });
      await wait(hash);
      setState({ busy: false, message: `${label}: done.`, hash });
      await queryClient.invalidateQueries();
    } catch (e) {
      setState({ busy: false, error: readable(e) });
    }
  }

  return { ...state, run, reset: () => setState({ busy: false }) };
}

/** Wallet errors, and the contracts' own errors, as one plain sentence. */
function readable(e: unknown): string {
  let name: string | undefined;
  for (let x = e as { cause?: unknown; data?: { errorName?: string }; errorName?: string; message?: string } | undefined, i = 0; x && i < 8; i++) {
    name = x.data?.errorName ?? x.errorName ?? /Error: (\w+)\(/.exec(x.message ?? "")?.[1];
    if (name) break;
    x = x.cause as typeof x;
  }
  const known: Record<string, string> = {
    TooLate: "Too late: that window has closed.",
    TooEarly: "Too early: this can only happen after expiry.",
    WrongState: "This position has already moved on. Refresh and try again.",
    OutsideBand: "The stock has moved outside the price range the writer allowed. Wait for a fresh quote.",
    Unpriced: "The Chainlink price is stale right now (market closed or a corporate action). Try again when it updates.",
    BadTerms: "Those terms are not accepted. Check the strike, size, premium and expiry.",
    NotAllowed: "Your wallet is not allowed to do that on this position.",
    CapExceeded: "That would go over the vault's cap.",
    NothingToCancel: "There is nothing to cancel.",
    NothingOwed: "Nothing is owed to this wallet.",
    ShortTransfer: "The token delivered less than the amount sent.",
    EnforcedPause: "This is paused by the guardian right now. Exits still work.",
    CorporateAction: "The stock is in a corporate action. Settlement waits until it ends.",
    NeedHint: "The price round at expiry needs a lookup. The keeper settles these automatically.",
  };
  if (name && known[name]) return known[name];
  return walletError(e);
}

export function TxStatus({ busy, message, error, hash }: { busy?: boolean; message?: string; error?: string; hash?: Hash }) {
  if (error) return <p className="tx err">{error}</p>;
  if (!message) return null;
  return (
    <p className={`tx ${busy ? "busy" : "ok"}`}>
      {message}{" "}
      {hash && (
        <a href={txUrl(hash)} target="_blank" rel="noopener">
          View ↗
        </a>
      )}
    </p>
  );
}

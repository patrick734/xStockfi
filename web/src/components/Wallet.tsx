"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useConnect, type Connector } from "wagmi";
import { CHAIN, CHAIN_ID } from "@/lib/config";
import { BRAND } from "@/lib/brand";

/** Opens the wallet picker from anywhere (header button, swap button). */
const OpenWallet = createContext<() => void>(() => {});
export const useOpenWallet = () => useContext(OpenWallet);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <OpenWallet.Provider value={() => setOpen(true)}>
      {children}
      {open && <WalletModal onClose={() => setOpen(false)} />}
    </OpenWallet.Provider>
  );
}

/** Turns wallet errors into one plain sentence. */
export function walletError(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string; cause?: { code?: number } };
  const code = err?.code ?? err?.cause?.code;
  const msg = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
  if (code === 4001 || /reject|denied|cancel/i.test(msg)) return "Request rejected in your wallet.";
  if (code === -32002 || /already pending/i.test(msg))
    return "Your wallet already has a request open. Open the wallet and approve or close it.";
  if (/provider not found|no provider/i.test(msg)) return "No wallet found in this browser.";
  return err?.shortMessage ?? err?.message ?? "Could not connect.";
}

function WalletModal({ onClose }: { onClose: () => void }) {
  const { connectors, connectAsync } = useConnect();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [env, setEnv] = useState({ mobile: false, hasEthereum: false, href: "", hostPath: "" });

  useEffect(() => {
    const w = window as unknown as { ethereum?: unknown };
    setEnv({
      mobile: /Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
      hasEthereum: !!w.ethereum,
      href: location.href,
      hostPath: location.host + location.pathname,
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Wallets that announce themselves (MetaMask, Rabby, Coinbase, Phantom…) come first.
  // The generic "Browser wallet" is only offered when none announced but window.ethereum exists.
  const seen = new Set<string>();
  const announced = connectors.filter((c) => {
    if (c.id === "injected" || seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
  const generic = connectors.find((c) => c.id === "injected");
  const list: Connector[] = announced.length ? announced : env.hasEthereum && generic ? [generic] : [];

  async function pick(c: Connector) {
    setError(null);
    setBusy(c.uid);
    try {
      await connectAsync({ connector: c, chainId: CHAIN_ID });
      onClose();
    } catch (e) {
      setError(walletError(e));
    } finally {
      setBusy(null);
    }
  }

  const deepLinks = [
    { name: "MetaMask", url: `https://metamask.app.link/dapp/${env.hostPath}` },
    { name: "Coinbase Wallet", url: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(env.href)}` },
    { name: "Trust Wallet", url: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(env.href)}` },
  ];

  return (
    <div className="wm-backdrop" onClick={onClose}>
      <div className="wm" role="dialog" aria-modal="true" aria-label="Connect a wallet" onClick={(e) => e.stopPropagation()}>
        <div className="wm-head">
          <span>Connect a wallet</span>
          <button className="wm-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {list.length > 0 && (
          <div className="wm-list">
            {list.map((c) => (
              <button key={c.uid} className="wm-item" disabled={!!busy} onClick={() => pick(c)}>
                {c.icon ? <img src={c.icon} alt="" /> : <i />}
                <span>{c.id === "injected" ? "Browser wallet" : c.name}</span>
                {busy === c.uid && <em>Check your wallet…</em>}
              </button>
            ))}
          </div>
        )}

        {list.length === 0 && env.mobile && (
          <>
            <p className="wm-note">Open {BRAND.name} inside your wallet app:</p>
            <div className="wm-list">
              {deepLinks.map((l) => (
                <a key={l.name} className="wm-item" href={l.url}>
                  <i />
                  <span>{l.name}</span>
                </a>
              ))}
            </div>
            <p className="wm-note small">Other wallets: open the browser inside the app and go to this page.</p>
          </>
        )}

        {list.length === 0 && !env.mobile && (
          <p className="wm-note">
            No browser wallet found. Install{" "}
            <a href="https://metamask.io/download" target="_blank" rel="noopener">
              MetaMask
            </a>{" "}
            or{" "}
            <a href="https://rabby.io" target="_blank" rel="noopener">
              Rabby
            </a>
            , then reload this page.
          </p>
        )}

        {error && <div className="err">{error}</div>}
        <p className="wm-note small">Your wallet will ask to add or switch to {CHAIN.name} ({CHAIN_ID}).</p>
      </div>
    </div>
  );
}

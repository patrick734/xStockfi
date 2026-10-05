"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { BRAND } from "@/lib/brand";
import { CHAIN, DEPLOYMENT, addressUrl } from "@/lib/config";
import { short } from "@/lib/format";
import { useOpenWallet } from "./Wallet";

export function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="xsf-g" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#7c3aff" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <path d="M4 8h10l4 8 4-8h6" fill="none" stroke="url(#xsf-g)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 24h10l4-8 4 8h6" fill="none" stroke="url(#xsf-g)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  ["/trade/", "Options"],
  ["/binaries/", "Binaries"],
  ["/vaults/", "Vaults"],
  ["/borrow/", "Borrow"],
  ["/docs/", "Docs"],
] as const;

export function Header() {
  const path = usePathname() || "/";
  return (
    <header className="hdr">
      <div className="wrap hdr-in">
        <Link href="/" className="brand" aria-label={`${BRAND.name} home`}>
          <Mark />
          <span>
            x<b>Stock</b>Fi
          </span>
        </Link>
        <nav className="nav">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className={path.startsWith(href) ? "on" : ""}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="hdr-right">
          <span className="chain">
            <i />
            {CHAIN.name}
          </span>
          <Connect />
        </div>
      </div>
    </header>
  );
}

export function Connect({ wide }: { wide?: boolean }) {
  const open = useOpenWallet();
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || !isConnected || !address) {
    return (
      <button className={`btn primary small${wide ? " wide" : ""}`} onClick={open}>
        Connect wallet
      </button>
    );
  }
  return (
    <span className="acct">
      <button className="btn ghost small" title="Disconnect" onClick={() => disconnect()}>
        {short(address)}
      </button>
    </span>
  );
}

export function Footer() {
  const d = DEPLOYMENT;
  return (
    <footer className="ftr">
      <div className="wrap">
        <div className="ftr-in">
          <div>
            <Link href="/" className="brand" style={{ marginBottom: 12 }}>
              <Mark />
              <span>
                x<b>Stock</b>Fi
              </span>
            </Link>
            <p style={{ margin: 0 }}>{BRAND.tagline}</p>
          </div>
          <div>
            <h4>Protocol</h4>
            <Link href="/trade/">Options desk</Link>
            <Link href="/binaries/">Binaries</Link>
            <Link href="/vaults/">Vaults</Link>
            <Link href="/borrow/">Borrow</Link>
          </div>
          <div>
            <h4>Contracts</h4>
            {d ? (
              <>
                <a href={addressUrl(d.options)} target="_blank" rel="noopener">
                  XStockFiOptions ↗
                </a>
                <a href={addressUrl(d.binaries)} target="_blank" rel="noopener">
                  XStockFiBinaries ↗
                </a>
                <a href={addressUrl(d.oracle)} target="_blank" rel="noopener">
                  XStockFiOracle ↗
                </a>
                <Link href="/docs/#contracts">All contracts</Link>
              </>
            ) : (
              <Link href="/docs/#contracts">Contract list</Link>
            )}
          </div>
          <div>
            <h4>More</h4>
            <Link href="/docs/">Docs</Link>
            <a href={BRAND.x} target="_blank" rel="noopener">
              X {BRAND.xHandle}
            </a>
            <a href={BRAND.github} target="_blank" rel="noopener">
              Source code
            </a>
            <Link href="/terms/">Terms</Link>
            <Link href="/privacy/">Privacy</Link>
          </div>
        </div>
        <p className="fine">
          Built on Robinhood Chain. Prices from Chainlink. xStockFi is a set of open-source smart contracts and this
          interface to them; nothing here is investment advice. Options and binaries can lose their whole premium or
          stake, and Stock Tokens are not shares. The contracts have not been independently audited.
        </p>
      </div>
    </footer>
  );
}

export function CopyCA({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ca">
      <span>{address}</span>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

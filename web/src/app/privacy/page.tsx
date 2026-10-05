import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function Privacy() {
  return (
    <div className="wrap page">
      <article className="prose">
        <p className="eyebrow">Legal</p>
        <h1 style={{ fontSize: 40, margin: "10px 0 24px" }}>Privacy Policy</h1>
        <p>This policy explains what happens to information when you use the xStockFi website and interface (the &quot;Service&quot;).</p>
        <h2>1. What we do not collect</h2>
        <p>There are no accounts. We never ask for your name, email address or any identity document, and there is no KYC.</p>
        <h2>2. Public by nature</h2>
        <p>
          Every transaction on Robinhood Chain is public. When you use the xStockFi contracts, your wallet address and transactions are
          permanently visible on-chain. That is how blockchains work and is outside our control.
        </p>
        <h2>3. Technical data</h2>
        <p>
          The website is static. Our hosting provider may keep standard server logs (IP address, browser type, pages requested, referrer)
          for security and operations, under its own policy.
        </p>
        <h2>4. Cookies and tracking</h2>
        <p>
          The Service sets no tracking or advertising cookies and uses no analytics that identify you. Your wallet connection is remembered
          in your browser&apos;s local storage so you stay connected; clearing it disconnects you.
        </p>
        <h2>5. Third parties</h2>
        <p>
          The interface reads the blockchain through a public Robinhood Chain RPC endpoint, and loads company logos from public logo
          services; those providers see your IP address when your browser contacts them. Fonts are served from this website. Prices come
          from Chainlink, which operates independently.
        </p>
        <h2>6. Children</h2>
        <p>The Service is not meant for anyone under 18.</p>
        <h2>7. Changes</h2>
        <p>We may update this policy. Continuing to use the Service after a change means you accept the updated policy.</p>
        <h2>8. Contact</h2>
        <p>Privacy questions: reach out through our official X account.</p>
      </article>
    </div>
  );
}

import type { Metadata } from "next";
import { Borrow } from "@/components/Borrow";

export const metadata: Metadata = { title: "Borrow" };

export default function BorrowPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Credit lines</p>
          <h1>Borrow USDG against vault shares</h1>
          <p>
            Each credit line is its own isolated market: lenders supply USDG, borrowers pledge one Liquidity Vault&apos;s shares. Collateral
            is valued at Chainlink, never at the pool price, and bad debt stays inside the market it came from.
          </p>
        </div>
      </div>
      <Borrow />
    </div>
  );
}

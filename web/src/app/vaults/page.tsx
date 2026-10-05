import type { Metadata } from "next";
import { Vaults } from "@/components/Vaults";

export const metadata: Metadata = { title: "Vaults" };

export default function VaultsPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Vaults</p>
          <h1>Put USDG to work</h1>
          <p>
            Two ways to earn on Stock Tokens without managing positions yourself: sell options through an Income Vault, or provide
            liquidity through a Liquidity Vault. Every exit works without the keeper, and without a price feed when you take it in kind.
          </p>
        </div>
      </div>
      <Vaults />
    </div>
  );
}

import type { Metadata } from "next";
import { Binaries } from "@/components/Binaries";

export const metadata: Metadata = { title: "Binaries" };

export default function BinariesPage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Binaries</p>
          <h1>Above or below. Winner takes the pot.</h1>
          <p>
            Two people stake the same amount on opposite sides of a strike. At expiry the bet settles on the Chainlink price and the winner
            receives both stakes, less the protocol fee. No house, no pool to drain: every bet is funded by its own two stakes.
          </p>
        </div>
      </div>
      <Binaries />
    </div>
  );
}

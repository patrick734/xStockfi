import type { Metadata } from "next";
import { Desk } from "@/components/Desk";

export const metadata: Metadata = { title: "Options desk" };

export default function TradePage() {
  return (
    <div className="wrap page">
      <div className="page-h">
        <div>
          <p className="eyebrow">Options desk</p>
          <h1>Calls and puts on Stock Tokens</h1>
          <p>
            Every option is fully collateralized: the writer locks the shares or the USDG before it can be sold. Buy one for its premium and
            exercise any time before expiry, or write your own and earn the premium.
          </p>
        </div>
      </div>
      <Desk />
    </div>
  );
}

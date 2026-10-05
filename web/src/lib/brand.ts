import { catalog } from "@/generated/catalog";
import { DEPLOYMENT } from "./deployment";

const token = DEPLOYMENT?.token && /^0x[0-9a-fA-F]{40}$/.test(DEPLOYMENT.token) ? DEPLOYMENT.token : null;

export const BRAND = {
  name: "xStockFi",
  domain: "xstockfi.finance",
  tagline: "Options on tokenized stocks, settled on-chain.",
  x: process.env.NEXT_PUBLIC_X_URL || "https://x.com/xstockf1",
  xHandle: "@xstockf1",
  github: process.env.NEXT_PUBLIC_GITHUB_URL || "https://github.com/patrick734/xStockfi",
  /** The xStockFi token: present only once it is launched and set on-chain (set-token.sh writes it here). */
  token: token
    ? {
        address: token,
        symbol: DEPLOYMENT?.tokenSymbol || "XSF",
        name: DEPLOYMENT?.tokenName || "xStockFi",
        ponsUrl: `${catalog.ponsPage}${token}`,
      }
    : null,
};

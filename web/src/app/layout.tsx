import type { Metadata, Viewport } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { BRAND } from "@/lib/brand";
import { Footer, Header } from "@/components/Chrome";
import { Providers } from "./providers";
import "./globals.css";

const SITE =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `https://${BRAND.domain}`);
const TITLE = `${BRAND.name}: options on tokenized stocks`;
const DESCRIPTION =
  "Covered calls, cash-secured puts and binaries on Robinhood Stock Tokens, fully collateralized and settled on-chain. Earn premiums in Income Vaults or trading fees in Liquidity Vaults.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: `%s · ${BRAND.name}` },
  description: DESCRIPTION,
  icons: { icon: "/icon.svg" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", siteName: BRAND.name, images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"], site: BRAND.xHandle },
};

export const viewport: Viewport = { themeColor: "#111215" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="glow" aria-hidden="true" />
        <Providers>
          <Header />
          <main>{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}

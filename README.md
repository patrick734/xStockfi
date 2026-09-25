# xStockFi website

A static site with no build step. Upload this folder as-is.

```
index.html          the whole page (styles and scripts inline)
assets/three.min.js 3D engine for the hero ring (Three.js r128)
assets/favicon.svg  browser tab icon
assets/og.png       social preview image (replace with your own 1200×630 PNG)
robots.txt
```

## 1. Before you deploy

Open `index.html` and find the **SITE SETTINGS** block near the top:

```js
window.XSTOCKFI = {
  appUrl:   "#",   // e.g. "https://app.xstockfi.com"
  xUrl:     "#",   // e.g. "https://x.com/xstockfi"
  docsUrl:  "#",   // leave "#" to hide every Docs link
  contract: ""     // main contract address; empty shows "TBA"
};
```

Also check:
- **Markets list**: search for `const MARKETS` and edit the stock tickers to match your actual listings.
- **Protocol info panel**: update the network name/ID, oracle provider, and fee in the Settlement section if they differ.
- **og.png**: replace with a 1200×630 PNG for social previews. Update `og:url` if your domain changes.

## 2. Deploy

**Vercel** (recommended): push to GitHub, import repo on vercel.com, deploy. Add your domain under Project → Settings → Domains.

**Netlify**: drag the folder into app.netlify.com/drop. Add your domain under Site settings → Domain management.

**Cloudflare Pages**: dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets → drag folder.

## 3. After deploy

- Visit your domain and check the ring animates.
- Paste the URL into X/Telegram to check the social preview card.

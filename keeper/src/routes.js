// Swap routes from config. A route is a list of hops; each hop is an address or a name:
//   "IN"          the token being sold
//   "USDG"        deployment usdg
//   "ETH"/"NATIVE" native ETH, address(0) in Uniswap v4
//   "XSF"         the xStockFi token (deployment `token`)
//   "<TICKER>"    that market's Stock Token, e.g. "META"
// Consecutive duplicates collapse, so ["IN","USDG","ETH","XSF"] for USDG itself is USDG -> ETH -> XSF.
// An empty list (or the string "default") encodes as "0x": the swap adapter's own default path.
// Otherwise the route is abi.encode(address[] path), the format XStockFiSwapAdapter.swap decodes.
const { ethers } = require("ethers");

function resolveHop(ctx, hop, tokenIn) {
  if (ethers.isAddress(hop)) return ethers.getAddress(hop);
  const name = String(hop).toUpperCase();
  if (name === "IN") {
    if (!tokenIn) throw new Error(`route hop "IN" needs a token being sold`);
    return tokenIn;
  }
  if (name === "USDG") return ethers.getAddress(ctx.dep.usdg);
  if (name === "ETH" || name === "NATIVE") return ethers.ZeroAddress;
  if (name === "XSF" || name === "TOKEN") {
    if (!ctx.dep.token) throw new Error("the xStockFi token is not set yet");
    return ethers.getAddress(ctx.dep.token);
  }
  const market = ctx.dep.markets && ctx.dep.markets[name];
  if (market) return ethers.getAddress(market.token);
  throw new Error(`unknown route hop "${hop}"`);
}

// Returns { route, path } where route is the bytes argument to pass on-chain.
function buildRoute(ctx, spec, tokenIn, tokenOut) {
  if (!spec || spec === "default" || (Array.isArray(spec) && spec.length === 0)) return { route: "0x", path: null };
  if (!Array.isArray(spec)) throw new Error(`route must be an array of hops or "default"`);
  const path = [];
  for (const hop of spec) {
    const a = resolveHop(ctx, hop, tokenIn);
    if (path.length === 0 || path[path.length - 1] !== a) path.push(a);
  }
  if (tokenIn && path[0] !== ethers.getAddress(tokenIn)) throw new Error(`route must start at the token sold (${tokenIn})`);
  if (tokenOut && path[path.length - 1] !== ethers.getAddress(tokenOut)) throw new Error(`route must end at ${tokenOut}`);
  if (path.length < 2) throw new Error("route needs at least two hops");
  return { route: ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [path]), path };
}

function encodeRoute(ctx, spec, tokenIn, tokenOut) {
  return buildRoute(ctx, spec, tokenIn, tokenOut).route;
}

module.exports = { buildRoute, encodeRoute };

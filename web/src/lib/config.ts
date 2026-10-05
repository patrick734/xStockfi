import { createConfig, http, injected } from "wagmi";
import { defineChain } from "viem";
import { DEPLOYMENT, EXPLORER, LOCAL_ID, ROBINHOOD_ID } from "./deployment";

export { DEPLOYMENT, EXPLORER, LOCAL_ID, ROBINHOOD_ID, addressUrl, txUrl } from "./deployment";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

export const robinhood = defineChain({
  id: ROBINHOOD_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const localChain = defineChain({
  id: LOCAL_ID,
  name: "Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_LOCAL_RPC || "http://127.0.0.1:8545"] } },
});

export const CHAIN = DEPLOYMENT?.chainId === LOCAL_ID ? localChain : robinhood;
export const CHAIN_ID = CHAIN.id;

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected()],
  transports: { [CHAIN.id]: http(CHAIN.rpcUrls.default.http[0], { batch: true }) } as never,
  // Static export: render the server markup first, then reconnect the wallet (no hydration mismatch).
  ssr: true,
});

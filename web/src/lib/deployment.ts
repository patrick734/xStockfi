import { deployments, type Deployment } from "@/generated/deployments";

export const ROBINHOOD_ID = 4663;
export const LOCAL_ID = 31337;
const LOCAL = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";

/** The deployment the site runs on: Robinhood Chain, or the local demo chain when explicitly enabled. */
export const DEPLOYMENT: Deployment | null = (LOCAL && deployments[LOCAL_ID]) || deployments[ROBINHOOD_ID] || null;

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;

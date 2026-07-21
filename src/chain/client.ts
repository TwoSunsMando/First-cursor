import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import { robinhoodChain } from "./addresses.js";

export type RhPublicClient = PublicClient<Transport, Chain>;
export type RhWalletClient = WalletClient<Transport, Chain, Account>;

const httpOpts = {
  // Soften retry storms against rate-limited public RPCs.
  retryCount: 2,
  retryDelay: 1_500,
  timeout: 30_000,
} as const;

export function createRhPublicClient(config: AppConfig): RhPublicClient {
  const transport = config.wssRpcUrl
    ? webSocket(config.wssRpcUrl, { reconnect: true })
    : http(config.RPC_URL, httpOpts);

  return createPublicClient({
    chain: robinhoodChain,
    transport,
  });
}

/** HTTP client for reads that should not depend on a flaky WSS session. */
export function createRhHttpClient(config: AppConfig): RhPublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(config.RPC_URL, httpOpts),
  });
}

export function createRhWalletClient(config: AppConfig): RhWalletClient {
  if (!config.privateKey) {
    throw new Error("PRIVATE_KEY required for wallet client");
  }
  const account = privateKeyToAccount(config.privateKey);
  return createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(config.RPC_URL),
  });
}

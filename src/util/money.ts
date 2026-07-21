import { fetchWethPriceUsd } from "../ingest/dexpaprika.js";

let cached: { price: number; at: number } | null = null;
const CACHE_MS = 60_000;

/** Live ETH/USD (DexPaprika WETH), cached ~60s. */
export async function getEthUsd(): Promise<number> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.price;
  const price = await fetchWethPriceUsd();
  cached = { price, at: now };
  return price;
}

export function ethToUsd(eth: number, ethUsd: number): number {
  return eth * ethUsd;
}

export function formatUsd(usd: number, digits = 2): string {
  const sign = usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(digits)}`;
}

/** Primary USD, ETH in parentheses. */
export function formatPnl(eth: number, ethUsd: number, pct?: number | null): string {
  const usd = formatUsd(ethToUsd(eth, ethUsd));
  const ethPart = `${eth >= 0 ? "+" : ""}${eth.toFixed(6)} ETH`;
  if (pct == null) return `${usd} (${ethPart})`;
  return `${usd} (${ethPart}, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

export function formatEthUsdSize(eth: number, ethUsd: number): string {
  return `${eth.toFixed(4)} ETH (${formatUsd(ethToUsd(eth, ethUsd))})`;
}

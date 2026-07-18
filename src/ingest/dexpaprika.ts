import { getAddress, isAddress, type Address } from "viem";
import { ADDRESSES } from "../chain/addresses.js";
import type { DexKind } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";
import type { ScoreExtras } from "../signals/score.js";

const BASE = "https://api.dexpaprika.com";
const WETH = ADDRESSES.WETH.toLowerCase();
const USDG = ADDRESSES.USDG.toLowerCase();
const STABLES = new Set([WETH, USDG]);

export interface DexPaprikaPool {
  id: string;
  dex_id: string;
  dex_name: string;
  volume_usd_24h: number;
  transactions_24h: number;
  liquidity_usd: number;
  price_usd: number;
  price_change_percentage_5m: number | null;
  price_change_percentage_1h: number | null;
  price_change_percentage_24h: number | null;
  fee: number | null;
  created_at: string;
  tokens: Array<{ id: string }>;
}

export interface DexPaprikaTokenSummary {
  id: string;
  name: string;
  symbol: string;
  price_usd?: number;
  summary?: {
    price_usd?: number;
    liquidity_usd?: number;
    "15m"?: WindowStats;
    "5m"?: WindowStats;
    "1h"?: WindowStats;
    "24h"?: WindowStats;
  };
}

interface WindowStats {
  volume_usd?: number;
  buys?: number;
  sells?: number;
  txns?: number;
  last_price_usd_change?: number | null;
}

export interface TrendingHit {
  candidate: CandidateToken;
  extras: ScoreExtras;
  volumeUsd24h: number;
  txns24h: number;
  liquidityUsd: number;
  priceChange1h: number | null;
  priceChange15m: number | null;
  rankKind: "volume" | "txns" | "boost";
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DexPaprika ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function fetchTopPools(opts: {
  orderBy: "volume_usd_24h" | "txns_24h" | "created_at";
  limit: number;
}): Promise<DexPaprikaPool[]> {
  const url =
    `${BASE}/networks/robinhood/pools/search?order_by=${opts.orderBy}&sort=desc&limit=${opts.limit}`;
  const data = await fetchJson<{ results: DexPaprikaPool[] }>(url);
  return data.results ?? [];
}

export async function fetchToken(address: string): Promise<DexPaprikaTokenSummary> {
  return fetchJson<DexPaprikaTokenSummary>(
    `${BASE}/networks/robinhood/tokens/${address.toLowerCase()}`,
  );
}

export async function fetchWethPriceUsd(): Promise<number> {
  try {
    const tok = await fetchToken(ADDRESSES.WETH);
    const px = tok.summary?.price_usd ?? tok.price_usd ?? 0;
    return px > 0 ? px : 1800;
  } catch {
    return 1800;
  }
}

function mapDex(dexId: string): DexKind | null {
  if (dexId === "uniswap_v2") return "v2";
  if (dexId === "uniswap_v3") return "v3";
  return null; // skip v4 / unknown for execution compatibility
}

function isEvmAddress(id: string): id is Address {
  return isAddress(id) && id.length === 42;
}

function memeTokenFromPool(pool: DexPaprikaPool): Address | null {
  const ids = (pool.tokens ?? []).map((t) => t.id.toLowerCase());
  const meme = ids.find((id) => !STABLES.has(id));
  if (!meme || !isEvmAddress(meme)) return null;
  // Require a WETH or USDG leg so we can size in ETH terms
  if (!ids.some((id) => STABLES.has(id))) return null;
  return getAddress(meme);
}

export async function collectTrendingHits(opts: {
  limit: number;
  minVolumeUsd24h: number;
  minLiquidityUsd: number;
  minTxns24h: number;
}): Promise<{ hits: TrendingHit[]; wethPriceUsd: number }> {
  const wethPriceUsd = await fetchWethPriceUsd();
  const [byVol, byTxns] = await Promise.all([
    fetchTopPools({ orderBy: "volume_usd_24h", limit: opts.limit }),
    fetchTopPools({ orderBy: "txns_24h", limit: opts.limit }),
  ]);

  const pools = new Map<string, { pool: DexPaprikaPool; rankKind: TrendingHit["rankKind"] }>();
  for (const p of byVol) pools.set(p.id.toLowerCase(), { pool: p, rankKind: "volume" });
  for (const p of byTxns) {
    const key = p.id.toLowerCase();
    if (!pools.has(key)) pools.set(key, { pool: p, rankKind: "txns" });
  }

  const hits: TrendingHit[] = [];
  const seenTokens = new Set<string>();

  for (const { pool, rankKind } of pools.values()) {
    if (!isEvmAddress(pool.id)) continue; // skip v4 pool ids
    const dex = mapDex(pool.dex_id);
    if (!dex) continue;

    const token = memeTokenFromPool(pool);
    if (!token) continue;
    if (seenTokens.has(token.toLowerCase())) continue;

    if ((pool.volume_usd_24h ?? 0) < opts.minVolumeUsd24h) continue;
    if ((pool.liquidity_usd ?? 0) < opts.minLiquidityUsd) continue;
    if ((pool.transactions_24h ?? 0) < opts.minTxns24h) continue;

    let meta: DexPaprikaTokenSummary;
    try {
      meta = await fetchToken(token);
    } catch {
      continue;
    }

    const w15 = meta.summary?.["15m"];
    const w5 = meta.summary?.["5m"];
    const w1h = meta.summary?.["1h"];
    const volumeUsd15m = w15?.volume_usd ?? 0;
    const volumeEth15m = wethPriceUsd > 0 ? volumeUsd15m / wethPriceUsd : 0;
    const uniqueBuyers = w15?.buys ?? w1h?.buys ?? 0;
    const priceChange15m = w15?.last_price_usd_change ?? null;
    const priceChange1h =
      w1h?.last_price_usd_change ?? pool.price_change_percentage_1h ?? null;
    const priceChange5m = w5?.last_price_usd_change ?? pool.price_change_percentage_5m ?? null;

    // "Boost" = sharp short-window move with meaningful 15m volume
    let effectiveRank = rankKind;
    if (
      volumeEth15m >= 0.2 &&
      ((priceChange5m != null && Math.abs(priceChange5m) >= 8) ||
        (priceChange15m != null && Math.abs(priceChange15m) >= 15))
    ) {
      effectiveRank = "boost";
    }

    const liqUsd = pool.liquidity_usd || meta.summary?.liquidity_usd || 0;
    const liqEth = wethPriceUsd > 0 ? liqUsd / wethPriceUsd : null;

    // DexPaprika fee looks like a fraction (0.01 ≈ 1% → Uniswap fee tier 10000).
    let v3Fee: number | null = null;
    if (dex === "v3") {
      if (pool.fee != null && Number.isFinite(pool.fee) && pool.fee > 0 && pool.fee <= 1) {
        v3Fee = Math.round(pool.fee * 1_000_000);
      } else {
        v3Fee = 10000;
      }
    }

    seenTokens.add(token.toLowerCase());
    hits.push({
      candidate: {
        token,
        symbol: meta.symbol || "???",
        name: meta.name || "Unknown",
        dex,
        pairOrPool: getAddress(pool.id),
        fee: v3Fee,
        initialLiquidityEth: liqEth,
        txHash: null,
        source: effectiveRank === "boost" ? "boost" : "trending",
      },
      extras: {
        volumeEth15m,
        uniqueBuyers,
        volumeUsd24h: pool.volume_usd_24h ?? 0,
        priceChange1hPct: priceChange1h,
        priceChange15mPct: priceChange15m,
        txns24h: pool.transactions_24h ?? 0,
      },
      volumeUsd24h: pool.volume_usd_24h ?? 0,
      txns24h: pool.transactions_24h ?? 0,
      liquidityUsd: liqUsd,
      priceChange1h,
      priceChange15m,
      rankKind: effectiveRank,
    });
  }

  hits.sort((a, b) => b.volumeUsd24h - a.volumeUsd24h);
  return { hits, wethPriceUsd };
}

export function formatTrendingTable(hits: TrendingHit[], wethPriceUsd: number): string {
  const lines = [
    `=== Robinhood Chain Trending (DexPaprika) ===`,
    `WETH≈$${wethPriceUsd.toFixed(2)}  hits=${hits.length}`,
    "",
  ];
  for (const [i, h] of hits.entries()) {
    const chg =
      h.priceChange15m != null ? `${h.priceChange15m.toFixed(1)}% 15m` : "n/a 15m";
    lines.push(
      `${String(i + 1).padStart(2)}. [${h.rankKind}] ${h.candidate.symbol.padEnd(12)} ` +
        `vol24h=$${(h.volumeUsd24h / 1000).toFixed(0)}k  ` +
        `tx=${h.txns24h}  liq=$${h.liquidityUsd.toFixed(0)}  ` +
        `15mVol≈${(h.extras.volumeEth15m ?? 0).toFixed(2)} ETH  ${chg}`,
    );
    lines.push(`    ${h.candidate.token}  ${h.candidate.dex} ${h.candidate.pairOrPool}`);
  }
  return lines.join("\n");
}

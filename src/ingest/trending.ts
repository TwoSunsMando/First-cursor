import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";
import { handleCandidate } from "./watcher.js";
import { collectTrendingHits, formatTrendingTable } from "./dexpaprika.js";

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Poll DexPaprika for top volume / txn pools and recent boosts.
 * Re-emits a token at most once per TRENDING_COOLDOWN_MS so Learning Mode
 * can see repeated momentum without spamming every tick.
 */
export function startTrendingPoller(
  config: AppConfig,
  db: BotDb,
  paper: PaperEngine,
  live: LiveGateway | null,
): () => void {
  if (!config.TRENDING_ENABLED) {
    logLine("trending poller disabled (TRENDING_ENABLED=false)");
    return () => undefined;
  }

  const cooldownMs = config.TRENDING_COOLDOWN_MS;
  const intervalMs = Math.max(config.TRENDING_INTERVAL_MS, 60_000);
  const lastEmit = new Map<string, number>();
  let busy = false;
  let stopped = false;

  logLine(
    `trending poller: every ${intervalMs}ms, top ${config.TRENDING_LIMIT}, cooldown ${cooldownMs}ms`,
  );

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const { hits, wethPriceUsd } = await collectTrendingHits({
        limit: config.TRENDING_LIMIT,
        minVolumeUsd24h: config.TRENDING_MIN_VOLUME_USD_24H,
        minLiquidityUsd: config.TRENDING_MIN_LIQUIDITY_USD,
        minTxns24h: config.TRENDING_MIN_TXNS_24H,
      });

      logLine(
        `trending refresh: ${hits.length} meme pools (WETH≈$${wethPriceUsd.toFixed(0)})`,
      );

      const now = Date.now();
      let emitted = 0;
      for (const hit of hits) {
        const key = hit.candidate.token.toLowerCase();
        const prev = lastEmit.get(key) ?? 0;
        if (now - prev < cooldownMs) continue;
        lastEmit.set(key, now);
        await handleCandidate(hit.candidate, config, db, paper, live, hit.extras);
        emitted += 1;
      }
      logLine(`trending emitted ${emitted}/${hits.length} (cooldown skipped rest)`);

      // Bound cooldown map
      if (lastEmit.size > 2_000) {
        for (const [k, t] of lastEmit) {
          if (now - t > cooldownMs * 4) lastEmit.delete(k);
        }
      }
    } catch (err) {
      logLine(`trending error: ${(err as Error).message}`);
    } finally {
      busy = false;
    }
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

export async function printTrendingOnce(config: AppConfig): Promise<void> {
  const { hits, wethPriceUsd } = await collectTrendingHits({
    limit: config.TRENDING_LIMIT,
    minVolumeUsd24h: config.TRENDING_MIN_VOLUME_USD_24H,
    minLiquidityUsd: config.TRENDING_MIN_LIQUIDITY_USD,
    minTxns24h: config.TRENDING_MIN_TXNS_24H,
  });
  console.log(formatTrendingTable(hits, wethPriceUsd));
}

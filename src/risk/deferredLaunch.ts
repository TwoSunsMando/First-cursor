import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { RhPublicClient } from "../chain/client.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";
import type { CandidateToken } from "./filters.js";
import {
  checkSellableRoundtrip,
  rereadPoolLiquidityEth,
} from "./sellability.js";

export interface DeferredLaunch {
  candidate: CandidateToken;
  /** Liquidity snapshot at first detect (for drop check). */
  liqAtDetect: number | null;
  readyAt: number;
  signalId: number;
  enqueuedAt: number;
  lastProbeAt?: number;
  aborted?: string;
}

function isLaunchSource(source: string): boolean {
  return (
    source === "noxa" ||
    source === "uniswap_v2" ||
    source === "uniswap_v3"
  );
}

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Non-blocking post-launch wait: enqueue BUYs, re-check liq+sellable when due.
 * Avoids sleeping inside the scan poller (which would miss blocks).
 */
export class DeferredLaunchQueue {
  private items: DeferredLaunch[] = [];
  private busy = false;

  get size(): number {
    return this.items.length;
  }

  /** True if launch sources must wait MIN_LAUNCH_AGE_MS before buy. */
  static shouldDeferLaunch(candidate: CandidateToken, config: AppConfig): boolean {
    return config.MIN_LAUNCH_AGE_MS > 0 && isLaunchSource(candidate.source);
  }

  enqueueLaunch(
    candidate: CandidateToken,
    signalId: number,
    config: AppConfig,
  ): void {
    const enqueuedAt = Date.now();
    const readyAt = enqueuedAt + config.MIN_LAUNCH_AGE_MS;
    const key = candidate.token.toLowerCase();
    this.items = this.items.filter((x) => x.candidate.token.toLowerCase() !== key);
    this.items.push({
      candidate,
      liqAtDetect: candidate.initialLiquidityEth,
      readyAt,
      signalId,
      enqueuedAt,
    });
    const waitSec = Math.round(config.MIN_LAUNCH_AGE_MS / 1000);
    logLine(
      `DEFER BUY ${candidate.symbol} ${waitSec}s min-age (liq=${candidate.initialLiquidityEth?.toFixed(3) ?? "?"} ETH) signal=#${signalId} queue=${this.items.length}`,
    );
  }

  async processDue(
    client: RhPublicClient,
    config: AppConfig,
    db: BotDb,
    paper: PaperEngine,
    live: LiveGateway | null,
  ): Promise<void> {
    if (this.busy || this.items.length === 0) return;
    this.busy = true;
    try {
      const now = Date.now();

      // Mid-wait probes: abort early if LP already yanked (don't wait full min-age)
      if (config.LAUNCH_LIQ_PROBE_MS > 0) {
        for (const item of this.items) {
          if (item.readyAt <= now || item.aborted) continue;
          if (item.candidate.dex === "noxa") continue;
          const age = now - item.enqueuedAt;
          if (age < config.LAUNCH_LIQ_PROBE_MS) continue;
          const last = item.lastProbeAt ?? 0;
          if (now - last < config.LAUNCH_LIQ_PROBE_MS) continue;
          item.lastProbeAt = now;

          const liqNow = await rereadPoolLiquidityEth(client, item.candidate);
          if (liqNow == null) continue;
          if (liqNow < config.MIN_LAUNCH_LIQUIDITY_ETH) {
            item.aborted = `mid-wait liq ${liqNow.toFixed(4)} ETH < min`;
            item.readyAt = now; // process as abort on next due pass
            logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
            continue;
          }
          if (
            item.liqAtDetect != null &&
            item.liqAtDetect > 0 &&
            config.LAUNCH_LIQ_DROP_MAX_PCT > 0
          ) {
            const dropPct =
              ((item.liqAtDetect - liqNow) / item.liqAtDetect) * 100;
            if (dropPct >= config.LAUNCH_LIQ_DROP_MAX_PCT) {
              item.aborted = `mid-wait drop ${dropPct.toFixed(0)}% (${item.liqAtDetect.toFixed(3)}→${liqNow.toFixed(3)})`;
              item.readyAt = now;
              logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
            }
          }
        }
      }

      const due = this.items.filter((i) => i.readyAt <= now);
      this.items = this.items.filter((i) => i.readyAt > now);

      for (const item of due) {
        if (item.aborted) {
          logLine(`DEFER SKIP ${item.candidate.symbol}: ${item.aborted}`);
          continue;
        }
        await this.executeAged(item, client, config, db, paper, live);
      }
    } finally {
      this.busy = false;
    }
  }

  private async executeAged(
    item: DeferredLaunch,
    client: RhPublicClient,
    config: AppConfig,
    db: BotDb,
    paper: PaperEngine,
    live: LiveGateway | null,
  ): Promise<void> {
    const { candidate } = item;
    const waitSec = Math.round((Date.now() - item.enqueuedAt) / 1000);
    let next = candidate;

    if (candidate.dex === "v2" || candidate.dex === "v3") {
      const liqNow = await rereadPoolLiquidityEth(client, candidate);
      if (liqNow == null && config.REJECT_NULL_LIQUIDITY) {
        logLine(
          `DEFER SKIP ${candidate.symbol}: pool WETH unreadable after ${waitSec}s`,
        );
        return;
      }
      if (liqNow != null) {
        next = { ...candidate, initialLiquidityEth: liqNow };
        if (liqNow < config.MIN_LAUNCH_LIQUIDITY_ETH) {
          logLine(
            `DEFER SKIP ${candidate.symbol}: after ${waitSec}s liq ${liqNow.toFixed(4)} < min ${config.MIN_LAUNCH_LIQUIDITY_ETH} (likely rug)`,
          );
          return;
        }
        if (
          item.liqAtDetect != null &&
          item.liqAtDetect > 0 &&
          config.LAUNCH_LIQ_DROP_MAX_PCT > 0
        ) {
          const dropPct =
            ((item.liqAtDetect - liqNow) / item.liqAtDetect) * 100;
          if (dropPct >= config.LAUNCH_LIQ_DROP_MAX_PCT) {
            logLine(
              `DEFER SKIP ${candidate.symbol}: after ${waitSec}s WETH dropped ${dropPct.toFixed(0)}% (${item.liqAtDetect.toFixed(3)}→${liqNow.toFixed(3)}) — rug pattern`,
            );
            return;
          }
        }
        logLine(
          `DEFER OK ${candidate.symbol}: survived ${waitSec}s liq=${liqNow.toFixed(4)} ETH (was ${item.liqAtDetect?.toFixed(3) ?? "?"})`,
        );
      }
    } else {
      logLine(
        `DEFER OK ${candidate.symbol}: waited ${waitSec}s (noxa, no pool recheck)`,
      );
    }

    const sellable = await checkSellableRoundtrip(client, next, config);
    if (!sellable.ok) {
      logLine(`DEFER SKIP ${next.symbol}: ${sellable.reason}`);
      return;
    }
    logLine(`DEFER ${next.symbol}: ${sellable.reason}`);

    const mode = config.EXECUTION_MODE;
    if (db.countOpenPositions(mode) >= config.MAX_OPEN_POSITIONS) {
      logLine(`DEFER SKIP ${next.symbol}: max open positions`);
      return;
    }
    if (db.hasOpenPositionForToken(next.token, mode)) {
      logLine(`DEFER SKIP ${next.symbol}: already open`);
      return;
    }

    const signalId = db.insertSignal({
      token: next.token,
      symbol: next.symbol,
      name: next.name,
      dex: next.dex,
      pair_or_pool: next.pairOrPool,
      fee: next.fee,
      score: 0,
      action: "BUY",
      reasons: `deferred min-age ${waitSec}s; ${sellable.reason}; from signal #${item.signalId}`,
      initial_liquidity_eth: next.initialLiquidityEth,
      tx_hash: next.txHash,
      source: next.source,
    });

    if (mode === "paper") {
      await paper.tryOpenFromSignal(next, signalId);
      return;
    }
    if (live) {
      await live.requestBuyApproval(next, signalId);
    }
  }
}

/** Shared queue instance used by ingest + runner mark loop. */
export const deferredLaunchQueue = new DeferredLaunchQueue();

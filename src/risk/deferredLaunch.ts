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
  /** Highest WETH seen during wait — reject if we give back from peak. */
  peakLiq: number | null;
  readyAt: number;
  signalId: number;
  enqueuedAt: number;
  /** age = waiting min age; confirm = extra stability window after first survive */
  phase: "age" | "confirm";
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

function dropTooHard(
  from: number,
  to: number,
  maxDropPct: number,
): number | null {
  if (maxDropPct <= 0 || from <= 0) return null;
  const dropPct = ((from - to) / from) * 100;
  return dropPct >= maxDropPct ? dropPct : null;
}

/**
 * Non-blocking post-launch wait: enqueue BUYs, re-check liq+sellable when due.
 * Phase 1 = MIN_LAUNCH_AGE_MS; Phase 2 = LAUNCH_CONFIRM_MS stability window.
 */
export class DeferredLaunchQueue {
  private items: DeferredLaunch[] = [];
  private busy = false;

  get size(): number {
    return this.items.length;
  }

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
    const liq = candidate.initialLiquidityEth;
    this.items.push({
      candidate,
      liqAtDetect: liq,
      peakLiq: liq,
      readyAt,
      signalId,
      enqueuedAt,
      phase: "age",
    });
    const waitSec = Math.round(config.MIN_LAUNCH_AGE_MS / 1000);
    const confSec = Math.round(config.LAUNCH_CONFIRM_MS / 1000);
    logLine(
      `DEFER BUY ${candidate.symbol} age=${waitSec}s` +
        (confSec > 0 ? `+confirm=${confSec}s` : "") +
        ` (liq=${liq?.toFixed(3) ?? "?"} ETH) signal=#${signalId} queue=${this.items.length}`,
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
          if (item.peakLiq == null || liqNow > item.peakLiq) item.peakLiq = liqNow;

          if (liqNow < config.MIN_LAUNCH_LIQUIDITY_ETH) {
            item.aborted = `mid-wait liq ${liqNow.toFixed(4)} ETH < min`;
            item.readyAt = now;
            logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
            continue;
          }
          const fromDetect = item.liqAtDetect;
          if (fromDetect != null) {
            const d = dropTooHard(fromDetect, liqNow, config.LAUNCH_LIQ_DROP_MAX_PCT);
            if (d != null) {
              item.aborted = `mid-wait drop ${d.toFixed(0)}% from detect (${fromDetect.toFixed(3)}→${liqNow.toFixed(3)})`;
              item.readyAt = now;
              logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
              continue;
            }
          }
          if (item.peakLiq != null) {
            const d = dropTooHard(item.peakLiq, liqNow, config.LAUNCH_LIQ_DROP_MAX_PCT);
            if (d != null) {
              item.aborted = `mid-wait drop ${d.toFixed(0)}% from peak (${item.peakLiq.toFixed(3)}→${liqNow.toFixed(3)})`;
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

        // End of age phase → optional confirm window (catches delayed rugs that look fine at 2m)
        if (item.phase === "age" && config.LAUNCH_CONFIRM_MS > 0) {
          const check = await this.liqStillHealthy(client, item, config);
          if (!check.ok) {
            logLine(`DEFER SKIP ${item.candidate.symbol}: ${check.reason}`);
            continue;
          }
          item.phase = "confirm";
          item.readyAt = Date.now() + config.LAUNCH_CONFIRM_MS;
          if (check.liq != null) {
            item.candidate = {
              ...item.candidate,
              initialLiquidityEth: check.liq,
            };
            if (item.peakLiq == null || check.liq > item.peakLiq) {
              item.peakLiq = check.liq;
            }
          }
          this.items.push(item);
          logLine(
            `DEFER CONFIRM ${item.candidate.symbol}: age ok liq=${check.liq?.toFixed(4) ?? "?"} — wait ${Math.round(config.LAUNCH_CONFIRM_MS / 1000)}s more`,
          );
          continue;
        }

        await this.executeAged(item, client, config, db, paper, live);
      }
    } finally {
      this.busy = false;
    }
  }

  private async liqStillHealthy(
    client: RhPublicClient,
    item: DeferredLaunch,
    config: AppConfig,
  ): Promise<{ ok: boolean; reason: string; liq: number | null }> {
    const { candidate } = item;
    if (candidate.dex !== "v2" && candidate.dex !== "v3") {
      return { ok: true, reason: "noxa", liq: candidate.initialLiquidityEth };
    }
    const liqNow = await rereadPoolLiquidityEth(client, candidate);
    if (liqNow == null && config.REJECT_NULL_LIQUIDITY) {
      return { ok: false, reason: "pool WETH unreadable", liq: null };
    }
    if (liqNow == null) {
      return { ok: true, reason: "liq unknown allowed", liq: null };
    }
    if (liqNow < config.MIN_LAUNCH_LIQUIDITY_ETH) {
      return {
        ok: false,
        reason: `liq ${liqNow.toFixed(4)} < min ${config.MIN_LAUNCH_LIQUIDITY_ETH} (likely rug)`,
        liq: liqNow,
      };
    }
    if (item.liqAtDetect != null) {
      const d = dropTooHard(
        item.liqAtDetect,
        liqNow,
        config.LAUNCH_LIQ_DROP_MAX_PCT,
      );
      if (d != null) {
        return {
          ok: false,
          reason: `WETH dropped ${d.toFixed(0)}% from detect (${item.liqAtDetect.toFixed(3)}→${liqNow.toFixed(3)})`,
          liq: liqNow,
        };
      }
    }
    if (item.peakLiq != null) {
      const d = dropTooHard(item.peakLiq, liqNow, config.LAUNCH_LIQ_DROP_MAX_PCT);
      if (d != null) {
        return {
          ok: false,
          reason: `WETH dropped ${d.toFixed(0)}% from peak (${item.peakLiq.toFixed(3)}→${liqNow.toFixed(3)})`,
          liq: liqNow,
        };
      }
    }
    return { ok: true, reason: "ok", liq: liqNow };
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
    const check = await this.liqStillHealthy(client, item, config);
    if (!check.ok) {
      logLine(`DEFER SKIP ${candidate.symbol}: after ${waitSec}s ${check.reason}`);
      return;
    }
    let next = candidate;
    if (check.liq != null) {
      next = { ...candidate, initialLiquidityEth: check.liq };
      logLine(
        `DEFER OK ${candidate.symbol}: survived ${waitSec}s liq=${check.liq.toFixed(4)} ETH (detect ${item.liqAtDetect?.toFixed(3) ?? "?"} peak ${item.peakLiq?.toFixed(3) ?? "?"})`,
      );
    } else {
      logLine(`DEFER OK ${candidate.symbol}: waited ${waitSec}s`);
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
      reasons: `deferred ${waitSec}s (${item.phase}); ${sellable.reason}; from signal #${item.signalId}`,
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

export const deferredLaunchQueue = new DeferredLaunchQueue();

import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { RhPublicClient } from "../chain/client.js";
import { quoteTokenPriceEth } from "../chain/pricing.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";
import type { CandidateToken } from "./filters.js";
import {
  checkSellableRoundtrip,
  rereadPoolLiquidityEth,
} from "./sellability.js";
import { fetchTokenMomentumExtras } from "../ingest/dexpaprika.js";
import type { ScoreExtras } from "../signals/score.js";

export interface DeferredLaunch {
  candidate: CandidateToken;
  /** Liquidity snapshot at first detect (for drop check). */
  liqAtDetect: number | null;
  /** Highest WETH seen during wait — reject if we give back from peak. */
  peakLiq: number | null;
  /** Mid price (ETH/token) at first successful quote during defer. */
  priceAtDetect: number | null;
  /** Highest mid price seen during wait. */
  peakPrice: number | null;
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

function gainPct(from: number, to: number): number {
  if (from <= 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Confirm-then-enter momentum gate.
 * Positive 15m Δ is mandatory; vol/buys are AND confirmers — never enough alone.
 * (OR-gate previously bought dumps like MEOW: Δ=-37% but vol/buys “ok”.)
 */
export function evaluateLaunchMomentum(
  extras: ScoreExtras,
  config: AppConfig,
): { ok: boolean; reason: string } {
  if (!config.REQUIRE_LAUNCH_MOMENTUM) {
    return { ok: true, reason: "momentum gate disabled" };
  }
  const vol = extras.volumeEth15m ?? 0;
  const buys = extras.uniqueBuyers ?? 0;
  const delta = extras.priceChange15mPct;
  const needDelta = config.LAUNCH_MOMENTUM_MIN_DELTA_PCT;
  const needVol = config.LAUNCH_MOMENTUM_MIN_VOL_ETH;
  const needBuys = config.LAUNCH_MOMENTUM_MIN_BUYS;

  if (needDelta <= 0 && needVol <= 0 && needBuys <= 0) {
    return { ok: true, reason: "momentum thresholds all 0" };
  }

  const parts: string[] = [];
  if (delta != null && Number.isFinite(delta)) {
    parts.push(`15mΔ=${delta.toFixed(1)}%`);
  } else {
    parts.push("15mΔ=n/a");
  }
  parts.push(`vol=${vol.toFixed(2)}ETH`);
  parts.push(`buys=${buys}`);
  const snap = parts.join(" ");

  // Hard dump guard — never buy known negative 15m even if vol thresholds are 0
  if (delta != null && Number.isFinite(delta) && delta < 0) {
    return {
      ok: false,
      reason: `momentum dump (${snap}; refuse negative 15m Δ)`,
    };
  }

  if (needDelta > 0) {
    if (delta == null || !Number.isFinite(delta)) {
      return {
        ok: false,
        reason: `momentum missing Δ (${snap}; need Δ≥${needDelta}% mandatory)`,
      };
    }
    if (delta < needDelta) {
      return {
        ok: false,
        reason: `momentum weak Δ (${snap}; need Δ≥${needDelta}% mandatory)`,
      };
    }
  }

  if (needVol > 0 && vol < needVol) {
    return {
      ok: false,
      reason: `momentum weak vol (${snap}; need vol≥${needVol}ETH AND Δ)`,
    };
  }
  if (needBuys > 0 && buys < needBuys) {
    return {
      ok: false,
      reason: `momentum weak buys (${snap}; need buys≥${needBuys} AND Δ)`,
    };
  }

  const how = [
    needDelta > 0 ? `Δ≥${needDelta}%` : null,
    needVol > 0 ? `vol≥${needVol}` : null,
    needBuys > 0 ? `buys≥${needBuys}` : null,
  ]
    .filter(Boolean)
    .join("+");
  return { ok: true, reason: `momentum ok (${how}; ${snap})` };
}

async function readMidPrice(
  client: RhPublicClient,
  candidate: CandidateToken,
): Promise<number | null> {
  return quoteTokenPriceEth(
    client,
    candidate.token,
    candidate.dex,
    candidate.pairOrPool,
    candidate.fee,
  );
}

/**
 * Non-blocking post-launch wait: enqueue BUYs, re-check liq+price+sellable when due.
 * Phase 1 = MIN_LAUNCH_AGE_MS; Phase 2 = LAUNCH_CONFIRM_MS stability window.
 * Strategy: confirm strength (price up + positive Δ), do not snipe “still alive”.
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
    client?: RhPublicClient | null,
  ): void {
    const enqueuedAt = Date.now();
    const readyAt = enqueuedAt + config.MIN_LAUNCH_AGE_MS;
    const key = candidate.token.toLowerCase();
    this.items = this.items.filter((x) => x.candidate.token.toLowerCase() !== key);
    const liq = candidate.initialLiquidityEth;
    const item: DeferredLaunch = {
      candidate,
      liqAtDetect: liq,
      peakLiq: liq,
      priceAtDetect: null,
      peakPrice: null,
      readyAt,
      signalId,
      enqueuedAt,
      phase: "age",
    };
    this.items.push(item);
    const waitSec = Math.round(config.MIN_LAUNCH_AGE_MS / 1000);
    const confSec = Math.round(config.LAUNCH_CONFIRM_MS / 1000);
    logLine(
      `DEFER BUY ${candidate.symbol} age=${waitSec}s` +
        (confSec > 0 ? `+confirm=${confSec}s` : "") +
        ` (liq=${liq?.toFixed(3) ?? "?"} ETH) signal=#${signalId} queue=${this.items.length}`,
    );
    if (client) {
      void this.snapshotPrice(client, item);
    }
  }

  private async snapshotPrice(
    client: RhPublicClient,
    item: DeferredLaunch,
  ): Promise<void> {
    try {
      const px = await readMidPrice(client, item.candidate);
      if (px == null || !(px > 0)) return;
      if (item.priceAtDetect == null) item.priceAtDetect = px;
      if (item.peakPrice == null || px > item.peakPrice) item.peakPrice = px;
    } catch {
      // best-effort; executeAged will fail closed if appreciation required
    }
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

          {
            const px = await readMidPrice(client, item.candidate);
            if (px != null && px > 0) {
              const fromPeak = item.peakPrice ?? item.priceAtDetect;
              if (fromPeak != null) {
                const d = dropTooHard(
                  fromPeak,
                  px,
                  config.LAUNCH_PRICE_DROP_MAX_PCT,
                );
                if (d != null) {
                  item.aborted = `mid-wait price drop ${d.toFixed(0)}% from peak`;
                  item.readyAt = now;
                  logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
                  continue;
                }
              }
              if (item.priceAtDetect != null) {
                const d = dropTooHard(
                  item.priceAtDetect,
                  px,
                  config.LAUNCH_PRICE_DROP_MAX_PCT,
                );
                if (d != null) {
                  item.aborted = `mid-wait price drop ${d.toFixed(0)}% from detect`;
                  item.readyAt = now;
                  logLine(`DEFER ABORT ${item.candidate.symbol}: ${item.aborted}`);
                  continue;
                }
              }
              if (item.priceAtDetect == null) item.priceAtDetect = px;
              if (item.peakPrice == null || px > item.peakPrice) {
                item.peakPrice = px;
              }
            }
          }

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
          if (item.priceAtDetect == null) {
            await this.snapshotPrice(client, item);
          }
          this.items.push(item);
          logLine(
            `DEFER CONFIRM ${item.candidate.symbol}: age ok liq=${check.liq?.toFixed(4) ?? "?"}` +
              (item.priceAtDetect != null
                ? ` px=${item.priceAtDetect.toExponential(3)}`
                : "") +
              ` — wait ${Math.round(config.LAUNCH_CONFIRM_MS / 1000)}s more`,
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

  private async assertOnchainAppreciation(
    client: RhPublicClient,
    item: DeferredLaunch,
    config: AppConfig,
  ): Promise<{ ok: boolean; reason: string }> {
    if (!config.REQUIRE_ONCHAIN_APPRECIATION) {
      return { ok: true, reason: "on-chain appreciation disabled" };
    }
    const need = config.LAUNCH_MIN_APPRECIATION_PCT;
    if (need <= 0) {
      return { ok: true, reason: "appreciation threshold 0" };
    }

    if (item.priceAtDetect == null) {
      await this.snapshotPrice(client, item);
    }
    const baseline = item.priceAtDetect;
    if (baseline == null || !(baseline > 0)) {
      return {
        ok: false,
        reason: "on-chain price missing at defer (fail closed — cannot confirm strength)",
      };
    }

    const nowPx = await readMidPrice(client, item.candidate);
    if (nowPx == null || !(nowPx > 0)) {
      return {
        ok: false,
        reason: "on-chain price unreadable at execute (fail closed)",
      };
    }

    const peak = item.peakPrice ?? baseline;
    const dropFromPeak = dropTooHard(peak, nowPx, config.LAUNCH_PRICE_DROP_MAX_PCT);
    if (dropFromPeak != null) {
      return {
        ok: false,
        reason: `on-chain giveback ${dropFromPeak.toFixed(0)}% from peak during defer`,
      };
    }
    if (item.peakPrice == null || nowPx > item.peakPrice) {
      item.peakPrice = nowPx;
    }

    const g = gainPct(baseline, nowPx);
    if (g < need) {
      return {
        ok: false,
        reason: `on-chain flat/down (${g.toFixed(1)}% vs need +${need}% from defer quote)`,
      };
    }
    return {
      ok: true,
      reason: `on-chain up +${g.toFixed(1)}% during defer (need ≥${need}%)`,
    };
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

    // Stricter entry floor after age+confirm (paper moons ~8–15 ETH; rugs often ~3–5)
    const entryMin =
      config.MIN_LAUNCH_ENTRY_LIQUIDITY_ETH > 0
        ? config.MIN_LAUNCH_ENTRY_LIQUIDITY_ETH
        : config.MIN_LAUNCH_LIQUIDITY_ETH;
    if (
      next.initialLiquidityEth != null &&
      next.initialLiquidityEth < entryMin
    ) {
      logLine(
        `DEFER SKIP ${next.symbol}: entry liq ${next.initialLiquidityEth.toFixed(4)} < min entry ${entryMin}`,
      );
      return;
    }

    const appre = await this.assertOnchainAppreciation(client, item, config);
    if (!appre.ok) {
      logLine(`DEFER SKIP ${next.symbol}: ${appre.reason}`);
      return;
    }
    logLine(`DEFER ${next.symbol}: ${appre.reason}`);

    const sellable = await checkSellableRoundtrip(client, next, config);
    if (!sellable.ok) {
      logLine(`DEFER SKIP ${next.symbol}: ${sellable.reason}`);
      return;
    }
    logLine(`DEFER ${next.symbol}: ${sellable.reason}`);

    // DexPaprika: mandatory positive Δ + AND confirmers
    let momReason = "momentum skipped";
    if (config.REQUIRE_LAUNCH_MOMENTUM) {
      const extras = await fetchTokenMomentumExtras(next.token);
      const mom = evaluateLaunchMomentum(extras, config);
      momReason = mom.reason;
      if (!mom.ok) {
        logLine(`DEFER SKIP ${next.symbol}: ${mom.reason}`);
        return;
      }
      logLine(`DEFER ${next.symbol}: ${mom.reason}`);
    }

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
      reasons: `deferred ${waitSec}s (${item.phase}); ${appre.reason}; ${sellable.reason}; ${momReason}; from signal #${item.signalId}`,
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

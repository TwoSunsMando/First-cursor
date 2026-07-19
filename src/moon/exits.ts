import type { AppConfig } from "../config.js";
import type { PositionRow } from "../db/schema.js";

export type MoonAction =
  | { kind: "none" }
  | {
      kind: "trim";
      /** Fraction of original position to sell (0–1) */
      fractionOfOriginal: number;
      trimBit: number;
      reason: string;
      armBreakeven: boolean;
    }
  | { kind: "close"; reason: string };

const TRIM_PLAN: Array<{
  bit: number;
  pnlPct: (cfg: AppConfig) => number;
  fraction: (cfg: AppConfig) => number;
  label: string;
  armBreakeven: boolean;
}> = [
  {
    bit: 0,
    pnlPct: (c) => c.TAKE_PROFIT_PERCENT,
    fraction: (c) => c.MOON_TRIM_TP_PCT / 100,
    label: "moon_trim_tp",
    armBreakeven: true,
  },
  {
    bit: 1,
    pnlPct: (c) => c.MOON_TRIM_2X_PCT_TRIGGER,
    fraction: (c) => c.MOON_TRIM_2X_PCT / 100,
    label: "moon_trim_2x",
    armBreakeven: true,
  },
  {
    bit: 2,
    pnlPct: (c) => c.MOON_TRIM_5X_PCT_TRIGGER,
    fraction: (c) => c.MOON_TRIM_5X_PCT / 100,
    label: "moon_trim_5x",
    armBreakeven: true,
  },
  {
    bit: 3,
    pnlPct: (c) => c.MOON_TRIM_10X_PCT_TRIGGER,
    fraction: (c) => c.MOON_TRIM_10X_PCT / 100,
    label: "moon_trim_10x",
    armBreakeven: true,
  },
];

/**
 * Decide next moon-book action: scale-out trim, trail/stop close, or hold.
 * Peak should already be updated by the caller.
 */
export function decideMoonExit(
  pos: PositionRow,
  price: number,
  pnlPct: number,
  holdMin: number,
  config: AppConfig,
): MoonAction {
  const peak = Math.max(pos.peak_price_eth || pos.entry_price_eth, price);
  const peakPnlPct =
    pos.entry_price_eth > 0
      ? ((peak - pos.entry_price_eth) / pos.entry_price_eth) * 100
      : 0;
  const mask = pos.moon_trim_mask ?? 0;
  const breakeven = (pos.breakeven_stop ?? 0) > 0 || (mask & 1) !== 0;

  // Hard stop before first trim — same as scout
  if (!breakeven && pnlPct <= -config.STOP_LOSS_PERCENT) {
    return { kind: "close", reason: `moon_stop_loss ${pnlPct.toFixed(1)}%` };
  }

  // After first trim: floor at entry
  if (breakeven && pnlPct <= 0) {
    return { kind: "close", reason: `moon_breakeven_stop ${pnlPct.toFixed(1)}%` };
  }

  // Trail from peak once armed (gave back MOON_TRAIL_GIVEBACK_PCT from peak PnL)
  if (breakeven && peakPnlPct > config.TAKE_PROFIT_PERCENT) {
    const giveback = peakPnlPct - pnlPct;
    if (giveback >= config.MOON_TRAIL_GIVEBACK_PCT) {
      return {
        kind: "close",
        reason: `moon_trail peak=${peakPnlPct.toFixed(0)}% now=${pnlPct.toFixed(0)}% giveback=${giveback.toFixed(0)}%`,
      };
    }
  }

  // Optional long max hold for moons (0 = disabled)
  if (
    config.MOON_MAX_HOLD_MINUTES > 0 &&
    holdMin >= config.MOON_MAX_HOLD_MINUTES
  ) {
    return {
      kind: "close",
      reason: `moon_max_hold ${holdMin.toFixed(0)}m pnl=${pnlPct.toFixed(1)}%`,
    };
  }

  // Scale-out buckets (of original size)
  for (const step of TRIM_PLAN) {
    const frac = step.fraction(config);
    if (frac <= 0) continue;
    if ((mask & (1 << step.bit)) !== 0) continue;
    if (pnlPct < step.pnlPct(config)) continue;

    // Don't trim more than remaining as fraction of original
    const original = pos.original_size_eth || pos.size_eth;
    const remainingFrac = original > 0 ? pos.size_eth / original : 0;
    if (remainingFrac <= 0.02) {
      return { kind: "close", reason: `moon_dust ${pnlPct.toFixed(1)}%` };
    }
    const sellFrac = Math.min(frac, remainingFrac);

    return {
      kind: "trim",
      fractionOfOriginal: sellFrac,
      trimBit: step.bit,
      reason: `${step.label} ${pnlPct.toFixed(1)}% sell=${(sellFrac * 100).toFixed(0)}%`,
      armBreakeven: step.armBreakeven,
    };
  }

  return { kind: "none" };
}

export function decideScoutExit(
  pnlPct: number,
  holdMin: number,
  config: AppConfig,
): { reason: string } | null {
  if (pnlPct >= config.TAKE_PROFIT_PERCENT) {
    return { reason: `take_profit ${pnlPct.toFixed(1)}%` };
  }
  if (pnlPct <= -config.STOP_LOSS_PERCENT) {
    return { reason: `stop_loss ${pnlPct.toFixed(1)}%` };
  }
  if (holdMin >= config.MAX_HOLD_MINUTES) {
    return { reason: `max_hold ${holdMin.toFixed(0)}m pnl=${pnlPct.toFixed(1)}%` };
  }
  return null;
}

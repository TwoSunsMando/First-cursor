import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";

const KEYS = {
  takeProfit: "runtime.take_profit_percent",
  stopLoss: "runtime.stop_loss_percent",
  maxHold: "runtime.max_hold_minutes",
  maxOpen: "runtime.max_open_positions",
} as const;

export interface RuntimeTradeParams {
  TAKE_PROFIT_PERCENT: number;
  STOP_LOSS_PERCENT: number;
  MAX_HOLD_MINUTES: number;
  MAX_OPEN_POSITIONS: number;
}

/** Read overrides from DB meta and mutate the live config object in place. */
export function applyRuntimeOverrides(db: BotDb, config: AppConfig): RuntimeTradeParams {
  const tp = numOr(db.getMeta(KEYS.takeProfit), config.TAKE_PROFIT_PERCENT);
  const sl = numOr(db.getMeta(KEYS.stopLoss), config.STOP_LOSS_PERCENT);
  const hold = intOr(db.getMeta(KEYS.maxHold), config.MAX_HOLD_MINUTES);
  const maxOpen = clampInt(numOr(db.getMeta(KEYS.maxOpen), config.MAX_OPEN_POSITIONS), 1, 5);

  config.TAKE_PROFIT_PERCENT = tp;
  config.STOP_LOSS_PERCENT = sl;
  config.MAX_HOLD_MINUTES = hold;
  config.MAX_OPEN_POSITIONS = maxOpen;

  return {
    TAKE_PROFIT_PERCENT: tp,
    STOP_LOSS_PERCENT: sl,
    MAX_HOLD_MINUTES: hold,
    MAX_OPEN_POSITIONS: maxOpen,
  };
}

export function getRuntimeTradeParams(db: BotDb, config: AppConfig): RuntimeTradeParams {
  return applyRuntimeOverrides(db, config);
}

export function setRuntimeTradeParams(
  db: BotDb,
  config: AppConfig,
  patch: Partial<RuntimeTradeParams>,
): RuntimeTradeParams {
  if (patch.TAKE_PROFIT_PERCENT != null) {
    const v = clampNum(patch.TAKE_PROFIT_PERCENT, 1, 10_000);
    db.setMeta(KEYS.takeProfit, String(v));
  }
  if (patch.STOP_LOSS_PERCENT != null) {
    const v = clampNum(patch.STOP_LOSS_PERCENT, 1, 99);
    db.setMeta(KEYS.stopLoss, String(v));
  }
  if (patch.MAX_HOLD_MINUTES != null) {
    const v = clampInt(patch.MAX_HOLD_MINUTES, 1, 10_080);
    db.setMeta(KEYS.maxHold, String(v));
  }
  if (patch.MAX_OPEN_POSITIONS != null) {
    const v = clampInt(patch.MAX_OPEN_POSITIONS, 1, 5);
    db.setMeta(KEYS.maxOpen, String(v));
  }
  return applyRuntimeOverrides(db, config);
}

function numOr(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function intOr(raw: string | undefined, fallback: number): number {
  return Math.round(numOr(raw, fallback));
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampInt(n: number, min: number, max: number): number {
  return Math.round(clampNum(n, min, max));
}

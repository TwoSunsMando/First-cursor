import type { Address } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb, DexKind, PositionRow } from "../db/schema.js";

export interface CandidateToken {
  token: Address;
  symbol: string;
  name: string;
  dex: DexKind;
  pairOrPool: Address;
  fee: number | null;
  initialLiquidityEth: number | null;
  txHash: `0x${string}` | null;
  source: string;
}

export interface RiskResult {
  ok: boolean;
  reasons: string[];
}

function formatDuration(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.ceil(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.ceil(hr / 24)}d`;
}

function evaluateClosedTrade(
  last: PositionRow,
  stopStreak: number,
  config: AppConfig,
  scopeLabel: string,
): string | null {
  if (!last.closed_at) return null;
  const closedAt = Date.parse(last.closed_at);
  if (!Number.isFinite(closedAt)) return null;
  const ageMs = Date.now() - closedAt;
  const isStop = (last.exit_reason ?? "").startsWith("stop_loss");
  const pnl = last.pnl_pct ?? 0;
  const hardLoss = pnl <= -50 || (last.exit_reason ?? "").includes("-100");
  const streakHit = stopStreak >= config.REENTRY_STOP_STREAK;

  let cooldownMs = 0;
  let why = "";

  if (hardLoss || streakHit) {
    cooldownMs = config.REENTRY_AFTER_HARD_LOSS_MS;
    why = hardLoss
      ? `hard loss ${pnl.toFixed(1)}% on #${last.id}`
      : `${stopStreak}x stop-loss streak`;
  } else if (isStop) {
    cooldownMs = config.REENTRY_AFTER_STOP_MS;
    why = `stop-loss on #${last.id} (${pnl.toFixed(1)}%)`;
  } else if (pnl < 0) {
    cooldownMs = Math.min(config.REENTRY_AFTER_STOP_MS, 2 * 60 * 60 * 1000);
    why = `losing exit on #${last.id} (${pnl.toFixed(1)}%)`;
  } else {
    return null;
  }

  if (cooldownMs <= 0 || ageMs >= cooldownMs) return null;
  const left = formatDuration(cooldownMs - ageMs);
  return `re-entry blocked for ${scopeLabel} — ${why}; wait ${left}`;
}

/** Why we should not reopen this token right now (stop-loss churn guard). */
export function getReentryBlock(
  token: Address,
  symbol: string,
  config: AppConfig,
  db: BotDb,
  mode: "paper" | "live",
): string | null {
  if (config.REENTRY_AFTER_STOP_MS <= 0 && config.REENTRY_AFTER_HARD_LOSS_MS <= 0) {
    return null;
  }

  const windowMs = Math.max(config.REENTRY_AFTER_HARD_LOSS_MS, config.REENTRY_AFTER_STOP_MS);
  const streakSince = new Date(Date.now() - windowMs).toISOString();

  // 1) Exact contract cooldown
  const byToken = db.getLastClosedPosition(token, mode);
  if (byToken) {
    const streak = db.countRecentStopLosses(token, mode, streakSince);
    const msg = evaluateClosedTrade(byToken, streak, config, symbol || token.slice(0, 10));
    if (msg) return msg;
  }

  // 2) Same ticker cooldown (blocks copycat contracts named Jimothy / STOCKCAT)
  const sym = symbol.trim();
  if (sym && sym !== "???") {
    const bySym = db.getLastClosedBySymbol(sym, mode);
    if (bySym && bySym.token.toLowerCase() !== token.toLowerCase()) {
      const streak = db.countRecentStopLossesBySymbol(sym, mode, streakSince);
      const msg = evaluateClosedTrade(
        bySym,
        streak,
        config,
        `${sym} (ticker match, different contract)`,
      );
      if (msg) return msg;
    } else if (bySym) {
      const streak = db.countRecentStopLossesBySymbol(sym, mode, streakSince);
      const msg = evaluateClosedTrade(bySym, streak, config, sym);
      if (msg) return msg;
    }
  }

  return null;
}

export function applyRiskFilters(
  candidate: CandidateToken,
  config: AppConfig,
  db: BotDb,
  mode: "paper" | "live",
): RiskResult {
  const reasons: string[] = [];

  const blob = `${candidate.name} ${candidate.symbol}`.toLowerCase();
  for (const deny of config.denyNameSubstrings) {
    if (deny && blob.includes(deny)) {
      reasons.push(`deny-list matched "${deny}"`);
    }
  }

  if (
    candidate.initialLiquidityEth !== null &&
    candidate.initialLiquidityEth < config.MIN_INITIAL_LIQUIDITY_ETH
  ) {
    reasons.push(
      `liquidity ${candidate.initialLiquidityEth.toFixed(4)} ETH < min ${config.MIN_INITIAL_LIQUIDITY_ETH}`,
    );
  }

  if (db.hasOpenPositionForToken(candidate.token, mode)) {
    reasons.push("already have open position for token");
  }

  if (db.countOpenPositions(mode) >= config.MAX_OPEN_POSITIONS) {
    reasons.push(`max open positions reached (${config.MAX_OPEN_POSITIONS})`);
  }

  const reentry = getReentryBlock(
    candidate.token,
    candidate.symbol,
    config,
    db,
    mode,
  );
  if (reentry) reasons.push(reentry);

  return { ok: reasons.length === 0, reasons };
}

/** Exposed for tests / CLI explainers */
export type { PositionRow };

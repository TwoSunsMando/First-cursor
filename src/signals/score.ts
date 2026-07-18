import type { CandidateToken } from "../risk/filters.js";
import type { SignalAction } from "../db/schema.js";

export interface ScoredSignal {
  score: number;
  action: SignalAction;
  reasons: string[];
}

export interface ScoreThresholds {
  buy: number;
  watch: number;
}

export interface ScoreExtras {
  volumeEth15m?: number;
  uniqueBuyers?: number;
  volumeUsd24h?: number;
  priceChange1hPct?: number | null;
  priceChange15mPct?: number | null;
  txns24h?: number;
}

export const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = {
  buy: 45,
  watch: 35,
};

/**
 * Heuristic scorer.
 * Weights: source, liquidity, 15m volume, buyers, and short-window boosts.
 */
export function scoreCandidate(
  candidate: CandidateToken,
  extras: ScoreExtras = {},
  thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS,
): ScoredSignal {
  const reasons: string[] = [];
  let score = 0;

  if (candidate.source === "noxa") {
    score += 35;
    reasons.push("NOXA launch (+35)");
  } else if (candidate.source === "boost") {
    score += 30;
    reasons.push("recent boost (+30)");
  } else if (candidate.source === "trending") {
    score += 25;
    reasons.push("trending list (+25)");
  } else if (candidate.dex === "v3") {
    score += 20;
    reasons.push("Uniswap V3 pool (+20)");
  } else {
    score += 15;
    reasons.push("Uniswap V2 pair (+15)");
  }

  const liq = candidate.initialLiquidityEth ?? 0;
  if (liq >= 1) {
    score += 25;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+25)`);
  } else if (liq >= 0.25) {
    score += 15;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+15)`);
  } else if (liq >= 0.05) {
    score += 8;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+8)`);
  } else if (liq > 0) {
    score += 2;
    reasons.push(`thin liquidity ${liq.toFixed(4)} ETH (+2)`);
  } else {
    reasons.push("liquidity unknown (0)");
  }

  const vol = extras.volumeEth15m ?? 0;
  if (vol >= 5) {
    score += 25;
    reasons.push(`15m vol ${vol.toFixed(2)} ETH (+25)`);
  } else if (vol >= 1) {
    score += 15;
    reasons.push(`15m vol ${vol.toFixed(2)} ETH (+15)`);
  } else if (vol >= 0.2) {
    score += 8;
    reasons.push(`15m vol ${vol.toFixed(2)} ETH (+8)`);
  }

  const buyers = extras.uniqueBuyers ?? 0;
  if (buyers >= 20) {
    score += 15;
    reasons.push(`buys ${buyers} (+15)`);
  } else if (buyers >= 5) {
    score += 8;
    reasons.push(`buys ${buyers} (+8)`);
  }

  const chg15 = extras.priceChange15mPct;
  if (chg15 != null && Number.isFinite(chg15)) {
    if (chg15 >= 25) {
      score += 12;
      reasons.push(`15m Δ +${chg15.toFixed(1)}% (+12)`);
    } else if (chg15 >= 10) {
      score += 6;
      reasons.push(`15m Δ +${chg15.toFixed(1)}% (+6)`);
    } else if (chg15 <= -40) {
      score -= 8;
      reasons.push(`15m Δ ${chg15.toFixed(1)}% (-8 dump)`);
    }
  }

  const vol24 = extras.volumeUsd24h ?? 0;
  if (vol24 >= 1_000_000) {
    score += 8;
    reasons.push(`24h vol $${(vol24 / 1e6).toFixed(2)}M (+8)`);
  } else if (vol24 >= 100_000) {
    score += 4;
    reasons.push(`24h vol $${(vol24 / 1e3).toFixed(0)}k (+4)`);
  }

  let action: SignalAction = "SKIP";
  if (score >= thresholds.buy) action = "BUY";
  else if (score >= thresholds.watch) action = "WATCH";

  reasons.push(
    `final score=${score} → ${action} (buy≥${thresholds.buy}, watch≥${thresholds.watch})`,
  );
  return { score, action, reasons };
}

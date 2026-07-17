import type { CandidateToken } from "../risk/filters.js";
import type { SignalAction } from "../db/schema.js";

export interface ScoredSignal {
  score: number;
  action: SignalAction;
  reasons: string[];
}

/**
 * Simple heuristic scorer for v1.
 * Weights: launch source, liquidity, and early volume velocity (if provided).
 */
export function scoreCandidate(
  candidate: CandidateToken,
  extras?: { volumeEth15m?: number; uniqueBuyers?: number },
): ScoredSignal {
  const reasons: string[] = [];
  let score = 0;

  if (candidate.source === "noxa") {
    score += 35;
    reasons.push("NOXA launch (+35)");
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

  const vol = extras?.volumeEth15m ?? 0;
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

  const buyers = extras?.uniqueBuyers ?? 0;
  if (buyers >= 20) {
    score += 15;
    reasons.push(`buyers ${buyers} (+15)`);
  } else if (buyers >= 5) {
    score += 8;
    reasons.push(`buyers ${buyers} (+8)`);
  }

  let action: SignalAction = "SKIP";
  if (score >= 55) action = "BUY";
  else if (score >= 35) action = "WATCH";

  reasons.push(`final score=${score} → ${action}`);
  return { score, action, reasons };
}

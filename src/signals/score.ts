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

export interface ScoreWeights {
  /** Scale for volume/buys/Δ/24h-vol when source is trending or boost (0–1). */
  trendingMomentumScale: number;
}

export const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = {
  buy: 40,
  watch: 32,
};

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  trendingMomentumScale: 0.55,
};

function isTrendingSource(source: string): boolean {
  return source === "trending" || source === "boost";
}

/**
 * Heuristic scorer.
 * Trending/boost get a modest base bonus; momentum extras are scaled down
 * so new-pool launches can still compete for paper slots.
 */
export function scoreCandidate(
  candidate: CandidateToken,
  extras: ScoreExtras = {},
  thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): ScoredSignal {
  const reasons: string[] = [];
  let score = 0;
  const trending = isTrendingSource(candidate.source);
  const momScale = trending
    ? Math.max(0, Math.min(1, weights.trendingMomentumScale))
    : 1;

  if (candidate.source === "noxa") {
    score += 35;
    reasons.push("NOXA launch (+35)");
  } else if (candidate.source === "boost") {
    score += 16;
    reasons.push("recent boost (+16)");
  } else if (candidate.source === "trending") {
    score += 14;
    reasons.push("trending list (+14)");
  } else if (candidate.dex === "v3") {
    score += 20;
    reasons.push("Uniswap V3 pool (+20)");
  } else {
    score += 15;
    reasons.push("Uniswap V2 pair (+15)");
  }

  const liq = candidate.initialLiquidityEth ?? 0;
  if (liq >= 1) {
    const liqPts = trending ? 18 : 25; // soft cap for mega-liquid trending majors
    score += liqPts;
    reasons.push(
      `liquidity ${liq.toFixed(3)} ETH (+${liqPts}${trending ? " trending-capped" : ""})`,
    );
  } else if (liq >= 0.25) {
    const liqPts = trending ? 10 : 15;
    score += liqPts;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+${liqPts})`);
  } else if (liq >= 0.05) {
    const liqPts = trending ? 6 : 8;
    score += liqPts;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+${liqPts})`);
  } else if (liq > 0) {
    score += 2;
    reasons.push(`thin liquidity ${liq.toFixed(4)} ETH (+2)`);
  } else {
    reasons.push("liquidity unknown (0)");
  }

  const addMom = (pts: number, label: string) => {
    // ceil for positive momentum so ×0.55 doesn't crush mid-tier signals to noise
    let scaled = trending ? Math.ceil(pts * momScale) : pts;
    if (pts > 0 && scaled < 1) scaled = 1;
    score += scaled;
    if (trending && scaled !== pts) {
      reasons.push(`${label} → +${scaled} (×${momScale})`);
    } else {
      reasons.push(`${label} (+${scaled})`);
    }
  };

  const vol = extras.volumeEth15m ?? 0;
  if (vol >= 5) addMom(25, `15m vol ${vol.toFixed(2)} ETH`);
  else if (vol >= 1) addMom(15, `15m vol ${vol.toFixed(2)} ETH`);
  else if (vol >= 0.2) addMom(8, `15m vol ${vol.toFixed(2)} ETH`);

  const buyers = extras.uniqueBuyers ?? 0;
  if (buyers >= 20) addMom(15, `buys ${buyers}`);
  else if (buyers >= 5) addMom(8, `buys ${buyers}`);

  const chg15 = extras.priceChange15mPct;
  if (chg15 != null && Number.isFinite(chg15)) {
    if (chg15 >= 25) addMom(12, `15m Δ +${chg15.toFixed(1)}%`);
    else if (chg15 >= 10) addMom(6, `15m Δ +${chg15.toFixed(1)}%`);
    else if (chg15 <= -25) {
      // Dumps: full penalty even for trending (don't scale down risk)
      const pen = chg15 <= -40 ? -12 : -8;
      score += pen;
      reasons.push(`15m Δ ${chg15.toFixed(1)}% (${pen} dump)`);
    }
  }

  const vol24 = extras.volumeUsd24h ?? 0;
  if (vol24 >= 1_000_000) addMom(8, `24h vol $${(vol24 / 1e6).toFixed(2)}M`);
  else if (vol24 >= 100_000) addMom(4, `24h vol $${(vol24 / 1e3).toFixed(0)}k`);

  let action: SignalAction = "SKIP";
  if (score >= thresholds.buy) action = "BUY";
  else if (score >= thresholds.watch) action = "WATCH";

  reasons.push(
    `final score=${score} → ${action} (buy≥${thresholds.buy}, watch≥${thresholds.watch})`,
  );
  return { score, action, reasons };
}

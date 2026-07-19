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
  preferredLiqMinEth?: number;
  preferredLiqMaxEth?: number;
  lateEntryVolEth15m?: number;
  lateEntryBuys?: number;
  /** Min WETH for launch sources to count as confirming edge. */
  minLaunchLiqEth?: number;
}

export const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = {
  buy: 40,
  watch: 32,
};

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  trendingMomentumScale: 0.55,
  preferredLiqMinEth: 5,
  preferredLiqMaxEth: 50,
  lateEntryVolEth15m: 12,
  lateEntryBuys: 45,
};

function isTrendingSource(source: string): boolean {
  return source === "trending" || source === "boost";
}

/**
 * Confirming edge for BUY — raw high score alone is not enough.
 * Overnight: boost + mid-liq + moderate momentum won; mega-liq trending lost.
 */
export function hasConfirmingEdge(
  candidate: CandidateToken,
  extras: ScoreExtras = {},
  weights: Pick<
    ScoreWeights,
    | "preferredLiqMinEth"
    | "preferredLiqMaxEth"
    | "lateEntryVolEth15m"
    | "lateEntryBuys"
    | "minLaunchLiqEth"
  > = {},
): { ok: boolean; reason: string } {
  const liqMin = weights.preferredLiqMinEth ?? 5;
  const liqMax = weights.preferredLiqMaxEth ?? 50;
  const lateVol = weights.lateEntryVolEth15m ?? 12;
  const lateBuys = weights.lateEntryBuys ?? 45;
  const launchMin = weights.minLaunchLiqEth ?? 0.5;
  const liq = candidate.initialLiquidityEth;
  const vol = extras.volumeEth15m ?? 0;
  const buys = extras.uniqueBuyers ?? 0;
  const src = candidate.source;

  // Boost still confirms (DexPaprika already saw activity).
  if (src === "boost") {
    return { ok: true, reason: "confirming source=boost" };
  }

  // Launch sources must prove real WETH — not a free pass for thin rugs.
  if (src === "noxa" || src === "uniswap_v2" || src === "uniswap_v3") {
    if (liq == null) {
      return { ok: false, reason: `launch ${src}: liquidity unknown` };
    }
    if (liq < launchMin) {
      return {
        ok: false,
        reason: `launch ${src}: liq ${liq.toFixed(3)} ETH < ${launchMin}`,
      };
    }
    return {
      ok: true,
      reason: `confirming launch ${src} liq=${liq.toFixed(3)} ETH`,
    };
  }

  if (liq != null && liq >= liqMin && liq < liqMax) {
    return { ok: true, reason: `confirming mid-liq ${liq.toFixed(1)} ETH` };
  }

  // Moderate momentum (not late blow-off)
  const volOk = vol >= 0.5 && (lateVol <= 0 || vol < lateVol);
  const buysOk = buys >= 3 && (lateBuys <= 0 || buys < lateBuys);
  if (volOk && buysOk) {
    return {
      ok: true,
      reason: `confirming moderate momentum vol=${vol.toFixed(1)} buys=${buys}`,
    };
  }

  return {
    ok: false,
    reason:
      "no confirming edge (need boost, launch+liq, mid-liq 5–50, or moderate 15m momentum)",
  };
}

/**
 * Heuristic scorer.
 * Prefers mid liquidity and moderate momentum; demotes mega-liq / late blow-offs.
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
  const liqMin = weights.preferredLiqMinEth ?? 5;
  const liqMax = weights.preferredLiqMaxEth ?? 50;
  const lateVol = weights.lateEntryVolEth15m ?? 12;
  const lateBuys = weights.lateEntryBuys ?? 45;

  if (candidate.source === "noxa") {
    // Thin NOXA seeds were a major instant-rug path — don't auto-BUY on name alone.
    const noxaLiq = candidate.initialLiquidityEth ?? 0;
    const noxaPts = noxaLiq >= 1 ? 28 : noxaLiq >= 0.5 ? 22 : 12;
    score += noxaPts;
    reasons.push(`NOXA launch (+${noxaPts}${noxaLiq < 0.5 ? " thin" : ""})`);
  } else if (candidate.source === "boost") {
    score += 18;
    reasons.push("recent boost (+18)");
  } else if (candidate.source === "trending") {
    score += 12;
    reasons.push("trending list (+12)");
  } else if (candidate.dex === "v3") {
    score += 20;
    reasons.push("Uniswap V3 pool (+20)");
  } else {
    score += 15;
    reasons.push("Uniswap V2 pair (+15)");
  }

  const liq = candidate.initialLiquidityEth ?? 0;
  if (liq >= liqMax) {
    // Mega-liq: overnight losers on trending majors — soft points only
    const liqPts = trending ? 4 : 10;
    score += liqPts;
    reasons.push(
      `liquidity ${liq.toFixed(2)} ETH mega (≥${liqMax}) (+${liqPts}${trending ? " skeptical" : ""})`,
    );
  } else if (liq >= liqMin) {
    // Sweet spot from overnight training
    const liqPts = candidate.source === "boost" ? 26 : trending ? 22 : 28;
    score += liqPts;
    reasons.push(`liquidity ${liq.toFixed(2)} ETH mid sweet-spot (+${liqPts})`);
  } else if (liq >= 1) {
    const liqPts = trending ? 14 : 20;
    score += liqPts;
    reasons.push(`liquidity ${liq.toFixed(3)} ETH (+${liqPts})`);
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
    let scaled = trending ? Math.ceil(pts * momScale) : pts;
    if (pts > 0 && scaled < 1) scaled = 1;
    if (pts < 0 && trending) scaled = pts; // full late/dump penalties
    score += scaled;
    if (trending && scaled !== pts && pts > 0) {
      reasons.push(`${label} → +${scaled} (×${momScale})`);
    } else {
      reasons.push(`${label} (${scaled >= 0 ? "+" : ""}${scaled})`);
    }
  };

  const vol = extras.volumeEth15m ?? 0;
  if (lateVol > 0 && vol >= lateVol) {
    addMom(-10, `15m vol ${vol.toFixed(2)} ETH late-entry`);
  } else if (vol >= 5) {
    // Hot but not blow-off — smaller bonus than before
    addMom(10, `15m vol ${vol.toFixed(2)} ETH elevated`);
  } else if (vol >= 1) {
    addMom(15, `15m vol ${vol.toFixed(2)} ETH`);
  } else if (vol >= 0.2) {
    addMom(8, `15m vol ${vol.toFixed(2)} ETH`);
  }

  const buyers = extras.uniqueBuyers ?? 0;
  if (lateBuys > 0 && buyers >= lateBuys) {
    addMom(-8, `buys ${buyers} late-entry`);
  } else if (buyers >= 20) {
    addMom(10, `buys ${buyers}`);
  } else if (buyers >= 5) {
    addMom(8, `buys ${buyers}`);
  }

  const chg15 = extras.priceChange15mPct;
  if (chg15 != null && Number.isFinite(chg15)) {
    if (chg15 >= 80) {
      // Parabolic — often late
      addMom(-6, `15m Δ +${chg15.toFixed(1)}% parabolic`);
    } else if (chg15 >= 25) addMom(12, `15m Δ +${chg15.toFixed(1)}%`);
    else if (chg15 >= 10) addMom(6, `15m Δ +${chg15.toFixed(1)}%`);
    else if (chg15 <= -25) {
      const pen = chg15 <= -40 ? -12 : -8;
      score += pen;
      reasons.push(`15m Δ ${chg15.toFixed(1)}% (${pen} dump)`);
    }
  }

  const vol24 = extras.volumeUsd24h ?? 0;
  if (vol24 >= 1_000_000) addMom(4, `24h vol $${(vol24 / 1e6).toFixed(2)}M`);
  else if (vol24 >= 100_000) addMom(4, `24h vol $${(vol24 / 1e3).toFixed(0)}k`);

  let action: SignalAction = "SKIP";
  if (score >= thresholds.buy) action = "BUY";
  else if (score >= thresholds.watch) action = "WATCH";

  reasons.push(
    `final score=${score} → ${action} (buy≥${thresholds.buy}, watch≥${thresholds.watch})`,
  );
  return { score, action, reasons };
}

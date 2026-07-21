import type { AppConfig } from "../config.js";
import type { BotDb, PositionRow } from "../db/schema.js";
import type { ScoreExtras } from "../signals/score.js";

const LAUNCH_SOURCES = new Set(["noxa", "uniswap_v2", "uniswap_v3"]);

export interface MoonEval {
  promote: boolean;
  score: number;
  reasons: string[];
}

/**
 * Upgrade an already-open scout position to moon (runner) book.
 * Entry timing is unchanged — this only changes exits after we're in.
 */
export function evaluateMoonUpgrade(
  pos: PositionRow,
  source: string | null,
  pnlPct: number,
  holdMin: number,
  extras: ScoreExtras,
  config: AppConfig,
  db: BotDb,
  mode: "paper" | "live",
): MoonEval {
  const reasons: string[] = [];
  let score = 0;

  if (!config.MOON_ENABLED) {
    return { promote: false, score: 0, reasons: ["moon disabled"] };
  }
  if ((pos.book ?? "scout") === "moon") {
    return { promote: false, score: 0, reasons: ["already moon"] };
  }
  if (db.countOpenMoonPositions(mode) >= config.MAX_MOON_POSITIONS) {
    return {
      promote: false,
      score: 0,
      reasons: [`moon slot cap (${config.MAX_MOON_POSITIONS})`],
    };
  }

  const src = (source ?? "").toLowerCase();
  const isLaunch = LAUNCH_SOURCES.has(src);
  if (isLaunch) {
    score += 2;
    reasons.push(`launch source=${src}`);
  } else if (src === "boost") {
    score += 1;
    reasons.push("boost source");
  } else if (src === "trending") {
    // Trending entries are usually late — rarely promote
    reasons.push("trending source (weak for moon)");
  } else if (src) {
    reasons.push(`source=${src}`);
  }

  if (holdMin > config.MOON_MAX_AGE_MINUTES) {
    return {
      promote: false,
      score,
      reasons: [...reasons, `too old for moon upgrade (${holdMin.toFixed(0)}m)`],
    };
  }

  if (pnlPct < config.MOON_ARM_PNL_PCT) {
    return {
      promote: false,
      score,
      reasons: [
        ...reasons,
        `pnl ${pnlPct.toFixed(1)}% < arm ${config.MOON_ARM_PNL_PCT}%`,
      ],
    };
  }
  score += 1;
  reasons.push(`early strength +${pnlPct.toFixed(1)}%`);

  if (pnlPct >= config.MOON_ARM_STRONG_PNL_PCT) {
    score += 1;
    reasons.push(`strong arm +${pnlPct.toFixed(1)}%`);
  }

  const vol = extras.volumeEth15m ?? 0;
  const buys = extras.uniqueBuyers ?? 0;
  const chg = extras.priceChange15mPct;
  const lateVol = config.LATE_ENTRY_VOL_ETH_15M;
  const lateBuys = config.LATE_ENTRY_BUYS;

  if (vol >= 0.3 && (lateVol <= 0 || vol < lateVol)) {
    score += 1;
    reasons.push(`15m vol ${vol.toFixed(2)} ETH healthy`);
  }
  if (buys >= 5 && (lateBuys <= 0 || buys < lateBuys)) {
    score += 1;
    reasons.push(`buys ${buys} healthy`);
  }
  if (chg != null && Number.isFinite(chg) && chg >= 15 && chg < 100) {
    score += 1;
    reasons.push(`15m Δ +${chg.toFixed(1)}%`);
  }

  // Prefer launch-origin moons; require higher score otherwise
  const need = isLaunch ? config.MOON_MIN_SCORE : config.MOON_MIN_SCORE + 2;
  const promote = score >= need && isLaunch;
  // Allow exceptional boost with strong arm even if not launch
  const boostException =
    src === "boost" &&
    pnlPct >= config.MOON_ARM_STRONG_PNL_PCT &&
    score >= need;

  return {
    promote: promote || boostException,
    score,
    reasons,
  };
}

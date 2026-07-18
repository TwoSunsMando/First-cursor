import type { BotDb, ClosedTradeFeatures, LessonKind } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";

export interface LessonCondition {
  kind: LessonKind;
  /** Discriminator value stored in lesson_key / matched at apply time */
  bucket: string;
}

export interface LearnResult {
  closedTrades: number;
  lessonsWritten: number;
  activeLessons: number;
  summaryLines: string[];
}

function liquidityBucket(liq: number | null | undefined): string {
  const v = liq ?? 0;
  if (v >= 5) return "liq_ge_5";
  if (v >= 1) return "liq_1_to_5";
  if (v >= 0.25) return "liq_0_25_to_1";
  if (v >= 0.05) return "liq_0_05_to_0_25";
  return "liq_lt_0_05";
}

function scoreBand(score: number | null | undefined): string {
  const s = score ?? 0;
  if (s >= 55) return "score_ge_55";
  if (s >= 45) return "score_45_to_54";
  if (s >= 35) return "score_35_to_44";
  return "score_lt_35";
}

function holdBucket(minutes: number): string {
  if (minutes < 5) return "hold_lt_5m";
  if (minutes < 30) return "hold_5_to_30m";
  if (minutes < 180) return "hold_30_to_180m";
  return "hold_ge_180m";
}

function exitBucket(reason: string | null): string {
  if (!reason) return "exit_unknown";
  if (reason.startsWith("take_profit")) return "exit_take_profit";
  if (reason.startsWith("stop_loss")) return "exit_stop_loss";
  if (reason.startsWith("max_hold")) return "exit_max_hold";
  return "exit_other";
}

function labelFor(kind: LessonKind, bucket: string): string {
  const map: Record<string, string> = {
    liq_ge_5: "liquidity ≥ 5 ETH",
    liq_1_to_5: "liquidity 1–5 ETH",
    liq_0_25_to_1: "liquidity 0.25–1 ETH",
    liq_0_05_to_0_25: "liquidity 0.05–0.25 ETH",
    liq_lt_0_05: "liquidity < 0.05 ETH",
    score_ge_55: "entry score ≥ 55",
    score_45_to_54: "entry score 45–54",
    score_35_to_44: "entry score 35–44",
    score_lt_35: "entry score < 35",
    hold_lt_5m: "held < 5 minutes",
    hold_5_to_30m: "held 5–30 minutes",
    hold_30_to_180m: "held 30–180 minutes",
    hold_ge_180m: "held ≥ 180 minutes",
    exit_take_profit: "exited via take-profit",
    exit_stop_loss: "exited via stop-loss",
    exit_max_hold: "exited via max-hold",
    exit_other: "other exit",
    exit_unknown: "unknown exit",
    v2: "dex = Uniswap V2",
    v3: "dex = Uniswap V3",
    noxa: "dex = NOXA",
    trending: "source = trending",
    boost: "source = boost",
    uniswap_v2: "source = new V2 pool",
    uniswap_v3: "source = new V3 pool",
  };
  return map[bucket] ?? `${kind}:${bucket}`;
}

/**
 * Map win-rate / avg PnL into a score delta.
 * Conservative caps so thin samples cannot swing decisions wildly.
 */
export function computeScoreDelta(
  wins: number,
  losses: number,
  avgPnlPct: number,
  minSamples: number,
): { delta: number; active: boolean; notes: string } {
  const n = wins + losses;
  if (n < minSamples) {
    return {
      delta: 0,
      active: false,
      notes: `need ≥${minSamples} closed trades in bucket (have ${n})`,
    };
  }

  const winRate = wins / n;
  let delta = 0;
  if (winRate >= 0.65 && avgPnlPct > 0) delta = 8;
  else if (winRate >= 0.55 && avgPnlPct > 0) delta = 4;
  else if (winRate <= 0.35 && avgPnlPct < 0) delta = -10;
  else if (winRate <= 0.45 && avgPnlPct < 0) delta = -5;

  // Amplify slightly with avg pnl magnitude, still capped
  if (avgPnlPct >= 40 && delta > 0) delta = Math.min(12, delta + 2);
  if (avgPnlPct <= -40 && delta < 0) delta = Math.max(-15, delta - 2);

  const notes = `winRate=${(winRate * 100).toFixed(0)}% avgPnl=${avgPnlPct.toFixed(1)}% n=${n}`;
  return { delta, active: delta !== 0, notes };
}

interface BucketAgg {
  kind: LessonKind;
  bucket: string;
  wins: number;
  losses: number;
  pnlSum: number;
  n: number;
}

function bump(map: Map<string, BucketAgg>, kind: LessonKind, bucket: string, trade: ClosedTradeFeatures) {
  const key = `${kind}:${bucket}`;
  let row = map.get(key);
  if (!row) {
    row = { kind, bucket, wins: 0, losses: 0, pnlSum: 0, n: 0 };
    map.set(key, row);
  }
  row.n += 1;
  row.pnlSum += trade.pnl_pct;
  if (trade.pnl_pct > 0) row.wins += 1;
  else if (trade.pnl_pct < 0) row.losses += 1;
}

export function mineLessonsFromTrades(
  trades: ClosedTradeFeatures[],
  minSamples: number,
): Array<{
  lesson_key: string;
  kind: LessonKind;
  label: string;
  condition: LessonCondition;
  wins: number;
  losses: number;
  avg_pnl_pct: number;
  sample_size: number;
  score_delta: number;
  active: boolean;
  notes: string;
}> {
  const map = new Map<string, BucketAgg>();

  for (const t of trades) {
    bump(map, "liquidity_bucket", liquidityBucket(t.initial_liquidity_eth), t);
    bump(map, "dex", t.dex, t);
    bump(map, "score_band", scoreBand(t.score), t);
    bump(map, "hold_bucket", holdBucket(t.hold_minutes), t);
    bump(map, "exit_reason", exitBucket(t.exit_reason), t);
    if (t.source) bump(map, "source_bucket", t.source, t);
  }

  const out = [];
  for (const agg of map.values()) {
    const avg = agg.n ? agg.pnlSum / agg.n : 0;
    const { delta, active, notes } = computeScoreDelta(
      agg.wins,
      agg.losses,
      avg,
      minSamples,
    );
    // Exit-reason lessons are diagnostic only (not applied to new entries)
    const applyActive = active && agg.kind !== "exit_reason" && agg.kind !== "hold_bucket";
    out.push({
      lesson_key: `${agg.kind}:${agg.bucket}`,
      kind: agg.kind,
      label: labelFor(agg.kind, agg.bucket),
      condition: { kind: agg.kind, bucket: agg.bucket },
      wins: agg.wins,
      losses: agg.losses,
      avg_pnl_pct: avg,
      sample_size: agg.n,
      score_delta: applyActive ? delta : 0,
      active: applyActive,
      notes:
        agg.kind === "exit_reason" || agg.kind === "hold_bucket"
          ? `${notes} (observational — not applied to entry score)`
          : notes,
    });
  }
  return out;
}

export function runLearningPass(db: BotDb, minSamples: number): LearnResult {
  const trades = db.listClosedPaperTradesWithFeatures();
  const mined = mineLessonsFromTrades(trades, minSamples);
  const keepKeys: string[] = [];

  for (const lesson of mined) {
    keepKeys.push(lesson.lesson_key);
    db.upsertLesson({
      lesson_key: lesson.lesson_key,
      kind: lesson.kind,
      label: lesson.label,
      condition_json: JSON.stringify(lesson.condition),
      wins: lesson.wins,
      losses: lesson.losses,
      avg_pnl_pct: lesson.avg_pnl_pct,
      sample_size: lesson.sample_size,
      score_delta: lesson.score_delta,
      active: lesson.active,
      notes: lesson.notes,
    });
  }
  db.deactivateStaleLessons(keepKeys);
  db.setMeta("last_learn_at", new Date().toISOString());
  db.setMeta("last_learn_closed_count", String(trades.length));

  const active = mined.filter((l) => l.active);
  const summaryLines = [
    `Closed paper trades analyzed: ${trades.length}`,
    `Lessons written: ${mined.length} (${active.length} active / applied)`,
    `Min samples per bucket: ${minSamples}`,
  ];

  if (!trades.length) {
    summaryLines.push("No closed paper trades yet — keep scanning in paper mode.");
  } else if (!active.length) {
    summaryLines.push(
      `Not enough per-bucket samples for active lessons yet (need ≥${minSamples} in a bucket).`,
    );
  } else {
    for (const l of active.sort((a, b) => Math.abs(b.score_delta) - Math.abs(a.score_delta))) {
      summaryLines.push(
        `  ${l.score_delta >= 0 ? "+" : ""}${l.score_delta}  ${l.label}  (${l.notes})`,
      );
    }
  }

  return {
    closedTrades: trades.length,
    lessonsWritten: mined.length,
    activeLessons: active.length,
    summaryLines,
  };
}

/** Score adjustment for a new candidate from active lessons (Learning Mode). */
export function lessonScoreDeltaForCandidate(
  db: BotDb,
  candidate: CandidateToken,
  entryScore: number,
): { delta: number; applied: string[] } {
  const lessons = db.listLessons(true);
  if (!lessons.length) return { delta: 0, applied: [] };

  const buckets = new Set<string>([
    `liquidity_bucket:${liquidityBucket(candidate.initialLiquidityEth)}`,
    `dex:${candidate.dex}`,
    `score_band:${scoreBand(entryScore)}`,
    `source_bucket:${candidate.source}`,
  ]);

  let delta = 0;
  const applied: string[] = [];
  for (const lesson of lessons) {
    if (!buckets.has(lesson.lesson_key)) continue;
    if (!lesson.score_delta) continue;
    delta += lesson.score_delta;
    applied.push(
      `${lesson.label} (${lesson.score_delta >= 0 ? "+" : ""}${lesson.score_delta})`,
    );
  }

  // Cap total lesson influence
  delta = Math.max(-20, Math.min(20, delta));
  return { delta, applied };
}

export function formatLessonsReport(db: BotDb): string {
  const lessons = db.listLessons(false);
  const last = db.getMeta("last_learn_at") ?? "never";
  const lines = [
    "=== Lessons Learned ===",
    `Last learn pass: ${last}`,
    `Closed paper trades: ${db.countClosedPaperTrades()}`,
    "",
  ];
  if (!lessons.length) {
    lines.push("No lessons yet. Run: npm run learn");
    return lines.join("\n");
  }

  for (const l of lessons) {
    const flag = l.active ? "ACTIVE" : "idle  ";
    const delta =
      l.score_delta === 0 ? "  0" : l.score_delta > 0 ? `+${l.score_delta}` : `${l.score_delta}`;
    lines.push(
      `[${flag}] ${delta.padStart(3)}  ${l.label}  W${l.wins}/L${l.losses} avg=${l.avg_pnl_pct.toFixed(1)}% n=${l.sample_size}`,
    );
    if (l.notes) lines.push(`         ${l.notes}`);
  }
  return lines.join("\n");
}

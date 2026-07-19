import "dotenv/config";
import { z } from "zod";
import { isHex } from "viem";

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === "") return false;
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  });

const ConfigSchema = z
  .object({
    RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
    WSS_RPC_URL: z.string().optional().default(""),
    EXECUTION_MODE: z.enum(["paper", "live"]).default("paper"),
    PAPER_BUY_ETH: z.coerce.number().positive().default(0.01),
    PAPER_STARTING_EQUITY_ETH: z.coerce.number().positive().default(1.0),
    TAKE_PROFIT_PERCENT: z.coerce.number().positive().default(65),
    STOP_LOSS_PERCENT: z.coerce.number().positive().default(15),
    MAX_HOLD_MINUTES: z.coerce.number().int().positive().default(45),
    MIN_INITIAL_LIQUIDITY_ETH: z.coerce.number().nonnegative().default(0.05),
    /**
     * Overnight edge: mid-liq (~5–50 ETH) outperformed mega-liq majors.
     * Used for score sweet-spot bonus and BUY confirmation.
     */
    PREFERRED_LIQ_MIN_ETH: z.coerce.number().nonnegative().default(5),
    PREFERRED_LIQ_MAX_ETH: z.coerce.number().positive().default(50),
    /**
     * Skip trending/boost candidates at or above this WETH liquidity (majors / late).
     * Set 0 to disable.
     */
    SKIP_TRENDING_LIQ_ETH: z.coerce.number().nonnegative().default(50),
    /**
     * 15m volume (ETH) at/above this is treated as late-entry for trending/boost.
     * Hard-skips in risk filter; also demotes in scorer. 0 = disable hard skip.
     */
    LATE_ENTRY_VOL_ETH_15M: z.coerce.number().nonnegative().default(12),
    /** Unique buys at/above this → late-entry (with LATE_ENTRY_VOL). 0 = disable. */
    LATE_ENTRY_BUYS: z.coerce.number().int().nonnegative().default(45),
    MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
    DENY_NAME_SUBSTRINGS: z.string().default("scam,honeypot,test"),
    /** Score ≥ this → BUY (paper open / live approval). Was 55; 45 matches V3+≥1 ETH liq. */
    BUY_SCORE_THRESHOLD: z.coerce.number().nonnegative().default(40),
    /** Score ≥ this (and < BUY) → WATCH. */
    WATCH_SCORE_THRESHOLD: z.coerce.number().nonnegative().default(32),
    /**
     * If true, BUY requires a confirming edge (boost/noxa/new-pool, mid-liq, or
     * moderate momentum). Raw high score alone is not enough.
     */
    BUY_REQUIRE_CONFIRMING_EDGE: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /** Paper-only: mine closed trades into lessons and apply score deltas. */
    LEARNING_MODE: boolFromEnv,
    /** Min closed trades in a feature bucket before a lesson becomes ACTIVE. */
    LEARN_MIN_SAMPLES: z.coerce.number().int().positive().default(5),
    /** Re-run learning pass while scanning (ms). 0 = only manual `npm run learn`. */
    LEARN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300_000),
    /** DexPaprika trending / boost poller (default on). */
    TRENDING_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    TRENDING_INTERVAL_MS: z.coerce.number().int().positive().default(120_000),
    TRENDING_COOLDOWN_MS: z.coerce.number().int().positive().default(900_000),
    TRENDING_LIMIT: z.coerce.number().int().positive().default(15),
    TRENDING_MIN_VOLUME_USD_24H: z.coerce.number().nonnegative().default(25_000),
    TRENDING_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(5_000),
    TRENDING_MIN_TXNS_24H: z.coerce.number().int().nonnegative().default(50),
    /**
     * Scale volume/buys/Δ points for trending|boost sources (0–1).
     * Keeps trending as a signal without letting it monopolize paper slots.
     */
    TRENDING_MOMENTUM_SCALE: z.coerce.number().min(0).max(1).default(0.55),
    /** Max open positions that originated from trending/boost (rest reserved for new pools). */
    MAX_TRENDING_OPEN_POSITIONS: z.coerce.number().int().nonnegative().default(3),
    /**
     * After a stop-loss on a token, block re-entry for this long (paper + live).
     * Stops trending from immediately buying Jimothy/STOCKCAT again.
     */
    REENTRY_AFTER_STOP_MS: z.coerce.number().int().nonnegative().default(6 * 60 * 60 * 1000),
    /** Longer ban after brutal losses (pnl ≤ -50% or exit reason contains -100). */
    REENTRY_AFTER_HARD_LOSS_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(24 * 60 * 60 * 1000),
    /** If this many stop-losses hit on one token inside the window, use hard-loss cooldown. */
    REENTRY_STOP_STREAK: z.coerce.number().int().positive().default(2),
    /**
     * Dead-chop: max-hold exits with |pnl%| ≤ this count as flat chops.
     * After CHOP_STREAK such exits, block re-entry for REENTRY_AFTER_CHOP_MS.
     */
    CHOP_FLAT_PNL_PCT: z.coerce.number().nonnegative().default(5),
    CHOP_STREAK: z.coerce.number().int().positive().default(2),
    REENTRY_AFTER_CHOP_MS: z.coerce.number().int().nonnegative().default(48 * 60 * 60 * 1000),

    /**
     * Moon / runner book: early entry stays scout; upgrade in-position to
     * scale-out + trail instead of full +TAKE_PROFIT dump.
     */
    MOON_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    MAX_MOON_POSITIONS: z.coerce.number().int().nonnegative().default(2),
    /** Min unrealized PnL% before a scout can promote to moon. */
    MOON_ARM_PNL_PCT: z.coerce.number().nonnegative().default(35),
    /** Extra arm strength (helps boost exceptions / score). */
    MOON_ARM_STRONG_PNL_PCT: z.coerce.number().nonnegative().default(55),
    /** Max age (minutes) to still consider “early” for moon upgrade. */
    MOON_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(40),
    /** Min moon detect score (launch sources need this; others need +2). */
    MOON_MIN_SCORE: z.coerce.number().int().positive().default(3),
    /** First trim at TAKE_PROFIT — % of original size. */
    MOON_TRIM_TP_PCT: z.coerce.number().min(0).max(100).default(35),
    MOON_TRIM_2X_PCT_TRIGGER: z.coerce.number().positive().default(200),
    MOON_TRIM_2X_PCT: z.coerce.number().min(0).max(100).default(15),
    MOON_TRIM_5X_PCT_TRIGGER: z.coerce.number().positive().default(500),
    MOON_TRIM_5X_PCT: z.coerce.number().min(0).max(100).default(15),
    MOON_TRIM_10X_PCT_TRIGGER: z.coerce.number().positive().default(1000),
    MOON_TRIM_10X_PCT: z.coerce.number().min(0).max(100).default(15),
    /** Close remainder when PnL giveback from peak reaches this many points. */
    MOON_TRAIL_GIVEBACK_PCT: z.coerce.number().positive().default(30),
    /** Soft ceiling for moon holds (minutes). 0 = no max hold. */
    MOON_MAX_HOLD_MINUTES: z.coerce.number().int().nonnegative().default(24 * 60),

    PRIVATE_KEY: z.string().optional().default(""),
    MAX_BUY_ETH: z.coerce.number().positive().default(0.01),
    MAX_DAILY_ETH: z.coerce.number().positive().default(0.05),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(300),
    AUTO_SELL: boolFromEnv,
    APPROVAL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    DB_PATH: z.string().default("./data/bot.db"),
    /** How often the HTTP poller / mark-to-market loop ticks. Public RPC: keep ≥20000. */
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    /** Separate mark-to-market cadence (paper exits). Defaults to POLL_INTERVAL_MS if unset. */
    MARK_INTERVAL_MS: z.coerce.number().int().positive().optional(),
    /** Max blocks per eth_getLogs window on HTTP poller (RH Chain is ~100ms blocks). */
    MAX_BLOCKS_PER_POLL: z.coerce.number().int().positive().default(80),
    /** Delay between enriching candidates (token meta / liquidity reads). */
    ENRICH_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.EXECUTION_MODE === "live") {
      if (!cfg.PRIVATE_KEY || !isHex(cfg.PRIVATE_KEY) || cfg.PRIVATE_KEY.length !== 66) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PRIVATE_KEY"],
          message: "Live mode requires PRIVATE_KEY as 0x-prefixed 32-byte hex",
        });
      }
      if (cfg.MAX_BUY_ETH > cfg.MAX_DAILY_ETH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["MAX_BUY_ETH"],
          message: "MAX_BUY_ETH cannot exceed MAX_DAILY_ETH",
        });
      }
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema> & {
  denyNameSubstrings: string[];
  wssRpcUrl: string | undefined;
  privateKey: `0x${string}` | undefined;
  markIntervalMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  const denyNameSubstrings = parsed.DENY_NAME_SUBSTRINGS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (parsed.WATCH_SCORE_THRESHOLD > parsed.BUY_SCORE_THRESHOLD) {
    throw new Error("WATCH_SCORE_THRESHOLD cannot exceed BUY_SCORE_THRESHOLD");
  }

  return {
    ...parsed,
    denyNameSubstrings,
    wssRpcUrl: parsed.WSS_RPC_URL || undefined,
    privateKey:
      parsed.PRIVATE_KEY && isHex(parsed.PRIVATE_KEY)
        ? (parsed.PRIVATE_KEY as `0x${string}`)
        : undefined,
    markIntervalMs: parsed.MARK_INTERVAL_MS ?? parsed.POLL_INTERVAL_MS,
  };
}

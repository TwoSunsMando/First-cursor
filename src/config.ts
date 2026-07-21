import dotenv from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";
import { isHex } from "viem";

// Always prefer the project .env; override shell leftovers; trim Windows CRLF.
dotenv.config({ path: resolve(process.cwd(), ".env"), override: true });
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === "string" && /[\r\n]|^\s|\s$/.test(v)) {
    process.env[k] = v.replace(/^\uFEFF/, "").trim();
  }
}

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
    EXECUTION_MODE: z
      .string()
      .default("paper")
      .transform((v) => v.trim().toLowerCase())
      .pipe(z.enum(["paper", "live"])),
    PAPER_BUY_ETH: z.coerce.number().positive().default(0.01),
    PAPER_STARTING_EQUITY_ETH: z.coerce.number().positive().default(1.0),
    TAKE_PROFIT_PERCENT: z.coerce.number().positive().default(65),
    STOP_LOSS_PERCENT: z.coerce.number().positive().default(15),
    MAX_HOLD_MINUTES: z.coerce.number().int().positive().default(45),
    MIN_INITIAL_LIQUIDITY_ETH: z.coerce.number().nonnegative().default(0.25),
    /**
     * Stricter floor for launch sources (noxa / new V2 / new V3).
     * Instant rugs often seed << this then pull.
     */
    MIN_LAUNCH_LIQUIDITY_ETH: z.coerce.number().nonnegative().default(0.5),
    /** If true, unknown (null) liquidity fails risk instead of passing. */
    REJECT_NULL_LIQUIDITY: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /**
     * Require buy→sell quoter roundtrip before BUY (paper + live).
     * Catches honeypots / unsellable tax tokens before entry.
     */
    REQUIRE_SELLABLE_QUOTE: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /**
     * Max implied roundtrip loss in bps (buy then sell same size).
     * 2500 = 25%. Higher tax / failed exit → SKIP.
     */
    MAX_ROUNDTRIP_TAX_BPS: z.coerce.number().int().nonnegative().default(2500),
    /**
     * After PairCreated/PoolCreated, wait this many ms then re-read WETH in pool.
     * Instant LP pulls show up as a sharp drop. 0 = disable.
     * Prefer MIN_LAUNCH_AGE_MS for the real anti-rug delay (non-blocking queue).
     */
    LAUNCH_LIQ_SETTLE_MS: z.coerce.number().int().nonnegative().default(0),
    /** Fail settle if WETH dropped by this % or more vs first enrich. 0 = disable drop check. */
    LAUNCH_LIQ_DROP_MAX_PCT: z.coerce.number().nonnegative().default(35),
    /**
     * Min age after launch detect before a BUY can execute (non-blocking defer queue).
     * Overnight rugs were ~60s–2m — default 120s. Mid-wait probes abort early on LP pull.
     * 0 = buy immediately after other gates (not recommended live).
     */
    MIN_LAUNCH_AGE_MS: z.coerce.number().int().nonnegative().default(120_000),
    /** While deferred, re-check pool WETH this often and abort on rug. 0 = only check at ready. */
    LAUNCH_LIQ_PROBE_MS: z.coerce.number().int().nonnegative().default(20_000),
    /**
     * After min-age survives, wait this extra window and re-check liq again before BUY.
     * Catches delayed rugs that keep LP up for ~2m then pull (eeepy/Emma pattern).
     * 0 = buy immediately after age. Default 90s.
     */
    LAUNCH_CONFIRM_MS: z.coerce.number().int().nonnegative().default(90_000),
    /**
     * Live: if pool WETH falls below this fraction of entry pool WETH within
     * EARLY_RUG_WINDOW_MS, force an emergency sell attempt (LP drain bailout).
     */
    EARLY_RUG_LIQ_FRACTION: z.coerce.number().min(0).max(1).default(0.4),
    /** Live early-rug detector window after open (ms). 0 = disable. */
    EARLY_RUG_WINDOW_MS: z.coerce.number().int().nonnegative().default(600_000),
    /**
     * After defer/confirm, require DexPaprika 15m strength before BUY.
     * Positive price Δ is mandatory; vol/buys are AND confirmers (never OR substitutes).
     * The old OR-gate let dump volume (MEOW −37% Δ) pass as “momentum”.
     */
    REQUIRE_LAUNCH_MOMENTUM: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /** Mandatory: 15m price change % must be ≥ this (fail closed if missing). */
    LAUNCH_MOMENTUM_MIN_DELTA_PCT: z.coerce.number().nonnegative().default(25),
    /** AND confirmer: 15m volume (ETH) ≥ this. 0 = do not require vol. */
    LAUNCH_MOMENTUM_MIN_VOL_ETH: z.coerce.number().nonnegative().default(2),
    /** AND confirmer: 15m (or 1h fallback) buys ≥ this. 0 = do not require buys. */
    LAUNCH_MOMENTUM_MIN_BUYS: z.coerce.number().int().nonnegative().default(15),
    /**
     * Snapshot mid price at defer enqueue; at BUY require on-chain appreciation
     * vs that baseline. Catches “LP still there but already dumped / dead”.
     */
    REQUIRE_ONCHAIN_APPRECIATION: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /** Min % mid-price gain from first defer quote → execute. */
    LAUNCH_MIN_APPRECIATION_PCT: z.coerce.number().nonnegative().default(8),
    /** Mid-wait abort if mid price drops this % from peak quote. 0 = disable. */
    LAUNCH_PRICE_DROP_MAX_PCT: z.coerce.number().nonnegative().default(25),
    /**
     * Paper + live: only BUY launch sources (noxa / uniswap_v2 / uniswap_v3).
     * Trending/boost is late chop for this strategy — strength after launch is the edge.
     */
    ENTRY_LAUNCH_ONLY: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return true;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
    /**
     * Stricter WETH floor at the moment of deferred BUY (after age+confirm).
     * Paper moons clustered ~8–15 ETH; live rugs often ~3–5.5. 0 = use MIN_LAUNCH only.
     */
    MIN_LAUNCH_ENTRY_LIQUIDITY_ETH: z.coerce.number().nonnegative().default(7),
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
    /**
     * Live: skip human Yes/No — execute buys that already passed score+gates.
     * Use only with tight caps + LIVE_LAUNCH_ONLY for unattended overnight.
     */
    AUTO_APPROVE_BUYS: boolFromEnv,
    /**
     * Live alias for ENTRY_LAUNCH_ONLY (kept for existing WSL .env).
     * Prefer ENTRY_LAUNCH_ONLY; either true → launch-only buys.
     */
    LIVE_LAUNCH_ONLY: z
      .string()
      .optional()
      .transform((v) => {
        if (v === undefined || v === "") return false;
        return ["1", "true", "yes", "on"].includes(v.toLowerCase());
      }),
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

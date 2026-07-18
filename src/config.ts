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
    TAKE_PROFIT_PERCENT: z.coerce.number().positive().default(50),
    STOP_LOSS_PERCENT: z.coerce.number().positive().default(25),
    MAX_HOLD_MINUTES: z.coerce.number().int().positive().default(180),
    MIN_INITIAL_LIQUIDITY_ETH: z.coerce.number().nonnegative().default(0.05),
    MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
    DENY_NAME_SUBSTRINGS: z.string().default("scam,honeypot,test"),
    /** Score ≥ this → BUY (paper open / live approval). Was 55; 45 matches V3+≥1 ETH liq. */
    BUY_SCORE_THRESHOLD: z.coerce.number().nonnegative().default(45),
    /** Score ≥ this (and < BUY) → WATCH. */
    WATCH_SCORE_THRESHOLD: z.coerce.number().nonnegative().default(35),
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

import type { Address } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb, DexKind } from "../db/schema.js";

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

  return { ok: reasons.length === 0, reasons };
}

import { formatEther, type Address } from "viem";
import type { AppConfig } from "../config.js";
import type { RhPublicClient } from "../chain/client.js";
import {
  quoteBuyTokensForEth,
  quoteSellEthForTokens,
  readV2WethLiquidityEth,
  readV3WethLiquidityEth,
} from "../chain/pricing.js";
import type { CandidateToken } from "./filters.js";

export interface SellabilityResult {
  ok: boolean;
  reason: string;
  tokensOut?: bigint;
  ethBack?: number;
  taxBps?: number;
}

function isLaunchSource(source: string): boolean {
  return (
    source === "noxa" ||
    source === "uniswap_v2" ||
    source === "uniswap_v3"
  );
}

/**
 * Buy→sell roundtrip quote. Fails closed on honeypots / extreme tax / empty pools.
 * Same-block friendly (no wait) — call after optional liquidity settle.
 */
export async function checkSellableRoundtrip(
  client: RhPublicClient,
  candidate: CandidateToken,
  config: AppConfig,
  ethIn?: number,
): Promise<SellabilityResult> {
  if (!config.REQUIRE_SELLABLE_QUOTE) {
    return { ok: true, reason: "sellable check disabled" };
  }

  const sizeEth =
    ethIn ??
    (config.EXECUTION_MODE === "live" ? config.MAX_BUY_ETH : config.PAPER_BUY_ETH);
  const dex = candidate.dex === "noxa" ? "v2" : candidate.dex;

  const tokensOut = await quoteBuyTokensForEth(
    client,
    candidate.token,
    dex,
    candidate.fee,
    sizeEth,
  );
  if (tokensOut == null || tokensOut <= 0n) {
    return {
      ok: false,
      reason: `unsellable: buy quote failed for ${sizeEth} ETH (no pool / dead liq)`,
    };
  }

  const ethBackWei = await quoteSellEthForTokens(
    client,
    candidate.token,
    dex,
    candidate.fee,
    tokensOut,
  );
  if (ethBackWei == null || ethBackWei <= 0n) {
    return {
      ok: false,
      reason: "unsellable: sell quote failed (honeypot / transfer tax / no exit)",
    };
  }

  const ethBack = Number(formatEther(ethBackWei));
  if (!(ethBack > 0) || !(sizeEth > 0)) {
    return { ok: false, reason: "unsellable: zero roundtrip" };
  }

  const taxBps = Math.round((1 - ethBack / sizeEth) * 10_000);
  if (taxBps > config.MAX_ROUNDTRIP_TAX_BPS) {
    return {
      ok: false,
      reason: `roundtrip tax ~${(taxBps / 100).toFixed(1)}% > max ${(config.MAX_ROUNDTRIP_TAX_BPS / 100).toFixed(1)}%`,
      tokensOut,
      ethBack,
      taxBps,
    };
  }

  return {
    ok: true,
    reason: `sellable roundtrip tax≈${(taxBps / 100).toFixed(1)}% (back ${ethBack.toFixed(5)} ETH)`,
    tokensOut,
    ethBack,
    taxBps,
  };
}

/** Re-read WETH inventory in the pool/pair after a short settle. */
export async function rereadPoolLiquidityEth(
  client: RhPublicClient,
  candidate: CandidateToken,
): Promise<number | null> {
  if (candidate.dex === "v3") {
    return readV3WethLiquidityEth(client, candidate.pairOrPool);
  }
  if (candidate.dex === "v2") {
    return readV2WethLiquidityEth(client, candidate.pairOrPool);
  }
  // NOXA: pair unknown at launch event — cannot re-read pool WETH
  return candidate.initialLiquidityEth;
}

/**
 * Wait briefly after pool create, then reject if WETH inventory vanished
 * (classic same-minute LP pull / instant rug).
 */
export async function settleLaunchLiquidity(
  client: RhPublicClient,
  candidate: CandidateToken,
  config: AppConfig,
): Promise<{ ok: boolean; reason: string; liq: number | null }> {
  if (!isLaunchSource(candidate.source) || config.LAUNCH_LIQ_SETTLE_MS <= 0) {
    return {
      ok: true,
      reason: "settle skipped",
      liq: candidate.initialLiquidityEth,
    };
  }

  // NOXA has no pair yet — settle only helps V2/V3 pools
  if (candidate.dex === "noxa") {
    return {
      ok: true,
      reason: "settle skipped (noxa)",
      liq: candidate.initialLiquidityEth,
    };
  }

  const before = candidate.initialLiquidityEth;
  await new Promise((r) => setTimeout(r, config.LAUNCH_LIQ_SETTLE_MS));
  const after = await rereadPoolLiquidityEth(client, candidate);

  if (after == null) {
    return { ok: false, reason: "liq settle: pool WETH unreadable after wait", liq: null };
  }
  if (after < config.MIN_LAUNCH_LIQUIDITY_ETH) {
    return {
      ok: false,
      reason: `liq settle: ${after.toFixed(4)} ETH < min launch ${config.MIN_LAUNCH_LIQUIDITY_ETH}`,
      liq: after,
    };
  }
  if (
    before != null &&
    before > 0 &&
    config.LAUNCH_LIQ_DROP_MAX_PCT > 0
  ) {
    const dropPct = ((before - after) / before) * 100;
    if (dropPct >= config.LAUNCH_LIQ_DROP_MAX_PCT) {
      return {
        ok: false,
        reason: `liq settle: WETH dropped ${dropPct.toFixed(0)}% (${before.toFixed(3)}→${after.toFixed(3)}) ≥ ${config.LAUNCH_LIQ_DROP_MAX_PCT}% (instant rug pattern)`,
        liq: after,
      };
    }
  }

  return {
    ok: true,
    reason: `liq settle ok ${after.toFixed(4)} ETH`,
    liq: after,
  };
}

export async function assertBuyGates(
  client: RhPublicClient,
  candidate: CandidateToken,
  config: AppConfig,
  ethIn?: number,
): Promise<{ ok: boolean; reasons: string[]; candidate: CandidateToken }> {
  const reasons: string[] = [];
  let next = candidate;

  const settled = await settleLaunchLiquidity(client, candidate, config);
  if (settled.liq != null && settled.liq !== candidate.initialLiquidityEth) {
    next = { ...candidate, initialLiquidityEth: settled.liq };
  }
  if (!settled.ok) {
    reasons.push(settled.reason);
    return { ok: false, reasons, candidate: next };
  }
  if (settled.reason !== "settle skipped" && settled.reason !== "settle skipped (noxa)") {
    reasons.push(settled.reason);
  }

  const sellable = await checkSellableRoundtrip(client, next, config, ethIn);
  if (!sellable.ok) {
    reasons.push(sellable.reason);
    return { ok: false, reasons, candidate: next };
  }
  reasons.push(sellable.reason);
  return { ok: true, reasons, candidate: next };
}

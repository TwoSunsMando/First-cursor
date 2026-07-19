import type { Address, Log } from "viem";
import { formatEther, getAddress, parseAbiItem } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";
import { applyRiskFilters } from "../risk/filters.js";
import {
  hasConfirmingEdge,
  scoreCandidate,
  type ScoreExtras,
} from "../signals/score.js";
import { lessonScoreDeltaForCandidate } from "../learning/engine.js";
import { ADDRESSES } from "../chain/addresses.js";
import {
  noxaFactoryAbi,
  uniswapV2FactoryAbi,
  uniswapV3FactoryAbi,
} from "../chain/abis.js";
import type { RhPublicClient } from "../chain/client.js";
import {
  otherToken,
  readTokenMeta,
  readV2WethLiquidityEth,
  readV3WethLiquidityEth,
} from "../chain/pricing.js";
import { assertBuyGates } from "../risk/sellability.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";

export type CandidateHandler = (candidate: CandidateToken) => Promise<void>;

function logLine(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /too many requests|429|rate limit/i.test(msg);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleCandidate(
  candidate: CandidateToken,
  config: AppConfig,
  db: BotDb,
  paper: PaperEngine,
  live: LiveGateway | null,
  extras: ScoreExtras = {},
  client?: RhPublicClient,
): Promise<void> {
  const mode = config.EXECUTION_MODE;
  let working = candidate;
  const scoreWeights = {
    trendingMomentumScale: config.TRENDING_MOMENTUM_SCALE,
    preferredLiqMinEth: config.PREFERRED_LIQ_MIN_ETH,
    preferredLiqMaxEth: config.PREFERRED_LIQ_MAX_ETH,
    lateEntryVolEth15m: config.LATE_ENTRY_VOL_ETH_15M,
    lateEntryBuys: config.LATE_ENTRY_BUYS,
    minLaunchLiqEth: config.MIN_LAUNCH_LIQUIDITY_ETH,
  };
  const scored = scoreCandidate(
    working,
    extras,
    {
      buy: config.BUY_SCORE_THRESHOLD,
      watch: config.WATCH_SCORE_THRESHOLD,
    },
    scoreWeights,
  );
  const reasons = [...scored.reasons];
  let finalScore = scored.score;

  // Learning Mode: adjust score from mined paper-trade lessons (paper path only).
  if (config.LEARNING_MODE && mode === "paper") {
    const lesson = lessonScoreDeltaForCandidate(db, working, scored.score);
    if (lesson.delta !== 0) {
      finalScore = scored.score + lesson.delta;
      reasons.push(
        `learning Δ${lesson.delta >= 0 ? "+" : ""}${lesson.delta} → score ${finalScore} (${lesson.applied.join("; ")})`,
      );
    }
  }

  let action: "BUY" | "WATCH" | "SKIP" = "SKIP";
  if (finalScore >= config.BUY_SCORE_THRESHOLD) action = "BUY";
  else if (finalScore >= config.WATCH_SCORE_THRESHOLD) action = "WATCH";

  // Don't trust raw high score alone — need boost, launch+liq, mid-liq, or moderate momentum.
  if (action === "BUY" && config.BUY_REQUIRE_CONFIRMING_EDGE) {
    const edge = hasConfirmingEdge(working, extras, scoreWeights);
    if (!edge.ok) {
      action = "WATCH";
      reasons.push(`edge: ${edge.reason} — demoted to WATCH`);
    }
  }

  const risk = applyRiskFilters(working, config, db, mode, extras);
  if (!risk.ok) {
    action = "SKIP";
    reasons.push(...risk.reasons.map((r) => `risk: ${r}`));
  }

  // Reserve most paper slots for new-pool discovery; trending is a spice, not the meal.
  const isTrendingSrc =
    working.source === "trending" || working.source === "boost";
  if (
    action === "BUY" &&
    isTrendingSrc &&
    config.MAX_TRENDING_OPEN_POSITIONS >= 0 &&
    db.countOpenTrendingPositions(mode) >= config.MAX_TRENDING_OPEN_POSITIONS
  ) {
    action = "WATCH";
    reasons.push(
      `risk: trending open-slot cap (${config.MAX_TRENDING_OPEN_POSITIONS}) — demoted to WATCH`,
    );
  }

  // Live overnight moon-hunt: only new-pool / NOXA launches (skip trending/boost).
  const isLaunchSrc =
    working.source === "noxa" ||
    working.source === "uniswap_v2" ||
    working.source === "uniswap_v3";
  if (
    action === "BUY" &&
    mode === "live" &&
    config.LIVE_LAUNCH_ONLY &&
    !isLaunchSrc
  ) {
    action = "SKIP";
    reasons.push(
      `live: launch-only mode — skip source=${working.source} (want noxa/v2/v3)`,
    );
  }

  // Anti-instant-rug: settle launch liq + require buy→sell roundtrip before BUY.
  if (action === "BUY" && client) {
    const gates = await assertBuyGates(client, working, config);
    working = gates.candidate;
    reasons.push(...gates.reasons.map((r) => `gate: ${r}`));
    if (!gates.ok) {
      action = "SKIP";
    }
  } else if (
    action === "BUY" &&
    !client &&
    (config.REQUIRE_SELLABLE_QUOTE || config.LAUNCH_LIQ_SETTLE_MS > 0)
  ) {
    action = "SKIP";
    reasons.push("gate: no RPC client for sellable/settle checks");
  }

  reasons.push(
    `final score=${finalScore} → ${action} (buy≥${config.BUY_SCORE_THRESHOLD}, watch≥${config.WATCH_SCORE_THRESHOLD})`,
  );

  const signalId = db.insertSignal({
    token: working.token,
    symbol: working.symbol,
    name: working.name,
    dex: working.dex,
    pair_or_pool: working.pairOrPool,
    fee: working.fee,
    score: finalScore,
    action,
    reasons: reasons.join("; "),
    initial_liquidity_eth: working.initialLiquidityEth,
    tx_hash: working.txHash,
    source: working.source,
  });

  logLine(
    `SIGNAL ${action} ${working.symbol} (${working.token}) score=${finalScore.toFixed(1)} dex=${working.dex} #${signalId}`,
  );
  for (const r of reasons.slice(0, 10)) {
    logLine(`  · ${r}`);
  }

  if (action !== "BUY") return;

  if (mode === "paper") {
    await paper.tryOpenFromSignal(working, signalId);
    return;
  }

  if (live) {
    await live.requestBuyApproval(working, signalId);
  }
}

async function enrichV2(
  client: RhPublicClient,
  token: Address,
  pair: Address,
): Promise<{ name: string; symbol: string; liq: number | null }> {
  const meta = await readTokenMeta(client, token);
  const liq = await readV2WethLiquidityEth(client, pair);
  return { name: meta.name, symbol: meta.symbol, liq };
}

async function enrichV3(
  client: RhPublicClient,
  token: Address,
  pool: Address,
): Promise<{ name: string; symbol: string; liq: number | null }> {
  const meta = await readTokenMeta(client, token);
  const liq = await readV3WethLiquidityEth(client, pool);
  return { name: meta.name, symbol: meta.symbol, liq };
}

/** Process logs from a single getLogs batch (HTTP poller or WSS callback). */
async function processRawLogs(
  client: RhPublicClient,
  kind: "noxa" | "v2" | "v3",
  logs: Log[],
  emit: (c: CandidateToken) => Promise<void>,
  enrichDelayMs: number,
): Promise<void> {
  for (const log of logs) {
    try {
      const args = (log as Log & { args?: Record<string, unknown> }).args ?? {};

      if (kind === "noxa") {
        if (!args.token) continue;
        const token = getAddress(args.token as Address);
        await emit({
          token,
          name: String(args.name ?? "Unknown"),
          symbol: String(args.symbol ?? "???"),
          dex: "noxa",
          pairOrPool: token,
          fee: null,
          initialLiquidityEth: args.initialBuyEth
            ? Number(formatEther(args.initialBuyEth as bigint))
            : null,
          txHash: log.transactionHash ?? null,
          source: "noxa",
        });
        continue;
      }

      if (!args.token0 || !args.token1) continue;
      const token0 = getAddress(args.token0 as Address);
      const token1 = getAddress(args.token1 as Address);
      const token = otherToken(token0, token1, ADDRESSES.WETH);
      if (!token) continue;

      if (kind === "v2") {
        if (!args.pair) continue;
        const pair = getAddress(args.pair as Address);
        let name = "Unknown";
        let symbol = "???";
        let liq: number | null = null;
        try {
          const enriched = await enrichV2(client, token, pair);
          name = enriched.name;
          symbol = enriched.symbol;
          liq = enriched.liq;
        } catch (err) {
          if (isRateLimitError(err)) {
            logLine("rate limited during v2 enrich — emitting with minimal meta");
            await sleep(2_000);
          } else {
            throw err;
          }
        }
        await emit({
          token,
          name,
          symbol,
          dex: "v2",
          pairOrPool: pair,
          fee: null,
          initialLiquidityEth: liq,
          txHash: log.transactionHash ?? null,
          source: "uniswap_v2",
        });
      } else {
        if (!args.pool) continue;
        const pool = getAddress(args.pool as Address);
        const fee = args.fee != null ? Number(args.fee) : null;
        let name = "Unknown";
        let symbol = "???";
        let liq: number | null = null;
        try {
          const enriched = await enrichV3(client, token, pool);
          name = enriched.name;
          symbol = enriched.symbol;
          liq = enriched.liq;
        } catch (err) {
          if (isRateLimitError(err)) {
            logLine("rate limited during v3 enrich — emitting with minimal meta");
            await sleep(2_000);
          } else {
            throw err;
          }
        }
        await emit({
          token,
          name,
          symbol,
          dex: "v3",
          pairOrPool: pool,
          fee,
          initialLiquidityEth: liq,
          txHash: log.transactionHash ?? null,
          source: "uniswap_v3",
        });
      }

      if (enrichDelayMs > 0) await sleep(enrichDelayMs);
    } catch (err) {
      logLine(`${kind} log error: ${(err as Error).message}`);
      if (isRateLimitError(err)) await sleep(5_000);
    }
  }
}

function startHttpPoller(
  client: RhPublicClient,
  config: AppConfig,
  emit: (c: CandidateToken) => Promise<void>,
): () => void {
  const pollMs = Math.max(config.POLL_INTERVAL_MS, 20_000);
  const maxBlocks = BigInt(config.MAX_BLOCKS_PER_POLL);
  const enrichDelayMs = config.ENRICH_DELAY_MS;

  const pairCreatedEvent = parseAbiItem(
    "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
  );
  const poolCreatedEvent = parseAbiItem(
    "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
  );
  const tokenLaunchedEvent = parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 initialBuyEth)",
  );

  let lastBlock: bigint | null = null;
  let busy = false;
  let backoffMs = 0;
  let stopped = false;

  logLine(
    `HTTP poller: every ${pollMs}ms, max ${maxBlocks} blocks/poll (public RPC — prefer Alchemy WSS)`,
  );

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      if (backoffMs > 0) {
        logLine(`RPC backoff ${backoffMs}ms…`);
        await sleep(backoffMs);
      }

      const latest = await client.getBlockNumber();
      if (lastBlock === null) {
        // Start from a small recent window so we don't backfill thousands of pools.
        lastBlock = latest > maxBlocks ? latest - maxBlocks : 0n;
        logLine(`poll cursor set to block ${lastBlock} (latest ${latest})`);
      }
      if (latest <= lastBlock) return;

      let fromBlock = lastBlock + 1n;
      let toBlock = latest;
      if (toBlock - fromBlock + 1n > maxBlocks) {
        toBlock = fromBlock + maxBlocks - 1n;
        logLine(
          `catch-up capped: scanning ${fromBlock}→${toBlock} (latest ${latest}, will continue next tick)`,
        );
      }

      // Sequential getLogs (not Promise.all) to stay under public RPC limits.
      const noxaLogs = await client.getLogs({
        address: ADDRESSES.NOXA_LAUNCH_FACTORY,
        event: tokenLaunchedEvent,
        fromBlock,
        toBlock,
      });
      await sleep(150);
      const v2Logs = await client.getLogs({
        address: ADDRESSES.UNISWAP_V2_FACTORY,
        event: pairCreatedEvent,
        fromBlock,
        toBlock,
      });
      await sleep(150);
      const v3Logs = await client.getLogs({
        address: ADDRESSES.UNISWAP_V3_FACTORY,
        event: poolCreatedEvent,
        fromBlock,
        toBlock,
      });

      await processRawLogs(client, "noxa", noxaLogs as Log[], emit, enrichDelayMs);
      await processRawLogs(client, "v2", v2Logs as Log[], emit, enrichDelayMs);
      await processRawLogs(client, "v3", v3Logs as Log[], emit, enrichDelayMs);

      lastBlock = toBlock;
      backoffMs = 0;
    } catch (err) {
      const msg = (err as Error).message;
      logLine(`poll error: ${msg}`);
      if (isRateLimitError(err)) {
        backoffMs = Math.min(Math.max(backoffMs * 2, 10_000), 120_000);
        logLine(`Too Many Requests — backing off to ${backoffMs}ms between polls`);
      }
    } finally {
      busy = false;
    }
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, pollMs);

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function startWssWatchers(
  client: RhPublicClient,
  emit: (c: CandidateToken) => Promise<void>,
  enrichDelayMs: number,
): Array<() => void> {
  const unwatchers: Array<() => void> = [];

  const unwatchNoxa = client.watchContractEvent({
    address: ADDRESSES.NOXA_LAUNCH_FACTORY,
    abi: noxaFactoryAbi,
    eventName: "TokenLaunched",
    onLogs: async (logs) => {
      await processRawLogs(client, "noxa", logs as unknown as Log[], emit, enrichDelayMs);
    },
    onError: (err) => {
      logLine(`noxa watch error: ${err.message}`);
    },
  });
  unwatchers.push(unwatchNoxa);
  logLine(`WSS watching NOXA factory ${ADDRESSES.NOXA_LAUNCH_FACTORY}`);

  const unwatchV2 = client.watchContractEvent({
    address: ADDRESSES.UNISWAP_V2_FACTORY,
    abi: uniswapV2FactoryAbi,
    eventName: "PairCreated",
    onLogs: async (logs) => {
      await processRawLogs(client, "v2", logs as unknown as Log[], emit, enrichDelayMs);
    },
    onError: (err) => {
      logLine(`v2 watch error: ${err.message}`);
    },
  });
  unwatchers.push(unwatchV2);
  logLine(`WSS watching Uniswap V2 factory ${ADDRESSES.UNISWAP_V2_FACTORY}`);

  const unwatchV3 = client.watchContractEvent({
    address: ADDRESSES.UNISWAP_V3_FACTORY,
    abi: uniswapV3FactoryAbi,
    eventName: "PoolCreated",
    onLogs: async (logs) => {
      await processRawLogs(client, "v3", logs as unknown as Log[], emit, enrichDelayMs);
    },
    onError: (err) => {
      logLine(`v3 watch error: ${err.message}`);
    },
  });
  unwatchers.push(unwatchV3);
  logLine(`WSS watching Uniswap V3 factory ${ADDRESSES.UNISWAP_V3_FACTORY}`);

  return unwatchers;
}

export async function startIngest(
  client: RhPublicClient,
  config: AppConfig,
  onCandidate: CandidateHandler,
): Promise<() => void> {
  const unwatchers: Array<() => void> = [];
  const seen = new Set<string>();
  const queue: CandidateToken[] = [];
  let draining = false;

  const emit = async (candidate: CandidateToken) => {
    const key = candidate.token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 5_000) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    queue.push(candidate);
    if (!draining) {
      draining = true;
      while (queue.length) {
        const next = queue.shift();
        if (next) await onCandidate(next);
      }
      draining = false;
    }
  };

  if (config.wssRpcUrl) {
    logLine("using WSS subscriptions (recommended)");
    unwatchers.push(...startWssWatchers(client, emit, config.ENRICH_DELAY_MS));
  } else {
    logLine(
      "no WSS_RPC_URL — single HTTP poller only (viem watchers disabled to avoid double eth_getLogs)",
    );
    unwatchers.push(startHttpPoller(client, config, emit));
  }

  return () => {
    for (const u of unwatchers) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
  };
}

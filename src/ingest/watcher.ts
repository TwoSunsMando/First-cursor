import type { Address, Log } from "viem";
import { formatEther, getAddress, parseAbiItem } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";
import { applyRiskFilters } from "../risk/filters.js";
import { scoreCandidate } from "../signals/score.js";
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
  readV3PoolFee,
  readV3WethLiquidityEth,
} from "../chain/pricing.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";

export type CandidateHandler = (candidate: CandidateToken) => Promise<void>;

function logLine(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

export async function handleCandidate(
  candidate: CandidateToken,
  config: AppConfig,
  db: BotDb,
  paper: PaperEngine,
  live: LiveGateway | null,
): Promise<void> {
  const mode = config.EXECUTION_MODE;
  const scored = scoreCandidate(candidate);
  const risk = applyRiskFilters(candidate, config, db, mode);

  let action = scored.action;
  const reasons = [...scored.reasons];
  if (!risk.ok) {
    action = "SKIP";
    reasons.push(...risk.reasons.map((r) => `risk: ${r}`));
  }

  const signalId = db.insertSignal({
    token: candidate.token,
    symbol: candidate.symbol,
    name: candidate.name,
    dex: candidate.dex,
    pair_or_pool: candidate.pairOrPool,
    fee: candidate.fee,
    score: scored.score,
    action,
    reasons: reasons.join("; "),
    initial_liquidity_eth: candidate.initialLiquidityEth,
    tx_hash: candidate.txHash,
  });

  logLine(
    `SIGNAL ${action} ${candidate.symbol} (${candidate.token}) score=${scored.score.toFixed(1)} dex=${candidate.dex} #${signalId}`,
  );
  for (const r of reasons.slice(0, 6)) {
    logLine(`  · ${r}`);
  }

  if (action !== "BUY") return;

  if (mode === "paper") {
    await paper.tryOpenFromSignal(candidate, signalId);
    return;
  }

  if (live) {
    await live.requestBuyApproval(candidate, signalId);
  }
}

export async function startIngest(
  client: RhPublicClient,
  config: AppConfig,
  onCandidate: CandidateHandler,
): Promise<() => void> {
  const unwatchers: Array<() => void> = [];
  const seen = new Set<string>();

  const emit = async (candidate: CandidateToken) => {
    const key = candidate.token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    // Bound memory
    if (seen.size > 5_000) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    await onCandidate(candidate);
  };

  // --- NOXA TokenLaunched ---
  try {
    const unwatchNoxa = client.watchContractEvent({
      address: ADDRESSES.NOXA_LAUNCH_FACTORY,
      abi: noxaFactoryAbi,
      eventName: "TokenLaunched",
      onLogs: async (logs) => {
        for (const log of logs) {
          try {
            const args = log.args as {
              token?: Address;
              name?: string;
              symbol?: string;
              initialBuyEth?: bigint;
            };
            if (!args.token) continue;
            const token = getAddress(args.token);
            const name = args.name ?? "Unknown";
            const symbol = args.symbol ?? "???";
            const initialBuy = args.initialBuyEth
              ? Number(formatEther(args.initialBuyEth))
              : null;

            await emit({
              token,
              name,
              symbol,
              dex: "noxa",
              pairOrPool: token,
              fee: null,
              initialLiquidityEth: initialBuy,
              txHash: log.transactionHash ?? null,
              source: "noxa",
            });
          } catch (err) {
            logLine(`noxa log error: ${(err as Error).message}`);
          }
        }
      },
      onError: (err) => logLine(`noxa watch error: ${err.message}`),
    });
    unwatchers.push(unwatchNoxa);
    logLine(`watching NOXA factory ${ADDRESSES.NOXA_LAUNCH_FACTORY}`);
  } catch (err) {
    logLine(`NOXA watch failed to start: ${(err as Error).message}`);
  }

  // --- Uniswap V2 PairCreated ---
  try {
    const unwatchV2 = client.watchContractEvent({
      address: ADDRESSES.UNISWAP_V2_FACTORY,
      abi: uniswapV2FactoryAbi,
      eventName: "PairCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          try {
            const args = log.args as {
              token0?: Address;
              token1?: Address;
              pair?: Address;
            };
            if (!args.token0 || !args.token1 || !args.pair) continue;
            const token0 = getAddress(args.token0);
            const token1 = getAddress(args.token1);
            const pair = getAddress(args.pair);
            const token = otherToken(token0, token1, ADDRESSES.WETH);
            if (!token) continue;

            const meta = await readTokenMeta(client, token);
            const liq = await readV2WethLiquidityEth(client, pair);

            await emit({
              token,
              name: meta.name,
              symbol: meta.symbol,
              dex: "v2",
              pairOrPool: pair,
              fee: null,
              initialLiquidityEth: liq,
              txHash: log.transactionHash ?? null,
              source: "uniswap_v2",
            });
          } catch (err) {
            logLine(`v2 log error: ${(err as Error).message}`);
          }
        }
      },
      onError: (err) => logLine(`v2 watch error: ${err.message}`),
    });
    unwatchers.push(unwatchV2);
    logLine(`watching Uniswap V2 factory ${ADDRESSES.UNISWAP_V2_FACTORY}`);
  } catch (err) {
    logLine(`V2 watch failed to start: ${(err as Error).message}`);
  }

  // --- Uniswap V3 PoolCreated ---
  try {
    const unwatchV3 = client.watchContractEvent({
      address: ADDRESSES.UNISWAP_V3_FACTORY,
      abi: uniswapV3FactoryAbi,
      eventName: "PoolCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          try {
            const args = log.args as {
              token0?: Address;
              token1?: Address;
              pool?: Address;
              fee?: number | bigint;
            };
            if (!args.token0 || !args.token1 || !args.pool) continue;
            const token0 = getAddress(args.token0);
            const token1 = getAddress(args.token1);
            const pool = getAddress(args.pool);
            const fee = Number(args.fee ?? 0);
            const token = otherToken(token0, token1, ADDRESSES.WETH);
            if (!token) continue;

            const meta = await readTokenMeta(client, token);
            const liq = await readV3WethLiquidityEth(client, pool);

            await emit({
              token,
              name: meta.name,
              symbol: meta.symbol,
              dex: "v3",
              pairOrPool: pool,
              fee: fee || (await readV3PoolFee(client, pool)),
              initialLiquidityEth: liq,
              txHash: log.transactionHash ?? null,
              source: "uniswap_v3",
            });
          } catch (err) {
            logLine(`v3 log error: ${(err as Error).message}`);
          }
        }
      },
      onError: (err) => logLine(`v3 watch error: ${err.message}`),
    });
    unwatchers.push(unwatchV3);
    logLine(`watching Uniswap V3 factory ${ADDRESSES.UNISWAP_V3_FACTORY}`);
  } catch (err) {
    logLine(`V3 watch failed to start: ${(err as Error).message}`);
  }

  // Fallback polling via getLogs if WSS is unavailable — poll recent blocks periodically
  if (!config.wssRpcUrl) {
    logLine("no WSS_RPC_URL set — using HTTP polling fallback (slower, may miss events)");
    let lastBlock = await client.getBlockNumber();
    const pairCreatedEvent = parseAbiItem(
      "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
    );
    const poolCreatedEvent = parseAbiItem(
      "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
    );
    const tokenLaunchedEvent = parseAbiItem(
      "event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint256 initialBuyEth)",
    );

    const interval = setInterval(async () => {
      try {
        const latest = await client.getBlockNumber();
        if (latest <= lastBlock) return;
        const fromBlock = lastBlock + 1n;
        const toBlock = latest;

        const [v2Logs, v3Logs, noxaLogs] = await Promise.all([
          client.getLogs({
            address: ADDRESSES.UNISWAP_V2_FACTORY,
            event: pairCreatedEvent,
            fromBlock,
            toBlock,
          }),
          client.getLogs({
            address: ADDRESSES.UNISWAP_V3_FACTORY,
            event: poolCreatedEvent,
            fromBlock,
            toBlock,
          }),
          client.getLogs({
            address: ADDRESSES.NOXA_LAUNCH_FACTORY,
            event: tokenLaunchedEvent,
            fromBlock,
            toBlock,
          }),
        ]);

        for (const log of noxaLogs as Log[]) {
          const args = (log as Log & { args?: Record<string, unknown> }).args;
          if (!args?.token) continue;
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
        }

        for (const log of v2Logs as Log[]) {
          const args = (log as Log & { args?: Record<string, unknown> }).args;
          if (!args?.token0 || !args?.token1 || !args?.pair) continue;
          const token0 = getAddress(args.token0 as Address);
          const token1 = getAddress(args.token1 as Address);
          const pair = getAddress(args.pair as Address);
          const token = otherToken(token0, token1, ADDRESSES.WETH);
          if (!token) continue;
          const meta = await readTokenMeta(client, token);
          const liq = await readV2WethLiquidityEth(client, pair);
          await emit({
            token,
            name: meta.name,
            symbol: meta.symbol,
            dex: "v2",
            pairOrPool: pair,
            fee: null,
            initialLiquidityEth: liq,
            txHash: log.transactionHash ?? null,
            source: "uniswap_v2",
          });
        }

        for (const log of v3Logs as Log[]) {
          const args = (log as Log & { args?: Record<string, unknown> }).args;
          if (!args?.token0 || !args?.token1 || !args?.pool) continue;
          const token0 = getAddress(args.token0 as Address);
          const token1 = getAddress(args.token1 as Address);
          const pool = getAddress(args.pool as Address);
          const token = otherToken(token0, token1, ADDRESSES.WETH);
          if (!token) continue;
          const meta = await readTokenMeta(client, token);
          const liq = await readV3WethLiquidityEth(client, pool);
          await emit({
            token,
            name: meta.name,
            symbol: meta.symbol,
            dex: "v3",
            pairOrPool: pool,
            fee: args.fee ? Number(args.fee) : null,
            initialLiquidityEth: liq,
            txHash: log.transactionHash ?? null,
            source: "uniswap_v3",
          });
        }

        lastBlock = latest;
      } catch (err) {
        logLine(`poll error: ${(err as Error).message}`);
      }
    }, Math.max(config.POLL_INTERVAL_MS, 8_000));

    unwatchers.push(() => clearInterval(interval));
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

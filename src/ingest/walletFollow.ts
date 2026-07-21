import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  getAddress,
  encodeEventTopics,
  parseAbiItem,
  type Address,
  type Log,
  type Hex,
  zeroAddress,
} from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import type { PaperEngine } from "../paper/engine.js";
import type { LiveGateway } from "../live/gateway.js";
import type { RhPublicClient } from "../chain/client.js";
import { ADDRESSES } from "../chain/addresses.js";
import { parseWalletList, resolveWethPool } from "../chain/resolvePool.js";
import { readTokenMeta } from "../chain/pricing.js";
import { handleCandidate } from "./watcher.js";
import { fetchTokenMomentumExtras } from "./dexpaprika.js";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const TRANSFER_TOPIC = encodeEventTopics({
  abi: [TRANSFER_EVENT],
  eventName: "Transfer",
})[0] as Hex;

const STABLES = new Set([
  ADDRESSES.WETH.toLowerCase(),
  ADDRESSES.USDG.toLowerCase(),
]);

function padAddressTopic(addr: Address): Hex {
  return `0x${addr.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
}

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadFollowWallets(config: AppConfig): Address[] {
  const fromEnv = parseWalletList(config.WALLET_FOLLOW_ADDRESSES);
  const filePath = config.WALLET_FOLLOW_FILE?.trim();
  if (!filePath) return fromEnv;
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) {
    logLine(`wallet-follow: file missing ${abs}`);
    return fromEnv;
  }
  try {
    const text = readFileSync(abs, "utf8");
    const fromFile = parseWalletList(text);
    const seen = new Set(fromEnv.map((a) => a.toLowerCase()));
    const merged = [...fromEnv];
    for (const a of fromFile) {
      const k = a.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(a);
    }
    return merged;
  } catch (err) {
    logLine(`wallet-follow: failed to read ${abs}: ${(err as Error).message}`);
    return fromEnv;
  }
}

/**
 * Copy-trade style signal: watch ERC20 Transfer → followed wallets,
 * resolve a WETH pool, emit source=wallet_follow into the same paper/live path.
 *
 * Drop a list in data/wallets.txt (one 0x address per line) or set
 * WALLET_FOLLOW_ADDRESSES=0x...,0x...
 */
export function startWalletFollowPoller(
  config: AppConfig,
  db: BotDb,
  paper: PaperEngine,
  live: LiveGateway | null,
  client: RhPublicClient,
): () => void {
  if (!config.WALLET_FOLLOW_ENABLED) {
    logLine("wallet-follow disabled (WALLET_FOLLOW_ENABLED=false)");
    return () => undefined;
  }

  let wallets = loadFollowWallets(config);
  const intervalMs = Math.max(config.WALLET_FOLLOW_INTERVAL_MS, 15_000);
  const cooldownMs = config.WALLET_FOLLOW_COOLDOWN_MS;
  const maxBlocks = Math.max(20, Math.min(config.MAX_BLOCKS_PER_POLL, 120));
  const lastEmit = new Map<string, number>(); // token|wallet → ts
  let cursor: bigint | null = null;
  let busy = false;
  let stopped = false;
  let reloadAt = 0;

  if (wallets.length === 0) {
    logLine(
      "wallet-follow on — waiting for addresses in WALLET_FOLLOW_FILE / WALLET_FOLLOW_ADDRESSES",
    );
  } else {
    logLine(
      `wallet-follow: ${wallets.length} wallet(s), every ${intervalMs}ms, cooldown ${Math.round(cooldownMs / 1000)}s`,
    );
    for (const w of wallets.slice(0, 8)) {
      logLine(`  · follow ${w}`);
    }
    if (wallets.length > 8) logLine(`  · … +${wallets.length - 8} more`);
  }

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      // Hot-reload wallet file every ~2 min so you can drop in new addresses
      if (Date.now() - reloadAt > 120_000) {
        reloadAt = Date.now();
        const next = loadFollowWallets(config);
        if (next.length !== wallets.length) {
          logLine(`wallet-follow: reloaded ${next.length} wallet(s)`);
        }
        wallets = next;
      }
      if (wallets.length === 0) return;

      const latest = await client.getBlockNumber();
      if (cursor == null) {
        cursor = latest > BigInt(maxBlocks) ? latest - BigInt(maxBlocks) : 0n;
      }
      if (cursor >= latest) return;

      let toBlock = cursor + BigInt(maxBlocks);
      if (toBlock > latest) toBlock = latest;
      const fromBlock = cursor + 1n;

      const toTopics = wallets.map(padAddressTopic);
      // Raw topics filter (OR on `to`) — viem's typed getLogs doesn't expose this overload cleanly.
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
            topics: [TRANSFER_TOPIC, null, toTopics],
          },
        ],
      })) as Log[];

      cursor = toBlock;

      if (logs.length === 0) return;

      const now = Date.now();
      let emitted = 0;
      const seenToken = new Set<string>();

      for (const log of logs) {
        const token = log.address ? getAddress(log.address) : null;
        if (!token) continue;
        if (STABLES.has(token.toLowerCase())) continue;

        const topics = log.topics ?? [];
        // topics[1]=from, topics[2]=to
        const fromTopic = topics[1];
        const toTopic = topics[2];
        if (!fromTopic || !toTopic) continue;
        const from = getAddress(`0x${fromTopic.slice(-40)}`);
        const to = getAddress(`0x${toTopic.slice(-40)}`);
        if (from === zeroAddress && config.WALLET_FOLLOW_SKIP_MINTS) continue;
        if (!wallets.some((w) => w.toLowerCase() === to.toLowerCase())) continue;

        const tokenKey = token.toLowerCase();
        // One candidate per token per tick (multi-wallet same buy → once)
        if (seenToken.has(tokenKey)) continue;
        seenToken.add(tokenKey);

        const coolKey = `${tokenKey}|${to.toLowerCase()}`;
        const prev = lastEmit.get(coolKey) ?? 0;
        if (now - prev < cooldownMs) continue;
        lastEmit.set(coolKey, now);

        const pool = await resolveWethPool(client, token);
        if (!pool) {
          logLine(`wallet-follow skip ${token}: no WETH pool`);
          continue;
        }
        if (
          pool.liquidityEth != null &&
          pool.liquidityEth < config.MIN_INITIAL_LIQUIDITY_ETH
        ) {
          logLine(
            `wallet-follow skip ${token}: liq ${pool.liquidityEth.toFixed(4)} < min`,
          );
          continue;
        }

        const meta = await readTokenMeta(client, token);
        const extras = await fetchTokenMomentumExtras(token);
        const candidate = {
          token,
          symbol: meta.symbol,
          name: meta.name,
          dex: pool.dex,
          pairOrPool: pool.pairOrPool,
          fee: pool.fee,
          initialLiquidityEth: pool.liquidityEth,
          txHash: (log.transactionHash as `0x${string}` | null) ?? null,
          source: "wallet_follow",
        };

        logLine(
          `wallet-follow HIT ${meta.symbol} ← ${to.slice(0, 8)}… ` +
            `liq=${pool.liquidityEth?.toFixed(3) ?? "?"} ${pool.dex} tx=${candidate.txHash?.slice(0, 10) ?? "?"}`,
        );

        await handleCandidate(
          candidate,
          config,
          db,
          paper,
          live,
          {
            ...extras,
            // Tag confirming edge via score path; wallet itself is the edge
          },
          client,
        );
        emitted += 1;
      }

      if (emitted > 0 || logs.length > 5) {
        logLine(
          `wallet-follow scan blocks ${fromBlock}→${toBlock}: transfers=${logs.length} emitted=${emitted}`,
        );
      }

      if (lastEmit.size > 3_000) {
        for (const [k, t] of lastEmit) {
          if (now - t > cooldownMs * 4) lastEmit.delete(k);
        }
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (/too many requests|429|rate limit/i.test(msg)) {
        logLine("wallet-follow: RPC rate limit — backing off");
        await new Promise((r) => setTimeout(r, 15_000));
      } else {
        console.error(`wallet-follow error: ${msg}`);
      }
    } finally {
      busy = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

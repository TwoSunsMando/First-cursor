/**
 * One-shot smoke test: RPC connectivity + synthetic paper open/close path.
 * Run: npx tsx src/smoke.ts
 */
import { loadConfig } from "./config.js";
import { BotDb } from "./db/schema.js";
import { createRhHttpClient } from "./chain/client.js";
import { PaperEngine } from "./paper/engine.js";
import { handleCandidate } from "./ingest/watcher.js";
import { robinhoodChain, ADDRESSES } from "./chain/addresses.js";
import type { CandidateToken } from "./risk/filters.js";
import { getAddress } from "viem";

async function main() {
  const config = loadConfig();
  // Force paper for smoke
  (config as { EXECUTION_MODE: string }).EXECUTION_MODE = "paper";

  const dbPath = "./data/smoke.db";
  config.DB_PATH = dbPath;

  const db = new BotDb(dbPath);
  const client = createRhHttpClient(config);
  const paper = new PaperEngine(config, db, client);

  const chainId = await client.getChainId();
  const block = await client.getBlockNumber();
  console.log(`RPC ok chainId=${chainId} block=${block}`);
  if (chainId !== robinhoodChain.id) {
    throw new Error(`expected chain ${robinhoodChain.id}, got ${chainId}`);
  }

  // Read WETH symbol as a basic contract call
  const { readTokenMeta } = await import("./chain/pricing.js");
  const weth = await readTokenMeta(client, ADDRESSES.WETH);
  console.log(`WETH meta: ${weth.symbol} decimals=${weth.decimals}`);

  const candidate: CandidateToken = {
    token: getAddress("0x1111111111111111111111111111111111111111"),
    symbol: "SMOKE",
    name: "Smoke Test Token",
    dex: "v2",
    pairOrPool: getAddress("0x2222222222222222222222222222222222222222"),
    fee: null,
    initialLiquidityEth: 1.5,
    txHash: null,
    source: "uniswap_v2",
  };

  // Bypass deny filters for synthetic — use a high-liquidity BUY path via direct paper open
  // First verify scoring + risk via handleCandidate (may SKIP if quotes fail — that's ok)
  await handleCandidate(candidate, config, db, paper, null);

  // Force a paper position regardless of quote availability
  await paper.tryOpenFromSignal(candidate, db.insertSignal({
    token: candidate.token,
    symbol: candidate.symbol,
    name: candidate.name,
    dex: candidate.dex,
    pair_or_pool: candidate.pairOrPool,
    fee: null,
    score: 99,
    action: "BUY",
    reasons: "smoke forced",
    initial_liquidity_eth: 1.5,
    tx_hash: null,
    source: "smoke",
  }));

  console.log(paper.report());
  console.log(`open positions: ${db.countOpenPositions("paper")}`);

  // Simulate TP exit by closing with fake high price via DB helpers
  const opens = db.listOpenPositions("paper");
  for (const p of opens) {
    db.closePosition(p.id, {
      exit_price_eth: p.entry_price_eth * 2,
      exit_reason: "smoke_take_profit",
      pnl_eth: p.size_eth,
      pnl_pct: 100,
    });
  }
  console.log(paper.report());
  console.log("smoke ok");
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * One-shot smoke test: RPC connectivity + synthetic paper open/close + moon trim path.
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
import { evaluateMoonUpgrade } from "./moon/detect.js";
import { decideMoonExit, decideScoutExit } from "./moon/exits.js";

async function main() {
  const config = loadConfig();
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

  await handleCandidate(candidate, config, db, paper, null);

  const signalId = db.insertSignal({
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
    source: "uniswap_v2",
  });

  await paper.tryOpenFromSignal(candidate, signalId);

  console.log(await paper.report());
  console.log(`open positions: ${db.countOpenPositions("paper")}`);

  // --- Moon unit checks (no live quotes required) ---
  const opens = db.listOpenPositions("paper");
  if (!opens.length) throw new Error("expected open smoke position");
  const pos = opens[0];

  const scoutTp = decideScoutExit(70, 10, config);
  if (!scoutTp?.reason.startsWith("take_profit")) {
    throw new Error(`expected scout TP, got ${scoutTp?.reason}`);
  }

  const moonEval = evaluateMoonUpgrade(
    pos,
    "uniswap_v2",
    40,
    12,
    { volumeEth15m: 1.2, uniqueBuyers: 10, priceChange15mPct: 22 },
    config,
    db,
    "paper",
  );
  if (!moonEval.promote) {
    throw new Error(`expected moon promote, got ${JSON.stringify(moonEval)}`);
  }
  db.promoteToMoon(pos.id, moonEval.reasons.join("; "));
  let moonPos = db.getPosition(pos.id)!;
  if (moonPos.book !== "moon") throw new Error("promote failed");

  // First trim at +65%
  const entry = moonPos.entry_price_eth;
  const px65 = entry * 1.65;
  db.updatePositionPeak(moonPos.id, px65);
  moonPos = db.getPosition(moonPos.id)!;
  const trim1 = decideMoonExit(moonPos, px65, 65, 15, config);
  if (trim1.kind !== "trim" || trim1.trimBit !== 0) {
    throw new Error(`expected TP trim, got ${JSON.stringify(trim1)}`);
  }
  const origTokens = BigInt(moonPos.original_token_amount || "1000000");
  // Ensure non-zero tokens for partial math
  if (BigInt(moonPos.token_amount) === 0n) {
    db.db
      .prepare(
        `UPDATE positions SET token_amount = ?, original_token_amount = ? WHERE id = ?`,
      )
      .run("1000000", "1000000", moonPos.id);
    moonPos = db.getPosition(moonPos.id)!;
  }
  const tokensSold =
    (BigInt(moonPos.original_token_amount) *
      BigInt(Math.round(trim1.fractionOfOriginal * 1_000_000))) /
    1_000_000n;
  db.applyPartialExit(moonPos.id, {
    sizeEthSold: (moonPos.original_size_eth || moonPos.size_eth) * trim1.fractionOfOriginal,
    tokenAmountSold: tokensSold > 0n ? tokensSold : origTokens / 3n,
    trimBit: 0,
    pnlEth: 0.002,
    exitPriceEth: px65,
    armBreakeven: true,
  });
  moonPos = db.getPosition(moonPos.id)!;
  if ((moonPos.moon_trim_mask & 1) === 0) throw new Error("trim bit0 not set");
  if (!moonPos.breakeven_stop) throw new Error("breakeven not armed");
  console.log(
    `moon trim ok: rem_size=${moonPos.size_eth.toFixed(4)} mask=${moonPos.moon_trim_mask}`,
  );

  // Trail close after giveback from peak
  const peakPx = entry * 4; // +300%
  db.updatePositionPeak(moonPos.id, peakPx);
  moonPos = db.getPosition(moonPos.id)!;
  const nowPx = entry * 2.5; // +150%, giveback 150 points from 300 → should trail if giveback>=30
  const trail = decideMoonExit(moonPos, nowPx, 150, 20, config);
  if (trail.kind !== "close" || !trail.reason.startsWith("moon_trail")) {
    throw new Error(`expected moon_trail, got ${JSON.stringify(trail)}`);
  }
  console.log(`moon trail ok: ${trail.reason}`);

  // Close remaining for report
  for (const p of db.listOpenPositions("paper")) {
    db.closePosition(p.id, {
      exit_price_eth: p.entry_price_eth * 2,
      exit_reason: "smoke_moon_done",
      pnl_eth: (p.realized_partial_pnl_eth ?? 0) + p.size_eth,
      pnl_pct: 100,
    });
  }
  console.log(await paper.report());
  console.log("smoke ok");
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

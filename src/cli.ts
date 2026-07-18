#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BotDb } from "./db/schema.js";
import {
  createRhHttpClient,
  createRhPublicClient,
  createRhWalletClient,
} from "./chain/client.js";
import { PaperEngine } from "./paper/engine.js";
import { LiveGateway } from "./live/gateway.js";
import { handleCandidate, startIngest } from "./ingest/watcher.js";
import { robinhoodChain } from "./chain/addresses.js";
import { formatLessonsReport, runLearningPass } from "./learning/engine.js";
import { printTrendingOnce, startTrendingPoller } from "./ingest/trending.js";

function usage() {
  console.log(`rh-chain-paper-bot — Robinhood Chain meme scanner

Usage:
  npm run scan                 Start scanner (paper by default)
  npm run trending             One-shot DexPaprika trending / boost list
  npm run status               Mode, equity, open counts
  npm run report               Paper P&L report
  npm run positions            List open positions
  npm run learn                Mine closed paper trades → lessons
  npm run lessons              Show lessons (ACTIVE ones affect Learning Mode)
  npm run pending              List pending live approvals
  npm run approve -- <id>      Approve and execute a pending live order
  npm run start -- reject <id> Reject a pending approval

Learning Mode (paper only):
  Set LEARNING_MODE=true in .env, run scan, periodically run learn
  Active lessons adjust entry scores from historical win/loss buckets

Trending (DexPaprika):
  TRENDING_ENABLED=true polls top volume/txn pools + recent boosts into the scorer

Env: copy .env.example → .env
Docs: https://docs.robinhood.com/chain/
`);
}

async function cmdScan() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const http = createRhHttpClient(config);
  const watchClient = createRhPublicClient(config);
  const paper = new PaperEngine(config, db, http);

  let live: LiveGateway | null = null;
  if (config.EXECUTION_MODE === "live") {
    const wallet = createRhWalletClient(config);
    live = new LiveGateway(config, db, http, wallet);
    console.log(`LIVE mode wallet=${wallet.account.address}`);
    console.log(
      `caps: max_buy=${config.MAX_BUY_ETH} ETH, max_daily=${config.MAX_DAILY_ETH} ETH, slippage=${config.MAX_SLIPPAGE_BPS} bps`,
    );
  } else {
    console.log("PAPER mode (set EXECUTION_MODE=live for real swaps + approvals)");
  }
  console.log(
    `thresholds: BUY≥${config.BUY_SCORE_THRESHOLD} WATCH≥${config.WATCH_SCORE_THRESHOLD} minLiq=${config.MIN_INITIAL_LIQUIDITY_ETH} ETH`,
  );
  console.log(
    `trending weights: momentum×${config.TRENDING_MOMENTUM_SCALE} maxOpen=${config.MAX_TRENDING_OPEN_POSITIONS}/${config.MAX_OPEN_POSITIONS}`,
  );
  if (config.LEARNING_MODE) {
    if (config.EXECUTION_MODE !== "paper") {
      console.warn("LEARNING_MODE is set but EXECUTION_MODE is not paper — lessons will not apply");
    } else {
      console.log(
        `LEARNING MODE on (minSamples=${config.LEARN_MIN_SAMPLES}, relearn every ${config.LEARN_INTERVAL_MS || "manual-only"}ms)`,
      );
      const boot = runLearningPass(db, config.LEARN_MIN_SAMPLES);
      for (const line of boot.summaryLines) console.log(`  ${line}`);
    }
  }

  const chainId = await http.getChainId();
  const block = await http.getBlockNumber();
  console.log(
    `connected chainId=${chainId} (expect ${robinhoodChain.id}) block=${block}`,
  );
  if (chainId !== robinhoodChain.id) {
    console.warn("WARNING: chain id mismatch — check RPC_URL");
  }

  const stopIngest = await startIngest(watchClient, config, (c) =>
    handleCandidate(c, config, db, paper, live),
  );
  const stopTrending = startTrendingPoller(config, db, paper, live);

  const timer = setInterval(async () => {
    try {
      await paper.markToMarketAndExit();
      if (live) await live.maybeRequestSellApprovals();
    } catch (err) {
      console.error(`mark/exit error: ${(err as Error).message}`);
    }
  }, config.markIntervalMs);

  let learnTimer: ReturnType<typeof setInterval> | undefined;
  if (config.LEARNING_MODE && config.LEARN_INTERVAL_MS > 0) {
    learnTimer = setInterval(() => {
      try {
        const result = runLearningPass(db, config.LEARN_MIN_SAMPLES);
        console.log(`[learn] ${result.summaryLines.join(" | ")}`);
      } catch (err) {
        console.error(`learn error: ${(err as Error).message}`);
      }
    }, config.LEARN_INTERVAL_MS);
  }

  const shutdown = () => {
    console.log("shutting down…");
    clearInterval(timer);
    if (learnTimer) clearInterval(learnTimer);
    stopTrending();
    stopIngest();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("scanning… Ctrl+C to stop");
}

function cmdStatus() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const stats = db.paperStats();
  const liveOpen = db.countOpenPositions("live");
  const pending = db.listPendingApprovals().length;
  const spent = db.getDailySpend();
  const activeLessons = db.listLessons(true).length;
  console.log(`mode:           ${config.EXECUTION_MODE}`);
  console.log(`learning:       ${config.LEARNING_MODE ? "on" : "off"} (${activeLessons} active lessons)`);
  console.log(`trending:       ${config.TRENDING_ENABLED ? "on" : "off"} (DexPaprika)`);
  console.log(`rpc:            ${config.RPC_URL}`);
  console.log(`wss:            ${config.wssRpcUrl ?? "(http poll fallback)"}`);
  console.log(`paper open:     ${stats.open}`);
  console.log(`paper closed:   ${stats.closed}`);
  console.log(`paper PnL:      ${stats.realized_pnl_eth.toFixed(6)} ETH`);
  console.log(`live open:      ${liveOpen}`);
  console.log(`pending approves: ${pending}`);
  console.log(`daily spend:    ${spent.toFixed(6)} / ${config.MAX_DAILY_ETH} ETH`);
  db.close();
}

function cmdReport() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const http = createRhHttpClient(config);
  const paper = new PaperEngine(config, db, http);
  console.log(paper.report());
  const closed = db.listClosedPositions(10);
  if (closed.length) {
    console.log("\nRecent closed:");
    for (const p of closed) {
      console.log(
        `  #${p.id} ${p.mode} ${p.symbol} pnl=${(p.pnl_eth ?? 0).toFixed(5)} ETH (${(p.pnl_pct ?? 0).toFixed(1)}%) — ${p.exit_reason}`,
      );
    }
  }
  db.close();
}

function cmdPositions() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const opens = db.listOpenPositions();
  if (!opens.length) {
    console.log("No open positions.");
    db.close();
    return;
  }
  for (const p of opens) {
    console.log(
      `#${p.id} [${p.mode}] ${p.symbol} ${p.token}\n` +
        `  size=${p.size_eth} ETH entry=${p.entry_price_eth} dex=${p.dex} opened=${p.opened_at}`,
    );
  }
  db.close();
}

function cmdPending() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const rows = db.listPendingApprovals();
  if (!rows.length) {
    console.log("No pending approvals.");
    db.close();
    return;
  }
  for (const a of rows) {
    console.log(
      `#${a.id} ${a.side.toUpperCase()} ${a.symbol} ${a.size_eth} ETH expires=${a.expires_at}\n` +
        `  token=${a.token}\n  ${a.notes ?? ""}`,
    );
  }
  db.close();
}

async function cmdApprove(idStr: string) {
  const id = Number(idStr);
  if (!Number.isFinite(id)) throw new Error("usage: approve <id>");
  const config = loadConfig();
  if (config.EXECUTION_MODE !== "live") {
    throw new Error("Set EXECUTION_MODE=live and PRIVATE_KEY to approve/execute");
  }
  const db = new BotDb(config.DB_PATH);
  const http = createRhHttpClient(config);
  const wallet = createRhWalletClient(config);
  const live = new LiveGateway(config, db, http, wallet);
  await live.approve(id);
  db.close();
}

async function cmdReject(idStr: string) {
  const id = Number(idStr);
  if (!Number.isFinite(id)) throw new Error("usage: reject <id>");
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  // reject does not need wallet
  const http = createRhHttpClient(config);
  if (config.privateKey) {
    const wallet = createRhWalletClient(config);
    const live = new LiveGateway(config, db, http, wallet);
    await live.reject(id);
  } else {
    db.expireStaleApprovals();
    const row = db.getApproval(id);
    if (!row || row.status !== "pending") throw new Error(`cannot reject #${id}`);
    db.setApprovalStatus(id, "rejected");
    console.log(`approval #${id} rejected`);
  }
  db.close();
}

function cmdLearn() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const result = runLearningPass(db, config.LEARN_MIN_SAMPLES);
  for (const line of result.summaryLines) console.log(line);
  console.log("");
  console.log(formatLessonsReport(db));
  db.close();
}

function cmdLessons() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  console.log(formatLessonsReport(db));
  db.close();
}

async function cmdTrending() {
  const config = loadConfig();
  await printTrendingOnce(config);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    case "scan":
      await cmdScan();
      break;
    case "trending":
      await cmdTrending();
      break;
    case "status":
      cmdStatus();
      break;
    case "report":
      cmdReport();
      break;
    case "positions":
      cmdPositions();
      break;
    case "learn":
      cmdLearn();
      break;
    case "lessons":
      cmdLessons();
      break;
    case "pending":
      cmdPending();
      break;
    case "approve":
      await cmdApprove(arg);
      break;
    case "reject":
      await cmdReject(arg);
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

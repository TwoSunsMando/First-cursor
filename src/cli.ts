#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { BotDb } from "./db/schema.js";
import {
  createRhHttpClient,
  createRhWalletClient,
} from "./chain/client.js";
import { PaperEngine } from "./paper/engine.js";
import { LiveGateway } from "./live/gateway.js";
import { formatLessonsReport, runLearningPass } from "./learning/engine.js";
import { printTrendingOnce } from "./ingest/trending.js";
import { formatEthUsdSize, formatPnl, getEthUsd } from "./util/money.js";
import { BotRunner } from "./bot/runner.js";
import { startUiServer } from "./ui/server.js";
import { applyRuntimeOverrides } from "./runtime/configStore.js";

function usage() {
  console.log(`rh-chain-paper-bot — Robinhood Chain meme scanner

Usage:
  npm run ui                   Dashboard (start/stop bot, params, positions)
  npm run scan                 Start scanner in terminal (paper by default)
  npm run trending             One-shot DexPaprika trending / boost list
  npm run status               Mode, equity, open counts
  npm run report               Paper P&L report
  npm run positions            List open positions
  npm run learn                Mine closed paper trades → lessons
  npm run lessons              Show lessons (ACTIVE ones affect Learning Mode)
  npm run pending              List pending live approvals
  npm run approve -- <id>      Approve and execute a pending live order
  npm run start -- reject <id> Reject a pending approval

Dashboard:
  npm run ui  →  http://127.0.0.1:8787  (UI_PORT / UI_HOST)

Do not run npm run scan and npm run ui at the same time (one bot process).

Env: copy .env.example → .env
Docs: https://docs.robinhood.com/chain/
`);
}

async function cmdScan() {
  const config = loadConfig();
  const runner = new BotRunner(config);
  applyRuntimeOverrides(runner.db, config);

  await runner.start();
  console.log("scanning… Ctrl+C to stop");

  const shutdown = async () => {
    console.log("shutting down…");
    await runner.stop();
    runner.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function cmdUi() {
  const config = loadConfig();
  const runner = new BotRunner(config);
  applyRuntimeOverrides(runner.db, config);

  const port = Number(process.env.UI_PORT || 8787);
  const host = process.env.UI_HOST || "127.0.0.1";
  const server = await startUiServer({ config, runner, port, host });

  console.log(`UI http://${server.host}:${server.port}`);
  if (config.EXECUTION_MODE === "live") {
    console.log("╔══════════════════════════════════════╗");
    console.log("║           MODE = LIVE                ║");
    console.log("║  Real funds — approve buys carefully ║");
    console.log("╚══════════════════════════════════════╝");
  } else {
    console.log("┌──────────────────────────────────────┐");
    console.log("│           MODE = PAPER               │");
    console.log("│  Simulated only — no real orders     │");
    console.log("└──────────────────────────────────────┘");
  }
  console.log("Use Start in the dashboard (or POST /api/start). Ctrl+C to stop.");

  const shutdown = async () => {
    console.log("shutting down…");
    await runner.stop();
    await server.close();
    runner.db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function cmdStatus() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const stats = db.paperStats();
  const liveOpen = db.countOpenPositions("live");
  const pending = db.listPendingApprovals().length;
  const spent = db.getDailySpend();
  const activeLessons = db.listLessons(true).length;
  const ethUsd = await getEthUsd().catch(() => 0);
  console.log(`mode:           ${config.EXECUTION_MODE}`);
  console.log(`learning:       ${config.LEARNING_MODE ? "on" : "off"} (${activeLessons} active lessons)`);
  console.log(`trending:       ${config.TRENDING_ENABLED ? "on" : "off"} (DexPaprika)`);
  console.log(
    `moon:           ${config.MOON_ENABLED ? `on (max ${config.MAX_MOON_POSITIONS})` : "off"}`,
  );
  console.log(`rpc:            ${config.RPC_URL}`);
  console.log(`wss:            ${config.wssRpcUrl ?? "(http poll fallback)"}`);
  if (ethUsd > 0) console.log(`ETH price:      $${ethUsd.toFixed(2)}`);
  console.log(`paper open:     ${stats.open}`);
  console.log(`paper closed:   ${stats.closed}`);
  console.log(
    `paper PnL:      ${
      ethUsd > 0
        ? formatPnl(stats.realized_pnl_eth, ethUsd)
        : `${stats.realized_pnl_eth.toFixed(6)} ETH`
    }`,
  );
  console.log(`live open:      ${liveOpen}`);
  console.log(`pending approves: ${pending}`);
  console.log(
    `daily spend:    ${
      ethUsd > 0
        ? `${formatEthUsdSize(spent, ethUsd)} / ${formatEthUsdSize(config.MAX_DAILY_ETH, ethUsd)}`
        : `${spent.toFixed(6)} / ${config.MAX_DAILY_ETH} ETH`
    }`,
  );
  db.close();
}

async function cmdReport() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const http = createRhHttpClient(config);
  const paper = new PaperEngine(config, db, http);
  console.log(await paper.report());
  const closed = db.listClosedPositions(10);
  const ethUsd = await getEthUsd().catch(() => 0);
  if (closed.length) {
    console.log("\nRecent closed:");
    for (const p of closed) {
      const pnl =
        ethUsd > 0
          ? formatPnl(p.pnl_eth ?? 0, ethUsd, p.pnl_pct)
          : `${(p.pnl_eth ?? 0).toFixed(5)} ETH (${(p.pnl_pct ?? 0).toFixed(1)}%)`;
      console.log(`  #${p.id} ${p.mode} ${p.symbol} pnl=${pnl} — ${p.exit_reason}`);
    }
  }
  db.close();
}

async function cmdPositions() {
  const config = loadConfig();
  const db = new BotDb(config.DB_PATH);
  const opens = db.listOpenPositions();
  if (!opens.length) {
    console.log("No open positions.");
    db.close();
    return;
  }
  const ethUsd = await getEthUsd().catch(() => 0);
  for (const p of opens) {
    const size =
      ethUsd > 0 ? formatEthUsdSize(p.size_eth, ethUsd) : `${p.size_eth} ETH`;
    const book = p.book ?? "scout";
    const moonExtra =
      book === "moon"
        ? ` trims=0b${(p.moon_trim_mask ?? 0).toString(2)} peak=${p.peak_price_eth} partial=${(p.realized_partial_pnl_eth ?? 0).toFixed(5)} ETH`
        : "";
    console.log(
      `#${p.id} [${p.mode}/${book}] ${p.symbol} ${p.token}\n` +
        `  size=${size} entry=${p.entry_price_eth} dex=${p.dex} opened=${p.opened_at}${moonExtra}`,
    );
    if (p.moon_reasons) console.log(`  moon: ${p.moon_reasons}`);
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
    case "ui":
      await cmdUi();
      break;
    case "trending":
      await cmdTrending();
      break;
    case "status":
      await cmdStatus();
      break;
    case "report":
      await cmdReport();
      break;
    case "positions":
      await cmdPositions();
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

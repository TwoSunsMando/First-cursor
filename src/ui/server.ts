import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "viem";
import { formatEther } from "viem";
import type { AppConfig } from "../config.js";
import type { BotRunner } from "../bot/runner.js";
import { getRuntimeTradeParams, setRuntimeTradeParams } from "../runtime/configStore.js";
import { createRhHttpClient } from "../chain/client.js";
import { quoteTokenPriceEth, readTokenMeta } from "../chain/pricing.js";
import { getEthUsd } from "../util/money.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../../public/ui");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function startUiServer(opts: {
  config: AppConfig;
  runner: BotRunner;
  port?: number;
  host?: string;
}): Promise<{ port: number; host: string; close: () => Promise<void> }> {
  const port = opts.port ?? Number(process.env.UI_PORT || 8787);
  const host = opts.host ?? (process.env.UI_HOST || "127.0.0.1");
  const { config, runner } = opts;
  const httpClient = createRhHttpClient(config);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        await handleApi(req, res, path, runner, config, httpClient);
        return;
      }

      const filePath =
        path === "/" ? join(ROOT, "index.html") : join(ROOT, path.replace(/^\//, ""));
      if (!filePath.startsWith(ROOT)) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      const buf = await readFile(filePath);
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
      res.end(buf);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("ENOENT")) {
        res.writeHead(404).end("Not found");
        return;
      }
      console.error(`ui error: ${msg}`);
      sendJson(res, 500, { error: msg });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        port,
        host,
        close: () =>
          new Promise((resClose, rej) => {
            server.close((err) => (err ? rej(err) : resClose()));
          }),
      });
    });
  });
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  runner: BotRunner,
  config: AppConfig,
  httpClient: ReturnType<typeof createRhHttpClient>,
) {
  const method = req.method || "GET";

  if (path === "/api/heartbeat" && method === "GET") {
    sendJson(res, 200, runner.getHeartbeat());
    return;
  }

  if (path === "/api/start" && method === "POST") {
    const hb = await runner.start();
    sendJson(res, 200, hb);
    return;
  }

  if (path === "/api/stop" && method === "POST") {
    const hb = await runner.stop();
    sendJson(res, 200, hb);
    return;
  }

  if (path === "/api/params" && method === "GET") {
    sendJson(res, 200, getRuntimeTradeParams(runner.db, config));
    return;
  }

  if (path === "/api/params" && method === "POST") {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    const patch: Parameters<typeof setRuntimeTradeParams>[2] = {};
    if (body.TAKE_PROFIT_PERCENT != null) patch.TAKE_PROFIT_PERCENT = Number(body.TAKE_PROFIT_PERCENT);
    if (body.STOP_LOSS_PERCENT != null) patch.STOP_LOSS_PERCENT = Number(body.STOP_LOSS_PERCENT);
    if (body.MAX_HOLD_MINUTES != null) patch.MAX_HOLD_MINUTES = Number(body.MAX_HOLD_MINUTES);
    if (body.MAX_OPEN_POSITIONS != null) patch.MAX_OPEN_POSITIONS = Number(body.MAX_OPEN_POSITIONS);
    const next = setRuntimeTradeParams(runner.db, config, patch);
    sendJson(res, 200, next);
    return;
  }

  if (path === "/api/dashboard" && method === "GET") {
    sendJson(res, 200, await buildDashboard(runner, config, httpClient));
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

async function buildDashboard(
  runner: BotRunner,
  config: AppConfig,
  httpClient: ReturnType<typeof createRhHttpClient>,
) {
  const db = runner.db;
  const params = getRuntimeTradeParams(db, config);
  const heartbeat = runner.getHeartbeat();
  const ethUsd = await getEthUsd().catch(() => 0);
  const mode = config.EXECUTION_MODE;
  const stats = db.paperStats();
  const starting = Number(db.getMeta("paper_starting_equity") ?? config.PAPER_STARTING_EQUITY_ETH);
  const opens = db.listOpenPositions(mode === "live" ? "live" : "paper");
  const pending = db.listPendingApprovals();

  const positions = [];
  for (const p of opens) {
    let mark = p.entry_price_eth;
    try {
      const meta = await readTokenMeta(httpClient, p.token as Address);
      mark =
        (await quoteTokenPriceEth(
          httpClient,
          p.token as Address,
          p.dex === "noxa" ? "v2" : p.dex,
          p.pair_or_pool as Address,
          p.fee,
          meta.decimals,
        )) ?? p.entry_price_eth;
    } catch {
      /* keep entry */
    }
    const pnlPct =
      p.entry_price_eth > 0 ? ((mark - p.entry_price_eth) / p.entry_price_eth) * 100 : 0;
    const unrealized = (pnlPct / 100) * p.size_eth;
    positions.push({
      id: p.id,
      symbol: p.symbol,
      token: p.token,
      book: p.book ?? "scout",
      dex: p.dex,
      sizeEth: p.size_eth,
      entryPriceEth: p.entry_price_eth,
      markPriceEth: mark,
      pnlPct,
      unrealizedEth: unrealized,
      unrealizedUsd: ethUsd > 0 ? unrealized * ethUsd : null,
      openedAt: p.opened_at,
      moonReasons: p.moon_reasons,
      trimMask: p.moon_trim_mask ?? 0,
      partialPnlEth: p.realized_partial_pnl_eth ?? 0,
    });
  }

  const openNotional = positions.reduce((s, p) => s + p.sizeEth, 0);
  const unrealizedTotal = positions.reduce((s, p) => s + p.unrealizedEth, 0);
  const realized = mode === "paper" ? stats.realized_pnl_eth : 0;
  const equity = starting + realized;
  const equityMtm = equity + unrealizedTotal;

  let walletEth: number | null = null;
  if (mode === "live" && config.privateKey) {
    try {
      const { createRhWalletClient } = await import("../chain/client.js");
      const wallet = createRhWalletClient(config);
      const bal = await httpClient.getBalance({ address: wallet.account.address });
      walletEth = Number(formatEther(bal));
    } catch {
      walletEth = null;
    }
  }

  return {
    heartbeat,
    mode,
    ethUsd,
    params,
    balance: {
      startingEth: starting,
      realizedPnlEth: realized,
      unrealizedPnlEth: unrealizedTotal,
      equityEth: equity,
      equityMtmEth: equityMtm,
      openNotionalEth: openNotional,
      walletEth,
      startingUsd: ethUsd > 0 ? starting * ethUsd : null,
      realizedPnlUsd: ethUsd > 0 ? realized * ethUsd : null,
      unrealizedPnlUsd: ethUsd > 0 ? unrealizedTotal * ethUsd : null,
      equityMtmUsd: ethUsd > 0 ? equityMtm * ethUsd : null,
    },
    paperStats: {
      open: stats.open,
      closed: stats.closed,
      wins: stats.wins,
      losses: stats.losses,
      moonOpen: stats.moon_open,
      winRate: stats.closed > 0 ? (stats.wins / stats.closed) * 100 : null,
    },
    positions,
    orders: pending.map((a) => ({
      id: a.id,
      side: a.side,
      symbol: a.symbol,
      token: a.token,
      sizeEth: a.size_eth,
      status: a.status,
      expiresAt: a.expires_at,
      notes: a.notes,
      positionId: a.position_id,
    })),
    caps: {
      maxBuyEth: config.MAX_BUY_ETH,
      maxDailyEth: config.MAX_DAILY_ETH,
      dailySpentEth: db.getDailySpend(),
    },
    moon: {
      enabled: config.MOON_ENABLED,
      max: config.MAX_MOON_POSITIONS,
    },
    updatedAt: new Date().toISOString(),
  };
}

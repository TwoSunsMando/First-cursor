import type { AppConfig } from "../config.js";
import { BotDb } from "../db/schema.js";
import {
  createRhHttpClient,
  createRhPublicClient,
  createRhWalletClient,
} from "../chain/client.js";
import { PaperEngine } from "../paper/engine.js";
import { LiveGateway } from "../live/gateway.js";
import { handleCandidate, startIngest } from "../ingest/watcher.js";
import { startTrendingPoller } from "../ingest/trending.js";
import { runLearningPass } from "../learning/engine.js";
import { robinhoodChain } from "../chain/addresses.js";
import { applyRuntimeOverrides } from "../runtime/configStore.js";

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export type BotRunState = "stopped" | "starting" | "running" | "stopping";

export interface BotHeartbeat {
  state: BotRunState;
  running: boolean;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  mode: "paper" | "live";
  chainId: number | null;
  block: string | null;
  error: string | null;
}

/**
 * Controllable bot lifecycle for CLI scan and the dashboard UI.
 * Start/stop without exiting the process (UI keeps serving).
 */
export class BotRunner {
  readonly config: AppConfig;
  readonly db: BotDb;
  private paper: PaperEngine | null = null;
  private live: LiveGateway | null = null;
  private state: BotRunState = "stopped";
  private lastHeartbeatAt: string | null = null;
  private startedAt: string | null = null;
  private chainId: number | null = null;
  private block: string | null = null;
  private error: string | null = null;
  private stopIngest: (() => void) | null = null;
  private stopTrending: (() => void) | null = null;
  private markTimer: ReturnType<typeof setInterval> | null = null;
  private learnTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig, db?: BotDb) {
    this.config = config;
    this.db = db ?? new BotDb(config.DB_PATH);
    applyRuntimeOverrides(this.db, this.config);
  }

  getHeartbeat(): BotHeartbeat {
    return {
      state: this.state,
      running: this.state === "running",
      lastHeartbeatAt: this.lastHeartbeatAt,
      startedAt: this.startedAt,
      mode: this.config.EXECUTION_MODE,
      chainId: this.chainId,
      block: this.block,
      error: this.error,
    };
  }

  getPaper(): PaperEngine {
    if (!this.paper) {
      const http = createRhHttpClient(this.config);
      this.paper = new PaperEngine(this.config, this.db, http);
    }
    return this.paper;
  }

  getLive(): LiveGateway | null {
    return this.live;
  }

  /** Create or reuse live gateway for approve/reject from the UI. */
  ensureLiveGateway(): LiveGateway {
    if (this.config.EXECUTION_MODE !== "live") {
      throw new Error("Approvals require EXECUTION_MODE=live");
    }
    if (this.live) return this.live;
    const http = createRhHttpClient(this.config);
    const wallet = createRhWalletClient(this.config);
    this.live = new LiveGateway(this.config, this.db, http, wallet);
    if (!this.paper) {
      this.paper = new PaperEngine(this.config, this.db, http);
    }
    return this.live;
  }

  async approveOrder(id: number): Promise<void> {
    const live = this.ensureLiveGateway();
    await live.approve(id);
    this.beat();
  }

  async rejectOrder(id: number): Promise<void> {
    const live = this.ensureLiveGateway();
    await live.reject(id);
    this.beat();
  }

  private beat() {
    this.lastHeartbeatAt = new Date().toISOString();
  }

  async start(): Promise<BotHeartbeat> {
    if (this.state === "running" || this.state === "starting") {
      return this.getHeartbeat();
    }
    this.state = "starting";
    this.error = null;
    applyRuntimeOverrides(this.db, this.config);

    try {
      const http = createRhHttpClient(this.config);
      const watchClient = createRhPublicClient(this.config);
      this.paper = new PaperEngine(this.config, this.db, http);

      this.live = null;
      if (this.config.EXECUTION_MODE === "live") {
        const wallet = createRhWalletClient(this.config);
        this.live = new LiveGateway(this.config, this.db, http, wallet);
        logLine(`LIVE mode wallet=${wallet.account.address}`);
        if (this.config.AUTO_APPROVE_BUYS) {
          logLine("AUTO_APPROVE_BUYS=on — buys execute without Yes/No");
        }
        if (this.config.LIVE_LAUNCH_ONLY) {
          logLine("LIVE_LAUNCH_ONLY=on — buys only noxa/v2/v3 launches");
        }
        if (this.config.AUTO_SELL) {
          logLine("AUTO_SELL=on — exits/trims execute without Yes/No");
        }
      } else {
        logLine("PAPER mode");
      }

      logLine(
        `thresholds BUY≥${this.config.BUY_SCORE_THRESHOLD} TP=${this.config.TAKE_PROFIT_PERCENT}% SL=${this.config.STOP_LOSS_PERCENT}% hold=${this.config.MAX_HOLD_MINUTES}m maxOpen=${this.config.MAX_OPEN_POSITIONS}`,
      );
      if (this.config.MOON_ENABLED) {
        logLine(
          `moon runners on max=${this.config.MAX_MOON_POSITIONS} arm≥${this.config.MOON_ARM_PNL_PCT}%`,
        );
      }

      if (this.config.LEARNING_MODE && this.config.EXECUTION_MODE === "paper") {
        const boot = runLearningPass(this.db, this.config.LEARN_MIN_SAMPLES);
        for (const line of boot.summaryLines) logLine(`learn ${line}`);
      }

      this.chainId = Number(await http.getChainId());
      this.block = String(await http.getBlockNumber());
      logLine(
        `connected chainId=${this.chainId} (expect ${robinhoodChain.id}) block=${this.block}`,
      );
      if (this.chainId !== robinhoodChain.id) {
        logLine("WARNING: chain id mismatch — check RPC_URL");
      }

      const paper = this.paper;
      const live = this.live;
      this.stopIngest = await startIngest(watchClient, this.config, (c) => {
        this.beat();
        return handleCandidate(c, this.config, this.db, paper, live, {}, watchClient);
      });
      this.stopTrending = startTrendingPoller(
        this.config,
        this.db,
        paper,
        live,
        watchClient,
      );

      this.markTimer = setInterval(async () => {
        try {
          this.beat();
          applyRuntimeOverrides(this.db, this.config);
          await paper.markToMarketAndExit();
          if (live) await live.maybeRequestSellApprovals();
          this.block = String(await http.getBlockNumber().catch(() => this.block));
        } catch (err) {
          this.error = (err as Error).message;
          console.error(`mark/exit error: ${this.error}`);
        }
      }, this.config.markIntervalMs);

      if (this.config.LEARNING_MODE && this.config.LEARN_INTERVAL_MS > 0) {
        this.learnTimer = setInterval(() => {
          try {
            const result = runLearningPass(this.db, this.config.LEARN_MIN_SAMPLES);
            logLine(`learn ${result.summaryLines.join(" | ")}`);
          } catch (err) {
            console.error(`learn error: ${(err as Error).message}`);
          }
        }, this.config.LEARN_INTERVAL_MS);
      }

      this.heartbeatTimer = setInterval(() => this.beat(), 5_000);

      this.startedAt = new Date().toISOString();
      this.state = "running";
      this.beat();
      logLine("bot RUNNING");
      return this.getHeartbeat();
    } catch (err) {
      this.error = (err as Error).message;
      this.state = "stopped";
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<BotHeartbeat> {
    if (this.state === "stopped") return this.getHeartbeat();
    this.state = "stopping";
    logLine("bot STOPPING…");

    if (this.markTimer) clearInterval(this.markTimer);
    if (this.learnTimer) clearInterval(this.learnTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.markTimer = null;
    this.learnTimer = null;
    this.heartbeatTimer = null;

    try {
      this.stopTrending?.();
    } catch {
      /* ignore */
    }
    try {
      this.stopIngest?.();
    } catch {
      /* ignore */
    }
    this.stopTrending = null;
    this.stopIngest = null;
    this.live = null;
    // keep paper instance for report reads

    this.state = "stopped";
    this.beat();
    logLine("bot STOPPED");
    return this.getHeartbeat();
  }
}

import type { Address } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb } from "../db/schema.js";
import { getReentryBlock, type CandidateToken } from "../risk/filters.js";
import type { RhPublicClient } from "../chain/client.js";
import {
  quoteBuyTokensForEth,
  quoteTokenPriceEth,
  readTokenMeta,
} from "../chain/pricing.js";

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export class PaperEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly db: BotDb,
    private readonly client: RhPublicClient,
  ) {
    if (!this.db.getMeta("paper_starting_equity")) {
      this.db.setMeta(
        "paper_starting_equity",
        String(this.config.PAPER_STARTING_EQUITY_ETH),
      );
    }
  }

  async tryOpenFromSignal(candidate: CandidateToken, signalId: number): Promise<void> {
    if (this.db.countOpenPositions("paper") >= this.config.MAX_OPEN_POSITIONS) {
      logLine(`paper skip ${candidate.symbol}: max positions`);
      return;
    }
    if (this.db.hasOpenPositionForToken(candidate.token, "paper")) {
      logLine(`paper skip ${candidate.symbol}: already open`);
      return;
    }
    const isTrendingSrc =
      candidate.source === "trending" || candidate.source === "boost";
    if (
      isTrendingSrc &&
      this.config.MAX_TRENDING_OPEN_POSITIONS >= 0 &&
      this.db.countOpenTrendingPositions("paper") >= this.config.MAX_TRENDING_OPEN_POSITIONS
    ) {
      logLine(
        `paper skip ${candidate.symbol}: trending slot cap (${this.config.MAX_TRENDING_OPEN_POSITIONS})`,
      );
      return;
    }
    const reentry = getReentryBlock(
      candidate.token,
      candidate.symbol,
      this.config,
      this.db,
      "paper",
    );
    if (reentry) {
      logLine(`paper skip ${candidate.symbol}: ${reentry}`);
      return;
    }

    const sizeEth = this.config.PAPER_BUY_ETH;
    const meta = await readTokenMeta(this.client, candidate.token);
    const tokenAmount =
      (await quoteBuyTokensForEth(
        this.client,
        candidate.token,
        candidate.dex === "noxa" ? "v2" : candidate.dex,
        candidate.fee,
        sizeEth,
      )) ?? 0n;

    let entryPrice =
      (await quoteTokenPriceEth(
        this.client,
        candidate.token,
        candidate.dex === "noxa" ? "v2" : candidate.dex,
        candidate.pairOrPool,
        candidate.fee,
        meta.decimals,
      )) ?? 0;

    // If we got a token amount quote, derive entry from that
    if (tokenAmount > 0n) {
      const tokens = Number(tokenAmount) / 10 ** meta.decimals;
      if (tokens > 0) entryPrice = sizeEth / tokens;
    }

    if (entryPrice <= 0) {
      // Fallback: use a synthetic micro price so paper can still track relative moves later
      entryPrice = 1e-12;
      logLine(`paper warn ${candidate.symbol}: no quote, using synthetic entry`);
    }

    const id = this.db.openPosition({
      mode: "paper",
      token: candidate.token,
      symbol: candidate.symbol || meta.symbol,
      dex: candidate.dex,
      pair_or_pool: candidate.pairOrPool,
      fee: candidate.fee,
      entry_price_eth: entryPrice,
      size_eth: sizeEth,
      token_amount: tokenAmount.toString(),
      entry_tx: null,
      signal_id: signalId,
    });

    logLine(
      `PAPER OPEN #${id} ${candidate.symbol} size=${sizeEth} ETH entry≈${entryPrice.toExponential(3)} ETH/token`,
    );
  }

  async markToMarketAndExit(): Promise<void> {
    const opens = this.db.listOpenPositions("paper");
    for (const pos of opens) {
      const meta = await readTokenMeta(this.client, pos.token as Address);
      const price =
        (await quoteTokenPriceEth(
          this.client,
          pos.token as Address,
          pos.dex === "noxa" ? "v2" : pos.dex,
          pos.pair_or_pool as Address,
          pos.fee,
          meta.decimals,
        )) ?? pos.entry_price_eth;

      const pnlPct =
        pos.entry_price_eth > 0
          ? ((price - pos.entry_price_eth) / pos.entry_price_eth) * 100
          : 0;
      const pnlEth = (pnlPct / 100) * pos.size_eth;

      const openedMs = Date.parse(pos.opened_at);
      const holdMin = (Date.now() - openedMs) / 60_000;

      let exitReason: string | null = null;
      if (pnlPct >= this.config.TAKE_PROFIT_PERCENT) {
        exitReason = `take_profit ${pnlPct.toFixed(1)}%`;
      } else if (pnlPct <= -this.config.STOP_LOSS_PERCENT) {
        exitReason = `stop_loss ${pnlPct.toFixed(1)}%`;
      } else if (holdMin >= this.config.MAX_HOLD_MINUTES) {
        exitReason = `max_hold ${holdMin.toFixed(0)}m pnl=${pnlPct.toFixed(1)}%`;
      }

      if (!exitReason) continue;

      this.db.closePosition(pos.id, {
        exit_price_eth: price,
        exit_reason: exitReason,
        pnl_eth: pnlEth,
        pnl_pct: pnlPct,
      });
      logLine(
        `PAPER CLOSE #${pos.id} ${pos.symbol} ${exitReason} pnl=${pnlEth.toFixed(5)} ETH (${pnlPct.toFixed(1)}%)`,
      );
    }
  }

  report(): string {
    const stats = this.db.paperStats();
    const starting = Number(this.db.getMeta("paper_starting_equity") ?? "1");
    const openNotional = this.db
      .listOpenPositions("paper")
      .reduce((s, p) => s + p.size_eth, 0);
    const equity = starting + stats.realized_pnl_eth;
    const winRate =
      stats.closed > 0 ? ((stats.wins / stats.closed) * 100).toFixed(1) : "n/a";

    return [
      "=== Paper Report ===",
      `Starting equity: ${starting} ETH`,
      `Realized PnL:    ${stats.realized_pnl_eth.toFixed(6)} ETH`,
      `Equity (ex MTM): ${equity.toFixed(6)} ETH`,
      `Open positions:  ${stats.open} (notional ${openNotional.toFixed(4)} ETH)`,
      `Closed trades:   ${stats.closed} (W ${stats.wins} / L ${stats.losses}, win rate ${winRate}%)`,
      `TP/SL/Hold:      ${this.config.TAKE_PROFIT_PERCENT}% / ${this.config.STOP_LOSS_PERCENT}% / ${this.config.MAX_HOLD_MINUTES}m`,
    ].join("\n");
  }
}

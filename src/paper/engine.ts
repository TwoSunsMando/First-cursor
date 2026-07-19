import type { Address } from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb, PositionRow } from "../db/schema.js";
import { getReentryBlock, type CandidateToken } from "../risk/filters.js";
import type { RhPublicClient } from "../chain/client.js";
import {
  quoteBuyTokensForEth,
  quoteTokenPriceEth,
  readTokenMeta,
} from "../chain/pricing.js";
import { formatEthUsdSize, formatPnl, getEthUsd } from "../util/money.js";
import { fetchTokenMomentumExtras } from "../ingest/dexpaprika.js";
import { evaluateMoonUpgrade } from "../moon/detect.js";
import { decideMoonExit, decideScoutExit } from "../moon/exits.js";

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

    if (tokenAmount > 0n) {
      const tokens = Number(tokenAmount) / 10 ** meta.decimals;
      if (tokens > 0) entryPrice = sizeEth / tokens;
    }

    if (entryPrice <= 0) {
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

    const ethUsd = await getEthUsd().catch(() => 0);
    const sizeLabel = ethUsd > 0 ? formatEthUsdSize(sizeEth, ethUsd) : `${sizeEth} ETH`;
    logLine(
      `PAPER OPEN #${id} [scout] ${candidate.symbol} size=${sizeLabel} entry≈${entryPrice.toExponential(3)} ETH/token`,
    );
  }

  async markToMarketAndExit(): Promise<void> {
    const opens = this.db.listOpenPositions("paper");
    const ethUsd = opens.length ? await getEthUsd().catch(() => 0) : 0;
    for (const pos of opens) {
      await this.markOne(pos, ethUsd);
    }
  }

  private async markOne(pos: PositionRow, ethUsd: number): Promise<void> {
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

    this.db.updatePositionPeak(pos.id, price);
    // Refresh peak on local copy
    const peak = Math.max(pos.peak_price_eth || pos.entry_price_eth, price);
    pos = { ...pos, peak_price_eth: peak };

    const pnlPct =
      pos.entry_price_eth > 0
        ? ((price - pos.entry_price_eth) / pos.entry_price_eth) * 100
        : 0;
    const openedMs = Date.parse(pos.opened_at);
    const holdMin = (Date.now() - openedMs) / 60_000;
    const book = pos.book ?? "scout";

    // Scout → moon upgrade (entry already happened early)
    if (book === "scout" && this.config.MOON_ENABLED) {
      const source = this.db.getSignalSource(pos.signal_id);
      const extras = await fetchTokenMomentumExtras(pos.token, ethUsd || undefined);
      const evalMoon = evaluateMoonUpgrade(
        pos,
        source,
        pnlPct,
        holdMin,
        extras,
        this.config,
        this.db,
        "paper",
      );
      if (evalMoon.promote) {
        const why = evalMoon.reasons.join("; ");
        this.db.promoteToMoon(pos.id, why);
        pos = { ...pos, book: "moon", moon_reasons: why };
        logLine(
          `MOON UPGRADE #${pos.id} ${pos.symbol} score=${evalMoon.score} pnl=${pnlPct.toFixed(1)}% — ${why}`,
        );
      }
    }

    if ((pos.book ?? "scout") === "moon") {
      await this.applyMoonActions(pos, price, pnlPct, holdMin, ethUsd);
      return;
    }

    const scout = decideScoutExit(pnlPct, holdMin, this.config);
    if (!scout) return;

    const pnlEth = (pnlPct / 100) * pos.size_eth;
    this.db.closePosition(pos.id, {
      exit_price_eth: price,
      exit_reason: scout.reason,
      pnl_eth: pnlEth,
      pnl_pct: pnlPct,
    });
    const pnlLabel =
      ethUsd > 0
        ? formatPnl(pnlEth, ethUsd, pnlPct)
        : `${pnlEth.toFixed(5)} ETH (${pnlPct.toFixed(1)}%)`;
    logLine(`PAPER CLOSE #${pos.id} [scout] ${pos.symbol} ${scout.reason} pnl=${pnlLabel}`);
  }

  private async applyMoonActions(
    pos: PositionRow,
    price: number,
    pnlPct: number,
    holdMin: number,
    ethUsd: number,
  ): Promise<void> {
    // Re-read after possible prior trim in same tick (we loop trims once per mark)
    let current = this.db.getPosition(pos.id);
    if (!current || current.status !== "open") return;

    // Allow multiple trim stages if price skipped levels (e.g. jumped to +5x)
    for (let i = 0; i < 4; i++) {
      current = this.db.getPosition(pos.id);
      if (!current || current.status !== "open") return;

      const action = decideMoonExit(current, price, pnlPct, holdMin, this.config);
      if (action.kind === "none") return;

      if (action.kind === "close") {
        const remPnl = (pnlPct / 100) * current.size_eth;
        const totalPnl = (current.realized_partial_pnl_eth ?? 0) + remPnl;
        const orig = current.original_size_eth || current.size_eth;
        const totalPct = orig > 0 ? (totalPnl / orig) * 100 : pnlPct;
        this.db.closePosition(current.id, {
          exit_price_eth: price,
          exit_reason: action.reason,
          pnl_eth: totalPnl,
          pnl_pct: totalPct,
        });
        const pnlLabel =
          ethUsd > 0
            ? formatPnl(totalPnl, ethUsd, totalPct)
            : `${totalPnl.toFixed(5)} ETH (${totalPct.toFixed(1)}%)`;
        logLine(
          `PAPER CLOSE #${current.id} [moon] ${current.symbol} ${action.reason} pnl=${pnlLabel}`,
        );
        return;
      }

      // trim
      const originalSize = current.original_size_eth || current.size_eth;
      const originalTokens = BigInt(current.original_token_amount || current.token_amount || "0");
      let sizeSold = originalSize * action.fractionOfOriginal;
      if (sizeSold > current.size_eth) sizeSold = current.size_eth;

      let tokensSold = 0n;
      if (originalTokens > 0n) {
        // integer fraction of original
        tokensSold =
          (originalTokens * BigInt(Math.round(action.fractionOfOriginal * 1_000_000))) /
          1_000_000n;
        const rem = BigInt(current.token_amount || "0");
        if (tokensSold > rem) tokensSold = rem;
      }

      const trimPnl = (pnlPct / 100) * sizeSold;
      const applied = this.db.applyPartialExit(current.id, {
        sizeEthSold: sizeSold,
        tokenAmountSold: tokensSold,
        trimBit: action.trimBit,
        pnlEth: trimPnl,
        exitPriceEth: price,
        armBreakeven: action.armBreakeven,
      });

      const pnlLabel =
        ethUsd > 0
          ? formatPnl(trimPnl, ethUsd, pnlPct)
          : `${trimPnl.toFixed(5)} ETH`;
      logLine(
        `PAPER TRIM #${current.id} [moon] ${current.symbol} ${action.reason} banked=${pnlLabel}` +
          (applied ? ` rem=${applied.remainingSizeEth.toFixed(4)} ETH` : ""),
      );

      if (!applied || applied.remainingSizeEth <= 1e-12 || applied.remainingTokens === 0n) {
        const refreshed = this.db.getPosition(current.id);
        if (refreshed && refreshed.status === "open") {
          const totalPnl = refreshed.realized_partial_pnl_eth ?? 0;
          const orig = refreshed.original_size_eth || originalSize;
          this.db.closePosition(refreshed.id, {
            exit_price_eth: price,
            exit_reason: `${action.reason} (flat)`,
            pnl_eth: totalPnl,
            pnl_pct: orig > 0 ? (totalPnl / orig) * 100 : pnlPct,
          });
          logLine(`PAPER CLOSE #${refreshed.id} [moon] ${refreshed.symbol} fully scaled out`);
        }
        return;
      }
    }
  }

  async report(): Promise<string> {
    const stats = this.db.paperStats();
    const starting = Number(this.db.getMeta("paper_starting_equity") ?? "1");
    const openNotional = this.db
      .listOpenPositions("paper")
      .reduce((s, p) => s + p.size_eth, 0);
    const equity = starting + stats.realized_pnl_eth;
    const winRate =
      stats.closed > 0 ? ((stats.wins / stats.closed) * 100).toFixed(1) : "n/a";
    const ethUsd = await getEthUsd().catch(() => 0);
    const moonLine = this.config.MOON_ENABLED
      ? `Moon runners:    ${stats.moon_open}/${this.config.MAX_MOON_POSITIONS} (trim@${this.config.TAKE_PROFIT_PERCENT}% trail giveback ${this.config.MOON_TRAIL_GIVEBACK_PCT}%)`
      : `Moon runners:    off`;

    if (ethUsd <= 0) {
      return [
        "=== Paper Report ===",
        `Starting equity: ${starting} ETH`,
        `Realized PnL:    ${stats.realized_pnl_eth.toFixed(6)} ETH`,
        `Equity (ex MTM): ${equity.toFixed(6)} ETH`,
        `Open positions:  ${stats.open} (notional ${openNotional.toFixed(4)} ETH)`,
        moonLine,
        `Closed trades:   ${stats.closed} (W ${stats.wins} / L ${stats.losses}, win rate ${winRate}%)`,
        `Scout TP/SL/Hold:${this.config.TAKE_PROFIT_PERCENT}% / ${this.config.STOP_LOSS_PERCENT}% / ${this.config.MAX_HOLD_MINUTES}m`,
      ].join("\n");
    }

    return [
      "=== Paper Report ===",
      `ETH price:       $${ethUsd.toFixed(2)}`,
      `Starting equity: ${formatEthUsdSize(starting, ethUsd)}`,
      `Realized PnL:    ${formatPnl(stats.realized_pnl_eth, ethUsd)}`,
      `Equity (ex MTM): ${formatEthUsdSize(equity, ethUsd)}`,
      `Open positions:  ${stats.open} (notional ${formatEthUsdSize(openNotional, ethUsd)})`,
      moonLine,
      `Closed trades:   ${stats.closed} (W ${stats.wins} / L ${stats.losses}, win rate ${winRate}%)`,
      `Scout TP/SL/Hold:${this.config.TAKE_PROFIT_PERCENT}% / ${this.config.STOP_LOSS_PERCENT}% / ${this.config.MAX_HOLD_MINUTES}m`,
    ].join("\n");
  }
}

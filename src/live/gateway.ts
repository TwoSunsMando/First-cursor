import {
  formatEther,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb, DexKind } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";
import { ADDRESSES, EXPLORER_TX } from "../chain/addresses.js";
import {
  erc20Abi,
  swapRouter02Abi,
  uniswapV2RouterAbi,
} from "../chain/abis.js";
import type { RhPublicClient, RhWalletClient } from "../chain/client.js";
import {
  quoteBuyTokensForEth,
  quoteTokenPriceEth,
  readTokenMeta,
} from "../chain/pricing.js";

function logLine(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export class LiveGateway {
  constructor(
    private readonly config: AppConfig,
    private readonly db: BotDb,
    private readonly publicClient: RhPublicClient,
    private readonly walletClient: RhWalletClient,
  ) {}

  async requestBuyApproval(candidate: CandidateToken, signalId: number): Promise<void> {
    const sizeEth = this.config.MAX_BUY_ETH;
    const spent = this.db.getDailySpend();
    if (spent + sizeEth > this.config.MAX_DAILY_ETH) {
      logLine(
        `live skip ${candidate.symbol}: daily spend cap (${spent.toFixed(4)}+${sizeEth} > ${this.config.MAX_DAILY_ETH})`,
      );
      return;
    }
    if (this.db.countOpenPositions("live") >= this.config.MAX_OPEN_POSITIONS) {
      logLine(`live skip ${candidate.symbol}: max open positions`);
      return;
    }

    const expires = new Date(
      Date.now() + this.config.APPROVAL_TTL_SECONDS * 1000,
    ).toISOString();

    const id = this.db.createApproval({
      expires_at: expires,
      side: "buy",
      token: candidate.token,
      symbol: candidate.symbol,
      dex: candidate.dex,
      pair_or_pool: candidate.pairOrPool,
      fee: candidate.fee,
      size_eth: sizeEth,
      signal_id: signalId,
      notes: "pending human approval",
    });
    this.db.setApprovalStatus(id, "pending", {
      notes: `Run: npm run approve -- ${id}`,
    });

    logLine(
      `LIVE APPROVAL NEEDED #${id} BUY ${candidate.symbol} ${sizeEth} ETH (expires ${expires})`,
    );
    logLine(`  → npm run approve -- ${id}`);
  }

  async approve(id: number): Promise<void> {
    this.db.expireStaleApprovals();
    const row = this.db.getApproval(id);
    if (!row) throw new Error(`approval #${id} not found`);
    if (row.status !== "pending") {
      throw new Error(`approval #${id} is ${row.status}, not pending`);
    }

    this.db.setApprovalStatus(id, "approved");

    if (row.side === "buy") {
      await this.executeBuy(id);
    } else {
      await this.executeSell(id);
    }
  }

  async reject(id: number): Promise<void> {
    const row = this.db.getApproval(id);
    if (!row) throw new Error(`approval #${id} not found`);
    if (row.status !== "pending") throw new Error(`approval #${id} is ${row.status}`);
    this.db.setApprovalStatus(id, "rejected");
    logLine(`approval #${id} rejected`);
  }

  private async executeBuy(approvalId: number): Promise<void> {
    const row = this.db.getApproval(approvalId);
    if (!row) throw new Error("approval missing");

    const spent = this.db.getDailySpend();
    if (spent + row.size_eth > this.config.MAX_DAILY_ETH) {
      this.db.setApprovalStatus(approvalId, "rejected", {
        notes: "blocked by daily spend cap at execution time",
      });
      throw new Error("daily spend cap exceeded");
    }

    const account = this.walletClient.account.address;
    const token = row.token as Address;
    const dex: DexKind = row.dex;
    const amountIn = parseEther(row.size_eth.toFixed(18));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);

    const expectedOut =
      (await quoteBuyTokensForEth(
        this.publicClient,
        token,
        dex === "noxa" ? "v2" : dex,
        row.fee,
        row.size_eth,
      )) ?? 0n;
    const minOut =
      expectedOut === 0n
        ? 0n
        : (expectedOut * BigInt(10_000 - this.config.MAX_SLIPPAGE_BPS)) / 10_000n;

    let txHash: Hash;

    if (dex === "v3") {
      const fee = row.fee ?? 10000;
      txHash = await this.walletClient.writeContract({
        address: ADDRESSES.SWAP_ROUTER_02,
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: ADDRESSES.WETH,
            tokenOut: token,
            fee,
            recipient: account,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
        value: amountIn,
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
    } else {
      txHash = await this.walletClient.writeContract({
        address: ADDRESSES.UNISWAP_V2_ROUTER,
        abi: uniswapV2RouterAbi,
        functionName: "swapExactETHForTokens",
        args: [minOut, [ADDRESSES.WETH, token], account, deadline],
        value: amountIn,
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
    }

    logLine(`buy tx submitted ${EXPLORER_TX(txHash)}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      this.db.setApprovalStatus(approvalId, "rejected", {
        notes: `tx failed ${txHash}`,
        executed_tx: txHash,
      });
      throw new Error(`buy tx failed: ${txHash}`);
    }

    const balance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });

    const meta = await readTokenMeta(this.publicClient, token);
    let entryPrice =
      (await quoteTokenPriceEth(
        this.publicClient,
        token,
        dex === "noxa" ? "v2" : dex,
        row.pair_or_pool as Address,
        row.fee,
        meta.decimals,
      )) ?? 0;
    if (balance > 0n) {
      const tokens = Number(balance) / 10 ** meta.decimals;
      if (tokens > 0) entryPrice = row.size_eth / tokens;
    }

    const positionId = this.db.openPosition({
      mode: "live",
      token,
      symbol: row.symbol,
      dex,
      pair_or_pool: row.pair_or_pool,
      fee: row.fee,
      entry_price_eth: entryPrice || 1e-12,
      size_eth: row.size_eth,
      token_amount: balance.toString(),
      entry_tx: txHash,
      signal_id: row.signal_id,
    });

    this.db.addDailySpend(row.size_eth);
    this.db.setApprovalStatus(approvalId, "executed", { executed_tx: txHash });
    logLine(`LIVE OPEN #${positionId} ${row.symbol} ${row.size_eth} ETH tx=${txHash}`);
  }

  async maybeRequestSellApprovals(): Promise<void> {
    const opens = this.db.listOpenPositions("live");
    for (const pos of opens) {
      const meta = await readTokenMeta(this.publicClient, pos.token as Address);
      const price =
        (await quoteTokenPriceEth(
          this.publicClient,
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
      const holdMin = (Date.now() - Date.parse(pos.opened_at)) / 60_000;

      let reason: string | null = null;
      if (pnlPct >= this.config.TAKE_PROFIT_PERCENT) reason = `take_profit ${pnlPct.toFixed(1)}%`;
      else if (pnlPct <= -this.config.STOP_LOSS_PERCENT)
        reason = `stop_loss ${pnlPct.toFixed(1)}%`;
      else if (holdMin >= this.config.MAX_HOLD_MINUTES)
        reason = `max_hold ${holdMin.toFixed(0)}m`;

      if (!reason) continue;

      if (this.config.AUTO_SELL) {
        logLine(`AUTO_SELL #${pos.id} ${pos.symbol} ${reason}`);
        await this.executeSellPosition(pos.id, reason);
      } else {
        const expires = new Date(
          Date.now() + this.config.APPROVAL_TTL_SECONDS * 1000,
        ).toISOString();
        const id = this.db.createApproval({
          expires_at: expires,
          side: "sell",
          token: pos.token,
          symbol: pos.symbol,
          dex: pos.dex,
          pair_or_pool: pos.pair_or_pool,
          fee: pos.fee,
          size_eth: pos.size_eth,
          position_id: pos.id,
          notes: reason,
        });
        logLine(`SELL APPROVAL NEEDED #${id} for position #${pos.id}: ${reason}`);
        logLine(`  → npm run approve -- ${id}`);
      }
    }
  }

  private async executeSell(approvalId: number): Promise<void> {
    const row = this.db.getApproval(approvalId);
    if (!row?.position_id) throw new Error("sell approval missing position_id");
    await this.executeSellPosition(row.position_id, row.notes ?? "approved_sell", approvalId);
  }

  private async executeSellPosition(
    positionId: number,
    reason: string,
    approvalId?: number,
  ): Promise<void> {
    const pos = this.db.getPosition(positionId);
    if (!pos || pos.status !== "open" || pos.mode !== "live") {
      throw new Error(`live position #${positionId} not open`);
    }

    const account = this.walletClient.account.address;
    const token = pos.token as Address;
    const amountIn = BigInt(pos.token_amount);
    if (amountIn === 0n) {
      this.db.closePosition(positionId, {
        exit_price_eth: 0,
        exit_reason: `${reason} (zero balance)`,
        pnl_eth: -pos.size_eth,
        pnl_pct: -100,
      });
      return;
    }

    // Approve router
    const router =
      pos.dex === "v3" ? ADDRESSES.SWAP_ROUTER_02 : ADDRESSES.UNISWAP_V2_ROUTER;
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, router],
    });
    if (allowance < amountIn) {
      const approveHash = await this.walletClient.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [router, amountIn],
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const meta = await readTokenMeta(this.publicClient, token);
    const expectedEth =
      (await quoteTokenPriceEth(
        this.publicClient,
        token,
        pos.dex === "noxa" ? "v2" : pos.dex,
        pos.pair_or_pool as Address,
        pos.fee,
        meta.decimals,
      )) ?? 0;
    const tokens = Number(amountIn) / 10 ** meta.decimals;
    const expectedOutWei = parseEther((expectedEth * tokens).toFixed(18));
    const minOut =
      expectedOutWei === 0n
        ? 0n
        : (expectedOutWei * BigInt(10_000 - this.config.MAX_SLIPPAGE_BPS)) / 10_000n;

    let txHash: Hash;
    if (pos.dex === "v3") {
      const fee = pos.fee ?? 10000;
      txHash = await this.walletClient.writeContract({
        address: ADDRESSES.SWAP_ROUTER_02,
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: token,
            tokenOut: ADDRESSES.WETH,
            fee,
            recipient: account,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
    } else {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
      txHash = await this.walletClient.writeContract({
        address: ADDRESSES.UNISWAP_V2_ROUTER,
        abi: uniswapV2RouterAbi,
        functionName: "swapExactTokensForETH",
        args: [amountIn, minOut, [token, ADDRESSES.WETH], account, deadline],
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
    }

    logLine(`sell tx submitted ${EXPLORER_TX(txHash)}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new Error(`sell tx failed: ${txHash}`);
    }

    const exitPrice =
      (await quoteTokenPriceEth(
        this.publicClient,
        token,
        pos.dex === "noxa" ? "v2" : pos.dex,
        pos.pair_or_pool as Address,
        pos.fee,
        meta.decimals,
      )) ?? expectedEth;
    const pnlPct =
      pos.entry_price_eth > 0
        ? ((exitPrice - pos.entry_price_eth) / pos.entry_price_eth) * 100
        : 0;
    const pnlEth = (pnlPct / 100) * pos.size_eth;

    this.db.closePosition(positionId, {
      exit_price_eth: exitPrice,
      exit_reason: reason,
      pnl_eth: pnlEth,
      pnl_pct: pnlPct,
      exit_tx: txHash,
    });

    if (approvalId !== undefined) {
      this.db.setApprovalStatus(approvalId, "executed", { executed_tx: txHash });
    }

    logLine(
      `LIVE CLOSE #${positionId} ${pos.symbol} ${reason} pnl=${pnlEth.toFixed(5)} ETH (${pnlPct.toFixed(1)}%) out≈${formatEther(expectedOutWei)} ETH`,
    );
  }
}

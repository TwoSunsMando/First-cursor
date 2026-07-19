import {
  formatEther,
  parseEther,
  type Address,
  type Hash,
} from "viem";
import type { AppConfig } from "../config.js";
import type { BotDb, DexKind, PositionRow } from "../db/schema.js";
import type { CandidateToken } from "../risk/filters.js";
import { ADDRESSES, EXPLORER_TX } from "../chain/addresses.js";
import {
  erc20Abi,
  swapRouter02Abi,
  uniswapV2RouterAbi,
  wethAbi,
} from "../chain/abis.js";
import type { RhPublicClient, RhWalletClient } from "../chain/client.js";
import {
  quoteBuyTokensForEth,
  quoteTokenPriceEth,
  readTokenMeta,
  readV3PoolFee,
} from "../chain/pricing.js";
import {
  checkSellableRoundtrip,
  rereadPoolLiquidityEth,
} from "../risk/sellability.js";
import { formatPnl, getEthUsd } from "../util/money.js";
import { fetchTokenMomentumExtras } from "../ingest/dexpaprika.js";
import { evaluateMoonUpgrade } from "../moon/detect.js";
import { decideMoonExit, decideScoutExit } from "../moon/exits.js";

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
      notes: `Approve in UI (or: npm run approve -- ${id})`,
    });

    if (this.config.AUTO_APPROVE_BUYS) {
      logLine(
        `AUTO_APPROVE BUY #${id} ${candidate.symbol} ${sizeEth} ETH (signal #${signalId})`,
      );
      try {
        await this.approve(id);
      } catch (err) {
        logLine(`AUTO_APPROVE #${id} failed: ${(err as Error).message}`);
      }
      return;
    }

    logLine(
      `LIVE APPROVAL NEEDED #${id} BUY ${candidate.symbol} ${sizeEth} ETH (expires ${expires})`,
    );
    logLine(`  → UI Approve button (or npm run approve -- ${id})`);
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

    const ethBal = await this.publicClient.getBalance({ address: account });
    const wethBal =
      dex === "v3"
        ? await this.publicClient.readContract({
            address: ADDRESSES.WETH,
            abi: wethAbi,
            functionName: "balanceOf",
            args: [account],
          })
        : 0n;
    // V3 buy = wrap + approve + swap (up to 3 txs); leave extra gas headroom.
    const gasReserve = dex === "v3" ? parseEther("0.0012") : parseEther("0.0008");
    const needWrap = wethBal >= amountIn ? 0n : amountIn - wethBal;
    if (ethBal < needWrap + gasReserve) {
      const haveEth = Number(formatEther(ethBal));
      const haveWeth = Number(formatEther(wethBal));
      const msg =
        `Insufficient funds for buy: have ${haveEth.toFixed(6)} ETH` +
        (dex === "v3" ? ` + ${haveWeth.toFixed(6)} WETH` : "") +
        `, need ~${row.size_eth} in (ETH/WETH) + ${Number(formatEther(gasReserve))} gas. ` +
        `Lower MAX_BUY_ETH, unwrap/add funds, or reject this approval.`;
      this.db.setApprovalStatus(approvalId, "rejected", { notes: msg });
      throw new Error(msg);
    }

    // Re-check sellability + pool WETH at Yes — LP may have been pulled during TTL.
    const candidate: CandidateToken = {
      token,
      symbol: row.symbol,
      name: row.symbol,
      dex,
      pairOrPool: row.pair_or_pool as Address,
      fee: row.fee,
      initialLiquidityEth: null,
      txHash: null,
      source:
        dex === "noxa"
          ? "noxa"
          : dex === "v3"
            ? "uniswap_v3"
            : "uniswap_v2",
    };
    if (dex === "v2" || dex === "v3") {
      const liqNow = await rereadPoolLiquidityEth(this.publicClient, candidate);
      if (
        liqNow != null &&
        liqNow < this.config.MIN_LAUNCH_LIQUIDITY_ETH
      ) {
        const msg = `blocked at execute: pool WETH ${liqNow.toFixed(4)} < min launch ${this.config.MIN_LAUNCH_LIQUIDITY_ETH} (likely rug/pull)`;
        this.db.setApprovalStatus(approvalId, "rejected", { notes: msg });
        throw new Error(msg);
      }
      if (liqNow == null && this.config.REJECT_NULL_LIQUIDITY) {
        const msg = "blocked at execute: pool WETH unreadable";
        this.db.setApprovalStatus(approvalId, "rejected", { notes: msg });
        throw new Error(msg);
      }
    }
    const sellable = await checkSellableRoundtrip(
      this.publicClient,
      candidate,
      this.config,
      row.size_eth,
    );
    if (!sellable.ok) {
      const msg = `blocked at execute: ${sellable.reason}`;
      this.db.setApprovalStatus(approvalId, "rejected", { notes: msg });
      throw new Error(msg);
    }
    logLine(`execute gate ok: ${sellable.reason}`);

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
      // Reliable path on RH Chain: wrap ETH→WETH ourselves, then swap as ERC-20.
      // Sending native value into exactInputSingle often reverts with "TF"
      // (TransferFrom failed) when the router doesn't consume msg.value as WETH.
      txHash = await this.buyV3WithWrappedEth({
        token,
        amountIn,
        minOut,
        fee: row.fee,
        pairOrPool: row.pair_or_pool as Address,
        recipient: account,
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
    const ethUsd = opens.length ? await getEthUsd().catch(() => 0) : 0;
    for (let pos of opens) {
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

      this.db.updatePositionPeak(pos.id, price);
      pos = {
        ...pos,
        peak_price_eth: Math.max(pos.peak_price_eth || pos.entry_price_eth, price),
      };

      const pnlPct =
        pos.entry_price_eth > 0
          ? ((price - pos.entry_price_eth) / pos.entry_price_eth) * 100
          : 0;
      const holdMin = (Date.now() - Date.parse(pos.opened_at)) / 60_000;

      if ((pos.book ?? "scout") === "scout" && this.config.MOON_ENABLED) {
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
          "live",
        );
        if (evalMoon.promote) {
          const why = evalMoon.reasons.join("; ");
          this.db.promoteToMoon(pos.id, why);
          pos = { ...pos, book: "moon", moon_reasons: why };
          logLine(
            `MOON UPGRADE #${pos.id} ${pos.symbol} score=${evalMoon.score} — ${why}`,
          );
        }
      }

      if ((pos.book ?? "scout") === "moon") {
        await this.handleMoonLive(pos, price, pnlPct, holdMin);
        continue;
      }

      const scout = decideScoutExit(pnlPct, holdMin, this.config);
      if (!scout) continue;
      await this.requestOrExecuteSell(pos.id, scout.reason, pos.size_eth);
    }
  }

  private async handleMoonLive(
    pos: PositionRow,
    price: number,
    pnlPct: number,
    holdMin: number,
  ): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const current = this.db.getPosition(pos.id);
      if (!current || current.status !== "open") return;
      const action = decideMoonExit(current, price, pnlPct, holdMin, this.config);
      if (action.kind === "none") return;
      if (action.kind === "close") {
        await this.requestOrExecuteSell(current.id, action.reason, current.size_eth);
        return;
      }
      const originalSize = current.original_size_eth || current.size_eth;
      const originalTokens = BigInt(
        current.original_token_amount || current.token_amount || "0",
      );
      let sizeSold = originalSize * action.fractionOfOriginal;
      if (sizeSold > current.size_eth) sizeSold = current.size_eth;
      let tokensSold = 0n;
      if (originalTokens > 0n) {
        tokensSold =
          (originalTokens * BigInt(Math.round(action.fractionOfOriginal * 1_000_000))) /
          1_000_000n;
        const rem = BigInt(current.token_amount || "0");
        if (tokensSold > rem) tokensSold = rem;
      }
      if (this.config.AUTO_SELL) {
        logLine(`AUTO_SELL TRIM #${current.id} ${current.symbol} ${action.reason}`);
        await this.executeSellPosition(current.id, action.reason, undefined, {
          tokenAmount: tokensSold,
          sizeEthSold: sizeSold,
          trimBit: action.trimBit,
          armBreakeven: action.armBreakeven,
          pnlPct,
        });
      } else {
        await this.requestOrExecuteSell(
          current.id,
          action.reason,
          sizeSold,
          /* forceApproval */ true,
        );
        // Without AUTO_SELL, wait for human — don't loop more trims
        return;
      }
    }
  }

  private async requestOrExecuteSell(
    positionId: number,
    reason: string,
    sizeEth: number,
    forceApproval = false,
  ): Promise<void> {
    if (this.config.AUTO_SELL && !forceApproval) {
      logLine(`AUTO_SELL #${positionId} ${reason}`);
      await this.executeSellPosition(positionId, reason);
      return;
    }
    const pos = this.db.getPosition(positionId);
    if (!pos) return;
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
      size_eth: sizeEth,
      position_id: pos.id,
      notes: reason,
    });
        logLine(`SELL APPROVAL NEEDED #${id} for position #${pos.id}: ${reason}`);
        logLine(`  → UI Approve button (or npm run approve -- ${id})`);
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
    partial?: {
      tokenAmount: bigint;
      sizeEthSold: number;
      trimBit: number;
      armBreakeven: boolean;
      pnlPct: number;
    },
  ): Promise<void> {
    const pos = this.db.getPosition(positionId);
    if (!pos || pos.status !== "open" || pos.mode !== "live") {
      throw new Error(`live position #${positionId} not open`);
    }

    const account = this.walletClient.account.address;
    const token = pos.token as Address;
    const walletBal = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });

    const fullAmount = BigInt(pos.token_amount);
    let amountIn =
      partial && partial.tokenAmount > 0n && partial.tokenAmount < fullAmount
        ? partial.tokenAmount
        : fullAmount;

    // Never try to sell more than the wallet holds (tax tokens / dust mismatch).
    if (walletBal < amountIn) amountIn = walletBal;
    // Leave a tiny dust buffer for fee-on-transfer tokens.
    if (amountIn > 1000n) amountIn = (amountIn * 99n) / 100n;

    const isPartial = Boolean(partial) && amountIn < fullAmount && amountIn < walletBal;
    if (amountIn === 0n) {
      this.db.closePosition(positionId, {
        exit_price_eth: 0,
        exit_reason: `${reason} (zero balance)`,
        pnl_eth: -(pos.original_size_eth || pos.size_eth),
        pnl_pct: -100,
      });
      return;
    }

    // Approve router (max so fee-on-transfer sells don't stick on allowance)
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
        args: [router, 2n ** 256n - 1n],
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

    const wethBefore = await this.publicClient.readContract({
      address: ADDRESSES.WETH,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [account],
    });

    let txHash: Hash;
    if (pos.dex === "v3") {
      txHash = await this.sellV3ExactIn(token, amountIn, minOut, account, pos);
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

    // V3 router pays out WETH — unwrap to native ETH so MetaMask balance rises.
    if (pos.dex === "v3") {
      const wethAfter = await this.publicClient.readContract({
        address: ADDRESSES.WETH,
        abi: wethAbi,
        functionName: "balanceOf",
        args: [account],
      });
      const gained = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
      if (gained > 0n) {
        const unwrapHash = await this.walletClient.writeContract({
          address: ADDRESSES.WETH,
          abi: wethAbi,
          functionName: "withdraw",
          args: [gained],
          account: this.walletClient.account,
          chain: this.walletClient.chain,
        });
        await this.publicClient.waitForTransactionReceipt({ hash: unwrapHash });
        logLine(`unwrapped ${formatEther(gained)} WETH → ETH ${EXPLORER_TX(unwrapHash)}`);
      }
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
      partial?.pnlPct ??
      (pos.entry_price_eth > 0
        ? ((exitPrice - pos.entry_price_eth) / pos.entry_price_eth) * 100
        : 0);

    if (approvalId !== undefined) {
      this.db.setApprovalStatus(approvalId, "executed", { executed_tx: txHash });
    }

    const ethUsd = await getEthUsd().catch(() => 0);

    if (isPartial && partial) {
      const trimPnl = (pnlPct / 100) * partial.sizeEthSold;
      const applied = this.db.applyPartialExit(positionId, {
        sizeEthSold: partial.sizeEthSold,
        tokenAmountSold: amountIn,
        trimBit: partial.trimBit,
        pnlEth: trimPnl,
        exitPriceEth: exitPrice,
        armBreakeven: partial.armBreakeven,
      });
      const pnlLabel =
        ethUsd > 0 ? formatPnl(trimPnl, ethUsd, pnlPct) : `${trimPnl.toFixed(5)} ETH`;
      logLine(
        `LIVE TRIM #${positionId} ${pos.symbol} ${reason} banked=${pnlLabel} out≈${formatEther(expectedOutWei)} ETH` +
          (applied ? ` rem=${applied.remainingSizeEth.toFixed(4)} ETH` : ""),
      );
      if (applied && (applied.remainingSizeEth <= 1e-12 || applied.remainingTokens === 0n)) {
        const refreshed = this.db.getPosition(positionId);
        if (refreshed?.status === "open") {
          const total = refreshed.realized_partial_pnl_eth ?? 0;
          const orig = refreshed.original_size_eth || pos.size_eth;
          this.db.closePosition(positionId, {
            exit_price_eth: exitPrice,
            exit_reason: `${reason} (flat)`,
            pnl_eth: total,
            pnl_pct: orig > 0 ? (total / orig) * 100 : pnlPct,
            exit_tx: txHash,
          });
        }
      }
      return;
    }

    const remPnl = (pnlPct / 100) * pos.size_eth;
    const totalPnl = (pos.realized_partial_pnl_eth ?? 0) + remPnl;
    const orig = pos.original_size_eth || pos.size_eth;
    const totalPct = orig > 0 ? (totalPnl / orig) * 100 : pnlPct;

    this.db.closePosition(positionId, {
      exit_price_eth: exitPrice,
      exit_reason: reason,
      pnl_eth: totalPnl,
      pnl_pct: totalPct,
      exit_tx: txHash,
    });

    const pnlLabel =
      ethUsd > 0
        ? formatPnl(totalPnl, ethUsd, totalPct)
        : `${totalPnl.toFixed(5)} ETH (${totalPct.toFixed(1)}%)`;
    logLine(
      `LIVE CLOSE #${positionId} ${pos.symbol} ${reason} pnl=${pnlLabel} out≈${formatEther(expectedOutWei)} ETH`,
    );
  }

  /**
   * Wrap native ETH to WETH, approve router, swap WETH→token.
   * Avoids SwapRouter "TF" when payable exactInputSingle doesn't pull msg.value.
   */
  private async buyV3WithWrappedEth(opts: {
    token: Address;
    amountIn: bigint;
    minOut: bigint;
    fee: number | null;
    pairOrPool: Address;
    recipient: Address;
  }): Promise<Hash> {
    const { token, amountIn, minOut, recipient } = opts;

    // Use existing WETH first if user already has enough (from prior sells).
    const wethBal = await this.publicClient.readContract({
      address: ADDRESSES.WETH,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [opts.recipient],
    });
    if (wethBal < amountIn) {
      const need = amountIn - wethBal;
      const depHash = await this.walletClient.writeContract({
        address: ADDRESSES.WETH,
        abi: wethAbi,
        functionName: "deposit",
        args: [],
        value: need,
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: depHash });
      logLine(`wrapped ${formatEther(need)} ETH → WETH ${EXPLORER_TX(depHash)}`);
    }

    const allowance = await this.publicClient.readContract({
      address: ADDRESSES.WETH,
      abi: wethAbi,
      functionName: "allowance",
      args: [recipient, ADDRESSES.SWAP_ROUTER_02],
    });
    if (allowance < amountIn) {
      const apHash = await this.walletClient.writeContract({
        address: ADDRESSES.WETH,
        abi: wethAbi,
        functionName: "approve",
        args: [ADDRESSES.SWAP_ROUTER_02, 2n ** 256n - 1n],
        account: this.walletClient.account,
        chain: this.walletClient.chain,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: apHash });
    }

    let poolFee: number | null = opts.fee;
    try {
      poolFee = (await readV3PoolFee(this.publicClient, opts.pairOrPool)) ?? opts.fee;
    } catch {
      /* keep */
    }
    const fees = uniqueFees([poolFee, opts.fee, 10000, 3000, 500, 100]);
    let lastErr: Error | null = null;

    for (const fee of fees) {
      try {
        await this.publicClient.simulateContract({
          address: ADDRESSES.SWAP_ROUTER_02,
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: ADDRESSES.WETH,
              tokenOut: token,
              fee,
              recipient,
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
          account: this.walletClient.account,
        });

        const txHash = await this.walletClient.writeContract({
          address: ADDRESSES.SWAP_ROUTER_02,
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: ADDRESSES.WETH,
              tokenOut: token,
              fee,
              recipient,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
          account: this.walletClient.account,
          chain: this.walletClient.chain,
        });
        if (fee !== opts.fee) {
          logLine(`buy used fee tier ${fee} (stored was ${opts.fee ?? "null"})`);
        }
        return txHash;
      } catch (err) {
        lastErr = err as Error;
        const msg = lastErr.message || "";
        // Friendly decode of Uniswap TransferHelper error
        if (/\bTF\b/.test(msg) || msg.includes("TRANSFER_FROM_FAILED")) {
          logLine(`buy fee ${fee} TF (transfer failed) — trying next fee`);
        } else {
          logLine(`buy fee ${fee} failed: ${msg.slice(0, 120)}`);
        }
      }
    }

    throw new Error(
      `V3 buy reverted for ${token} (tried fees ${fees.join(",")}). ` +
        `TF usually means transfer/pool issue — skip this token. Last: ${lastErr?.message ?? "unknown"}`,
    );
  }

  /** V3 sell with pool fee resolution + fee-tier fallbacks. */
  private async sellV3ExactIn(
    token: Address,
    amountIn: bigint,
    minOut: bigint,
    recipient: Address,
    pos: PositionRow,
  ): Promise<Hash> {
    let poolFee: number | null = pos.fee;
    try {
      poolFee = (await readV3PoolFee(this.publicClient, pos.pair_or_pool as Address)) ?? pos.fee;
    } catch {
      /* keep stored fee */
    }

    const fees = uniqueFees([poolFee, pos.fee, 10000, 3000, 500, 100]);
    let lastErr: Error | null = null;

    for (const fee of fees) {
      try {
        // Simulate first so we don't burn gas on a known-bad fee tier
        await this.publicClient.simulateContract({
          address: ADDRESSES.SWAP_ROUTER_02,
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: token,
              tokenOut: ADDRESSES.WETH,
              fee,
              recipient,
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
          account: this.walletClient.account,
        });

        const txHash = await this.walletClient.writeContract({
          address: ADDRESSES.SWAP_ROUTER_02,
          abi: swapRouter02Abi,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: token,
              tokenOut: ADDRESSES.WETH,
              fee,
              recipient,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
          account: this.walletClient.account,
          chain: this.walletClient.chain,
        });
        if (fee !== pos.fee) {
          logLine(`sell used fee tier ${fee} (stored was ${pos.fee ?? "null"})`);
        }
        return txHash;
      } catch (err) {
        lastErr = err as Error;
        logLine(`sell fee ${fee} failed: ${lastErr.message.slice(0, 120)}`);
      }
    }

    throw new Error(
      `V3 sell reverted for ${pos.symbol} (tried fees ${fees.join(",")}). ` +
        `Often a honeypot / wrong pool / empty liquidity. Tokens may still be in wallet. ` +
        `Last: ${lastErr?.message ?? "unknown"}`,
    );
  }
}

function uniqueFees(fees: Array<number | null | undefined>): number[] {
  const out: number[] = [];
  for (const f of fees) {
    if (f == null || !Number.isFinite(f)) continue;
    const n = Number(f);
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out : [10000, 3000, 500];
}

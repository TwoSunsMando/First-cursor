import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";

export type SignalAction = "BUY" | "WATCH" | "SKIP";
export type PositionSide = "long";
export type PositionStatus = "open" | "closed";
export type ExecutionMode = "paper" | "live";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed";
export type DexKind = "v2" | "v3" | "noxa";
/** Scout = default TP/SL/hold. Moon = scale-out + trail after upgrade. */
export type PositionBook = "scout" | "moon";

export interface SignalRow {
  id: number;
  created_at: string;
  token: string;
  symbol: string;
  name: string;
  dex: DexKind;
  pair_or_pool: string;
  fee: number | null;
  score: number;
  action: SignalAction;
  reasons: string;
  initial_liquidity_eth: number | null;
  tx_hash: string | null;
  source: string | null;
}

export interface PositionRow {
  id: number;
  mode: ExecutionMode;
  status: PositionStatus;
  token: string;
  symbol: string;
  dex: DexKind;
  pair_or_pool: string;
  fee: number | null;
  entry_price_eth: number;
  size_eth: number;
  token_amount: string;
  opened_at: string;
  closed_at: string | null;
  exit_price_eth: number | null;
  exit_reason: string | null;
  pnl_eth: number | null;
  pnl_pct: number | null;
  entry_tx: string | null;
  exit_tx: string | null;
  signal_id: number | null;
  /** scout (default) or moon (runner scale-out / trail) */
  book: PositionBook;
  original_size_eth: number;
  original_token_amount: string;
  peak_price_eth: number;
  realized_partial_pnl_eth: number;
  /** Bitmask: bit0=+TP trim, bit1=+2x, bit2=+5x, bit3=+10x */
  moon_trim_mask: number;
  moon_reasons: string | null;
  moon_flagged_at: string | null;
  /** After first moon trim, stop moves to entry / trail */
  breakeven_stop: number;
}

export interface ApprovalRow {
  id: number;
  created_at: string;
  expires_at: string;
  status: ApprovalStatus;
  side: "buy" | "sell";
  token: string;
  symbol: string;
  dex: DexKind;
  pair_or_pool: string;
  fee: number | null;
  size_eth: number;
  signal_id: number | null;
  position_id: number | null;
  executed_tx: string | null;
  notes: string | null;
}

export interface SpendRow {
  day: string;
  spent_eth: number;
}

export type LessonKind =
  | "liquidity_bucket"
  | "dex"
  | "score_band"
  | "hold_bucket"
  | "exit_reason"
  | "source_bucket";

export interface LessonRow {
  id: number;
  lesson_key: string;
  kind: LessonKind;
  label: string;
  condition_json: string;
  wins: number;
  losses: number;
  avg_pnl_pct: number;
  sample_size: number;
  score_delta: number;
  active: number;
  updated_at: string;
  notes: string | null;
}

export interface ClosedTradeFeatures {
  position_id: number;
  symbol: string;
  dex: DexKind;
  pnl_pct: number;
  exit_reason: string | null;
  hold_minutes: number;
  score: number | null;
  initial_liquidity_eth: number | null;
  signal_action: string | null;
  source: string | null;
}

export class BotDb {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        token TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        dex TEXT NOT NULL,
        pair_or_pool TEXT NOT NULL,
        fee INTEGER,
        score REAL NOT NULL,
        action TEXT NOT NULL,
        reasons TEXT NOT NULL,
        initial_liquidity_eth REAL,
        tx_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        token TEXT NOT NULL,
        symbol TEXT NOT NULL,
        dex TEXT NOT NULL,
        pair_or_pool TEXT NOT NULL,
        fee INTEGER,
        entry_price_eth REAL NOT NULL,
        size_eth REAL NOT NULL,
        token_amount TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        exit_price_eth REAL,
        exit_reason TEXT,
        pnl_eth REAL,
        pnl_pct REAL,
        entry_tx TEXT,
        exit_tx TEXT,
        signal_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        side TEXT NOT NULL,
        token TEXT NOT NULL,
        symbol TEXT NOT NULL,
        dex TEXT NOT NULL,
        pair_or_pool TEXT NOT NULL,
        fee INTEGER,
        size_eth REAL NOT NULL,
        signal_id INTEGER,
        position_id INTEGER,
        executed_tx TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_spend (
        day TEXT PRIMARY KEY,
        spent_eth REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lesson_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        avg_pnl_pct REAL NOT NULL DEFAULT 0,
        sample_size INTEGER NOT NULL DEFAULT 0,
        score_delta REAL NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        notes TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token);
      CREATE INDEX IF NOT EXISTS idx_lessons_active ON lessons(active);
    `);

    const signalCols = this.db.prepare(`PRAGMA table_info(signals)`).all() as Array<{
      name: string;
    }>;
    if (!signalCols.some((c) => c.name === "source")) {
      this.db.exec(`ALTER TABLE signals ADD COLUMN source TEXT`);
    }

    const posCols = this.db.prepare(`PRAGMA table_info(positions)`).all() as Array<{
      name: string;
    }>;
    const hasPos = (name: string) => posCols.some((c) => c.name === name);
    if (!hasPos("book")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN book TEXT NOT NULL DEFAULT 'scout'`);
    }
    if (!hasPos("original_size_eth")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN original_size_eth REAL`);
      this.db.exec(
        `UPDATE positions SET original_size_eth = size_eth WHERE original_size_eth IS NULL`,
      );
    }
    if (!hasPos("original_token_amount")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN original_token_amount TEXT`);
      this.db.exec(
        `UPDATE positions SET original_token_amount = token_amount WHERE original_token_amount IS NULL`,
      );
    }
    if (!hasPos("peak_price_eth")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN peak_price_eth REAL`);
      this.db.exec(
        `UPDATE positions SET peak_price_eth = entry_price_eth WHERE peak_price_eth IS NULL`,
      );
    }
    if (!hasPos("realized_partial_pnl_eth")) {
      this.db.exec(
        `ALTER TABLE positions ADD COLUMN realized_partial_pnl_eth REAL NOT NULL DEFAULT 0`,
      );
    }
    if (!hasPos("moon_trim_mask")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN moon_trim_mask INTEGER NOT NULL DEFAULT 0`);
    }
    if (!hasPos("moon_reasons")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN moon_reasons TEXT`);
    }
    if (!hasPos("moon_flagged_at")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN moon_flagged_at TEXT`);
    }
    if (!hasPos("breakeven_stop")) {
      this.db.exec(`ALTER TABLE positions ADD COLUMN breakeven_stop INTEGER NOT NULL DEFAULT 0`);
    }
  }

  insertSignal(input: Omit<SignalRow, "id" | "created_at"> & { created_at?: string }): number {
    const created_at = input.created_at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO signals
          (created_at, token, symbol, name, dex, pair_or_pool, fee, score, action, reasons, initial_liquidity_eth, tx_hash, source)
         VALUES (@created_at, @token, @symbol, @name, @dex, @pair_or_pool, @fee, @score, @action, @reasons, @initial_liquidity_eth, @tx_hash, @source)`,
      )
      .run({ ...input, created_at, source: input.source ?? null });
    return Number(result.lastInsertRowid);
  }

  openPosition(
    input: Omit<
      PositionRow,
      | "id"
      | "status"
      | "closed_at"
      | "exit_price_eth"
      | "exit_reason"
      | "pnl_eth"
      | "pnl_pct"
      | "exit_tx"
      | "opened_at"
      | "book"
      | "original_size_eth"
      | "original_token_amount"
      | "peak_price_eth"
      | "realized_partial_pnl_eth"
      | "moon_trim_mask"
      | "moon_reasons"
      | "moon_flagged_at"
      | "breakeven_stop"
    > & {
      opened_at?: string;
      book?: PositionBook;
    },
  ): number {
    const opened_at = input.opened_at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO positions
          (mode, status, token, symbol, dex, pair_or_pool, fee, entry_price_eth, size_eth, token_amount,
           opened_at, entry_tx, signal_id, book, original_size_eth, original_token_amount,
           peak_price_eth, realized_partial_pnl_eth, moon_trim_mask, breakeven_stop)
         VALUES (@mode, 'open', @token, @symbol, @dex, @pair_or_pool, @fee, @entry_price_eth, @size_eth, @token_amount,
           @opened_at, @entry_tx, @signal_id, @book, @original_size_eth, @original_token_amount,
           @peak_price_eth, 0, 0, 0)`,
      )
      .run({
        ...input,
        opened_at,
        book: input.book ?? "scout",
        original_size_eth: input.size_eth,
        original_token_amount: input.token_amount,
        peak_price_eth: input.entry_price_eth,
      });
    return Number(result.lastInsertRowid);
  }

  promoteToMoon(id: number, reasons: string): void {
    this.db
      .prepare(
        `UPDATE positions SET
          book = 'moon',
          moon_reasons = @reasons,
          moon_flagged_at = @at
         WHERE id = @id AND status = 'open' AND book = 'scout'`,
      )
      .run({ id, reasons, at: new Date().toISOString() });
  }

  updatePositionPeak(id: number, peakPriceEth: number): void {
    this.db
      .prepare(
        `UPDATE positions SET peak_price_eth = @peak
         WHERE id = @id AND status = 'open' AND @peak > COALESCE(peak_price_eth, 0)`,
      )
      .run({ id, peak: peakPriceEth });
  }

  /**
   * Reduce an open position after a scale-out trim. Returns false if nothing left / not open.
   */
  applyPartialExit(
    id: number,
    fields: {
      sizeEthSold: number;
      tokenAmountSold: bigint;
      trimBit: number;
      pnlEth: number;
      exitPriceEth: number;
      armBreakeven: boolean;
    },
  ): { remainingSizeEth: number; remainingTokens: bigint } | null {
    const pos = this.getPosition(id);
    if (!pos || pos.status !== "open") return null;

    const remTokens = BigInt(pos.token_amount || "0");
    const soldTokens =
      fields.tokenAmountSold > remTokens ? remTokens : fields.tokenAmountSold;
    const remSize = Math.max(0, pos.size_eth - fields.sizeEthSold);
    const nextTokens = remTokens - soldTokens;
    const mask = (pos.moon_trim_mask ?? 0) | (1 << fields.trimBit);
    const realized = (pos.realized_partial_pnl_eth ?? 0) + fields.pnlEth;

    this.db
      .prepare(
        `UPDATE positions SET
          size_eth = @size_eth,
          token_amount = @token_amount,
          moon_trim_mask = @mask,
          realized_partial_pnl_eth = @realized,
          breakeven_stop = CASE WHEN @arm > 0 THEN 1 ELSE breakeven_stop END,
          exit_price_eth = @exit_price,
          pnl_eth = @realized,
          pnl_pct = @pnl_pct
         WHERE id = @id AND status = 'open'`,
      )
      .run({
        id,
        size_eth: remSize,
        token_amount: nextTokens.toString(),
        mask,
        realized,
        arm: fields.armBreakeven ? 1 : 0,
        exit_price: fields.exitPriceEth,
        pnl_pct:
          pos.original_size_eth > 0
            ? (realized / pos.original_size_eth) * 100
            : 0,
      });

    return { remainingSizeEth: remSize, remainingTokens: nextTokens };
  }

  countOpenMoonPositions(mode: ExecutionMode): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE status = 'open' AND mode = ? AND book = 'moon'`,
        )
        .get(mode) as { c: number }
    ).c;
  }

  getSignalSource(signalId: number | null): string | null {
    if (signalId == null) return null;
    const row = this.db
      .prepare(`SELECT source FROM signals WHERE id = ?`)
      .get(signalId) as { source: string | null } | undefined;
    return row?.source ?? null;
  }

  closePosition(
    id: number,
    fields: {
      exit_price_eth: number;
      exit_reason: string;
      pnl_eth: number;
      pnl_pct: number;
      exit_tx?: string | null;
      closed_at?: string;
    },
  ) {
    this.db
      .prepare(
        `UPDATE positions SET
          status = 'closed',
          closed_at = @closed_at,
          exit_price_eth = @exit_price_eth,
          exit_reason = @exit_reason,
          pnl_eth = @pnl_eth,
          pnl_pct = @pnl_pct,
          exit_tx = @exit_tx
         WHERE id = @id AND status = 'open'`,
      )
      .run({
        id,
        closed_at: fields.closed_at ?? new Date().toISOString(),
        exit_price_eth: fields.exit_price_eth,
        exit_reason: fields.exit_reason,
        pnl_eth: fields.pnl_eth,
        pnl_pct: fields.pnl_pct,
        exit_tx: fields.exit_tx ?? null,
      });
  }

  /** Mark an open position closed as a total loss (no on-chain sell). */
  writeOffPosition(id: number, note = "write_off worthless"): PositionRow | undefined {
    const pos = this.getPosition(id);
    if (!pos || pos.status !== "open") return undefined;
    const size = pos.size_eth || pos.original_size_eth || 0;
    const partial = pos.realized_partial_pnl_eth ?? 0;
    const pnlEth = partial - size;
    const orig = pos.original_size_eth || size || 1;
    this.closePosition(id, {
      exit_price_eth: 0,
      exit_reason: note,
      pnl_eth: pnlEth,
      pnl_pct: (pnlEth / orig) * 100,
    });
    return this.getPosition(id);
  }

  listOpenPositions(mode?: ExecutionMode): PositionRow[] {
    if (mode) {
      return this.db
        .prepare(`SELECT * FROM positions WHERE status = 'open' AND mode = ? ORDER BY id ASC`)
        .all(mode) as PositionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY id ASC`)
      .all() as PositionRow[];
  }

  getPosition(id: number): PositionRow | undefined {
    return this.db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as
      | PositionRow
      | undefined;
  }

  countOpenPositions(mode?: ExecutionMode): number {
    if (mode) {
      return (
        this.db
          .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND mode = ?`)
          .get(mode) as { c: number }
      ).c;
    }
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'open'`).get() as {
        c: number;
      }
    ).c;
  }

  countOpenTrendingPositions(mode: ExecutionMode): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM positions p
           LEFT JOIN signals s ON s.id = p.signal_id
           WHERE p.status = 'open'
             AND p.mode = ?
             AND s.source IN ('trending', 'boost')`,
        )
        .get(mode) as { c: number }
    ).c;
  }

  hasOpenPositionForToken(token: Address, mode?: ExecutionMode): boolean {
    const row = mode
      ? (this.db
          .prepare(
            `SELECT 1 AS ok FROM positions WHERE status = 'open' AND lower(token) = lower(?) AND mode = ? LIMIT 1`,
          )
          .get(token, mode) as { ok: number } | undefined)
      : (this.db
          .prepare(
            `SELECT 1 AS ok FROM positions WHERE status = 'open' AND lower(token) = lower(?) LIMIT 1`,
          )
          .get(token) as { ok: number } | undefined);
    return Boolean(row);
  }

  getLastClosedPosition(token: Address, mode?: ExecutionMode): PositionRow | undefined {
    if (mode) {
      return this.db
        .prepare(
          `SELECT * FROM positions
           WHERE status = 'closed' AND lower(token) = lower(?) AND mode = ?
           ORDER BY datetime(COALESCE(closed_at, opened_at)) DESC
           LIMIT 1`,
        )
        .get(token, mode) as PositionRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM positions
         WHERE status = 'closed' AND lower(token) = lower(?)
         ORDER BY datetime(COALESCE(closed_at, opened_at)) DESC
         LIMIT 1`,
      )
      .get(token) as PositionRow | undefined;
  }

  countRecentStopLosses(token: Address, mode: ExecutionMode, sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE status = 'closed'
             AND mode = ?
             AND lower(token) = lower(?)
             AND exit_reason LIKE 'stop_loss%'
             AND COALESCE(closed_at, opened_at) >= ?`,
        )
        .get(mode, token, sinceIso) as { c: number }
    ).c;
  }

  getLastClosedBySymbol(symbol: string, mode?: ExecutionMode): PositionRow | undefined {
    const sym = symbol.trim();
    if (!sym || sym === "???") return undefined;
    if (mode) {
      return this.db
        .prepare(
          `SELECT * FROM positions
           WHERE status = 'closed' AND mode = ? AND lower(symbol) = lower(?)
           ORDER BY datetime(COALESCE(closed_at, opened_at)) DESC
           LIMIT 1`,
        )
        .get(mode, sym) as PositionRow | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM positions
         WHERE status = 'closed' AND lower(symbol) = lower(?)
         ORDER BY datetime(COALESCE(closed_at, opened_at)) DESC
         LIMIT 1`,
      )
      .get(sym) as PositionRow | undefined;
  }

  countRecentStopLossesBySymbol(symbol: string, mode: ExecutionMode, sinceIso: string): number {
    const sym = symbol.trim();
    if (!sym || sym === "???") return 0;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE status = 'closed'
             AND mode = ?
             AND lower(symbol) = lower(?)
             AND exit_reason LIKE 'stop_loss%'
             AND COALESCE(closed_at, opened_at) >= ?`,
        )
        .get(mode, sym, sinceIso) as { c: number }
    ).c;
  }

  /** Near-flat max-hold exits (dead chop) for a token. */
  countRecentChopExits(
    token: Address,
    mode: ExecutionMode,
    sinceIso: string,
    flatPnlPct: number,
  ): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE status = 'closed'
             AND mode = ?
             AND lower(token) = lower(?)
             AND exit_reason LIKE 'max_hold%'
             AND ABS(COALESCE(pnl_pct, 0)) <= ?
             AND COALESCE(closed_at, opened_at) >= ?`,
        )
        .get(mode, token, flatPnlPct, sinceIso) as { c: number }
    ).c;
  }

  countRecentChopExitsBySymbol(
    symbol: string,
    mode: ExecutionMode,
    sinceIso: string,
    flatPnlPct: number,
  ): number {
    const sym = symbol.trim();
    if (!sym || sym === "???") return 0;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions
           WHERE status = 'closed'
             AND mode = ?
             AND lower(symbol) = lower(?)
             AND exit_reason LIKE 'max_hold%'
             AND ABS(COALESCE(pnl_pct, 0)) <= ?
             AND COALESCE(closed_at, opened_at) >= ?`,
        )
        .get(mode, sym, flatPnlPct, sinceIso) as { c: number }
    ).c;
  }

  listClosedPositions(limit = 50): PositionRow[] {
    return this.db
      .prepare(`SELECT * FROM positions WHERE status = 'closed' ORDER BY id DESC LIMIT ?`)
      .all(limit) as PositionRow[];
  }

  paperStats(): {
    open: number;
    closed: number;
    wins: number;
    losses: number;
    realized_pnl_eth: number;
    moon_open: number;
  } {
    const open = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND mode = 'paper'`)
        .get() as { c: number }
    ).c;
    const moonOpen = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND mode = 'paper' AND book = 'moon'`,
        )
        .get() as { c: number }
    ).c;
    const closedRows = this.db
      .prepare(`SELECT pnl_eth FROM positions WHERE status = 'closed' AND mode = 'paper'`)
      .all() as { pnl_eth: number | null }[];
    // Partials already banked on still-open moon positions
    const openPartials = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(realized_partial_pnl_eth), 0) AS s
           FROM positions WHERE status = 'open' AND mode = 'paper'`,
        )
        .get() as { s: number }
    ).s;
    let wins = 0;
    let losses = 0;
    let realized = openPartials;
    for (const r of closedRows) {
      const pnl = r.pnl_eth ?? 0;
      realized += pnl;
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;
    }
    return {
      open,
      closed: closedRows.length,
      wins,
      losses,
      realized_pnl_eth: realized,
      moon_open: moonOpen,
    };
  }

  createApproval(input: {
    expires_at: string;
    side: "buy" | "sell";
    token: string;
    symbol: string;
    dex: DexKind;
    pair_or_pool: string;
    fee: number | null;
    size_eth: number;
    signal_id?: number | null;
    position_id?: number | null;
    notes?: string | null;
  }): number {
    const created_at = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO approvals
          (created_at, expires_at, status, side, token, symbol, dex, pair_or_pool, fee, size_eth, signal_id, position_id, notes)
         VALUES (@created_at, @expires_at, 'pending', @side, @token, @symbol, @dex, @pair_or_pool, @fee, @size_eth, @signal_id, @position_id, @notes)`,
      )
      .run({
        created_at,
        expires_at: input.expires_at,
        side: input.side,
        token: input.token,
        symbol: input.symbol,
        dex: input.dex,
        pair_or_pool: input.pair_or_pool,
        fee: input.fee,
        size_eth: input.size_eth,
        signal_id: input.signal_id ?? null,
        position_id: input.position_id ?? null,
        notes: input.notes ?? null,
      });
    return Number(result.lastInsertRowid);
  }

  listPendingApprovals(): ApprovalRow[] {
    this.expireStaleApprovals();
    return this.db
      .prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY id ASC`)
      .all() as ApprovalRow[];
  }

  getApproval(id: number): ApprovalRow | undefined {
    return this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as
      | ApprovalRow
      | undefined;
  }

  expireStaleApprovals() {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`,
      )
      .run(now);
  }

  setApprovalStatus(
    id: number,
    status: ApprovalStatus,
    extra?: { executed_tx?: string; notes?: string },
  ) {
    this.db
      .prepare(
        `UPDATE approvals SET status = @status, executed_tx = COALESCE(@executed_tx, executed_tx), notes = COALESCE(@notes, notes) WHERE id = @id`,
      )
      .run({
        id,
        status,
        executed_tx: extra?.executed_tx ?? null,
        notes: extra?.notes ?? null,
      });
  }

  getDailySpend(day = new Date().toISOString().slice(0, 10)): number {
    const row = this.db.prepare(`SELECT spent_eth FROM daily_spend WHERE day = ?`).get(day) as
      | SpendRow
      | undefined;
    return row?.spent_eth ?? 0;
  }

  addDailySpend(amountEth: number, day = new Date().toISOString().slice(0, 10)) {
    this.db
      .prepare(
        `INSERT INTO daily_spend (day, spent_eth) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET spent_eth = spent_eth + excluded.spent_eth`,
      )
      .run(day, amountEth);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getSignal(id: number): SignalRow | undefined {
    return this.db.prepare(`SELECT * FROM signals WHERE id = ?`).get(id) as
      | SignalRow
      | undefined;
  }

  listClosedPaperTradesWithFeatures(): ClosedTradeFeatures[] {
    const rows = this.db
      .prepare(
        `SELECT
           p.id AS position_id,
           p.symbol AS symbol,
           p.dex AS dex,
           p.pnl_pct AS pnl_pct,
           p.exit_reason AS exit_reason,
           p.opened_at AS opened_at,
           p.closed_at AS closed_at,
           s.score AS score,
           s.initial_liquidity_eth AS initial_liquidity_eth,
           s.action AS signal_action,
           s.source AS source
         FROM positions p
         LEFT JOIN signals s ON s.id = p.signal_id
         WHERE p.mode = 'paper' AND p.status = 'closed' AND p.pnl_pct IS NOT NULL
         ORDER BY p.id ASC`,
      )
      .all() as Array<{
      position_id: number;
      symbol: string;
      dex: DexKind;
      pnl_pct: number;
      exit_reason: string | null;
      opened_at: string;
      closed_at: string | null;
      score: number | null;
      initial_liquidity_eth: number | null;
      signal_action: string | null;
      source: string | null;
    }>;

    return rows.map((r) => {
      const opened = Date.parse(r.opened_at);
      const closed = r.closed_at ? Date.parse(r.closed_at) : opened;
      const hold_minutes = Math.max(0, (closed - opened) / 60_000);
      return {
        position_id: r.position_id,
        symbol: r.symbol,
        dex: r.dex,
        pnl_pct: r.pnl_pct,
        exit_reason: r.exit_reason,
        hold_minutes,
        score: r.score,
        initial_liquidity_eth: r.initial_liquidity_eth,
        signal_action: r.signal_action,
        source: r.source,
      };
    });
  }

  upsertLesson(input: {
    lesson_key: string;
    kind: LessonKind;
    label: string;
    condition_json: string;
    wins: number;
    losses: number;
    avg_pnl_pct: number;
    sample_size: number;
    score_delta: number;
    active: boolean;
    notes?: string | null;
  }): void {
    const updated_at = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO lessons
          (lesson_key, kind, label, condition_json, wins, losses, avg_pnl_pct, sample_size, score_delta, active, updated_at, notes)
         VALUES
          (@lesson_key, @kind, @label, @condition_json, @wins, @losses, @avg_pnl_pct, @sample_size, @score_delta, @active, @updated_at, @notes)
         ON CONFLICT(lesson_key) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          condition_json = excluded.condition_json,
          wins = excluded.wins,
          losses = excluded.losses,
          avg_pnl_pct = excluded.avg_pnl_pct,
          sample_size = excluded.sample_size,
          score_delta = excluded.score_delta,
          active = excluded.active,
          updated_at = excluded.updated_at,
          notes = excluded.notes`,
      )
      .run({
        ...input,
        active: input.active ? 1 : 0,
        updated_at,
        notes: input.notes ?? null,
      });
  }

  deactivateStaleLessons(keepKeys: string[]) {
    if (!keepKeys.length) {
      this.db.prepare(`UPDATE lessons SET active = 0`).run();
      return;
    }
    const placeholders = keepKeys.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE lessons SET active = 0 WHERE lesson_key NOT IN (${placeholders})`)
      .run(...keepKeys);
  }

  listLessons(activeOnly = false): LessonRow[] {
    if (activeOnly) {
      return this.db
        .prepare(`SELECT * FROM lessons WHERE active = 1 ORDER BY ABS(score_delta) DESC, sample_size DESC`)
        .all() as LessonRow[];
    }
    return this.db
      .prepare(`SELECT * FROM lessons ORDER BY updated_at DESC, ABS(score_delta) DESC`)
      .all() as LessonRow[];
  }

  countClosedPaperTrades(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM positions WHERE mode = 'paper' AND status = 'closed'`)
        .get() as { c: number }
    ).c;
  }

  close() {
    this.db.close();
  }
}

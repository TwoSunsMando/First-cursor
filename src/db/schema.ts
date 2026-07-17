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

      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token);
    `);
  }

  insertSignal(input: Omit<SignalRow, "id" | "created_at"> & { created_at?: string }): number {
    const created_at = input.created_at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO signals
          (created_at, token, symbol, name, dex, pair_or_pool, fee, score, action, reasons, initial_liquidity_eth, tx_hash)
         VALUES (@created_at, @token, @symbol, @name, @dex, @pair_or_pool, @fee, @score, @action, @reasons, @initial_liquidity_eth, @tx_hash)`,
      )
      .run({ ...input, created_at });
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
    > & {
      opened_at?: string;
    },
  ): number {
    const opened_at = input.opened_at ?? new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO positions
          (mode, status, token, symbol, dex, pair_or_pool, fee, entry_price_eth, size_eth, token_amount, opened_at, entry_tx, signal_id)
         VALUES (@mode, 'open', @token, @symbol, @dex, @pair_or_pool, @fee, @entry_price_eth, @size_eth, @token_amount, @opened_at, @entry_tx, @signal_id)`,
      )
      .run({ ...input, opened_at });
    return Number(result.lastInsertRowid);
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
  } {
    const open = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM positions WHERE status = 'open' AND mode = 'paper'`)
        .get() as { c: number }
    ).c;
    const closedRows = this.db
      .prepare(`SELECT pnl_eth FROM positions WHERE status = 'closed' AND mode = 'paper'`)
      .all() as { pnl_eth: number | null }[];
    let wins = 0;
    let losses = 0;
    let realized = 0;
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

  close() {
    this.db.close();
  }
}

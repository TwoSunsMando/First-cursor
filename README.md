# Robinhood Chain Paper Bot

Scan **Robinhood Chain** (Ethereum L2, chain ID `4663`) for new meme / DEX activity, **paper-trade** first, then optionally execute **live Uniswap swaps** behind hard spend caps and human approval.

This is **onchain wallet trading**, not Robinhood brokerage / Agentic MCP equities.

## Quick start

```bash
cp .env.example .env
npm install
npm run scan
```

In another terminal:

```bash
npm run status
npm run report
npm run positions
```

Default `EXECUTION_MODE=paper` — no private key required.

Paper BUY defaults to score **≥ 40**. Tune with `BUY_SCORE_THRESHOLD` / `WATCH_SCORE_THRESHOLD` in `.env`.

## Learning Mode (paper)

Turn paper trading into a feedback loop:

1. Set `LEARNING_MODE=true` in `.env` (already on in `.env.example`)
2. Run `npm run scan` — closes feed the lesson miner
3. Inspect with:
   ```bash
   npm run learn     # mine closed paper trades → lessons
   npm run lessons   # show ACTIVE vs idle lessons
   npm run report
   ```

**How it improves:** closed paper trades are bucketed by liquidity, dex, and entry score. Buckets with enough samples (`LEARN_MIN_SAMPLES`, default 3) become **ACTIVE** lessons that add/subtract from the next entry score (capped ±20). Hold-time and exit-reason buckets are logged for insight but not applied to entries.

While scanning, learning re-runs every `LEARN_INTERVAL_MS` (default 5 minutes). Lessons never auto-change live trading.

## Trending + boost scanning

In addition to watching new on-chain pools, the bot polls **DexPaprika** (no API key) for Robinhood Chain:

- Top pools by 24h volume and txn count
- Short-window “boosts” (15m volume + sharp 5m/15m price moves)
- Feeds 15m volume / buys into the scorer (points that were previously always zero)

```bash
npm run trending   # one-shot list
npm run scan       # includes trending poller when TRENDING_ENABLED=true
```

Tune with `TRENDING_MIN_VOLUME_USD_24H`, `TRENDING_MIN_LIQUIDITY_USD`, and `TRENDING_COOLDOWN_MS`.

Trending is intentionally **down-weighted** so it doesn’t crowd out new-pool discovery:

- Base bonus: trending +14 / boost +16 (not +25/+30)
- Momentum extras (15m vol, buys, 24h vol, Δ) × `TRENDING_MOMENTUM_SCALE` (default **0.55**)
- At most `MAX_TRENDING_OPEN_POSITIONS` (default **2**) of your open slots may be trending/boost

### Re-entry guard (stop-loss churn)

Trending can keep surfacing the same names after a stop-loss. The bot now blocks re-entry by **contract address and ticker** (so Jimothy copycats are covered too):

| Situation | Default cooldown |
|-----------|------------------|
| Last exit was `stop_loss` | `REENTRY_AFTER_STOP_MS` (6h) |
| Hard loss (≤ −50% / −100%) or 2+ stop-losses in window | `REENTRY_AFTER_HARD_LOSS_MS` (24h) |
| Other losing exit | up to 2h |

Logs look like: `risk: re-entry blocked for STOCKCAT — stop-loss on #17 … wait 5h`.

### If you see `Too Many Requests`

The public RPC (`rpc.mainnet.chain.robinhood.com`) is rate-limited. The bot now uses a **single HTTP poller** (not 3 overlapping watchers) with backoff, but sustained scanning still needs a provider:

1. Create a free [Alchemy](https://www.alchemy.com/) app on Robinhood Chain
2. Set both in `.env`:
   ```env
   RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
   WSS_RPC_URL=wss://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
   ```
3. Restart `npm run scan`

Without WSS, keep `POLL_INTERVAL_MS≥30000` and only run **one** scan process.

## What it watches

| Source | Event |
|--------|--------|
| NOXA launch factory | `TokenLaunched` |
| Uniswap V2 | `PairCreated` (WETH pairs) |
| Uniswap V3 | `PoolCreated` (WETH pools) |

Signals are scored (launch source + liquidity + optional volume heuristics). Risk filters enforce deny-list names, min liquidity, and max open positions.

Paper positions auto-exit on take-profit, stop-loss, or max hold time.

## Live mode (optional)

1. Fund a **dedicated** wallet with a little ETH on Robinhood Chain.
2. Set in `.env`:

```env
EXECUTION_MODE=live
PRIVATE_KEY=0x...
MAX_BUY_ETH=0.01
MAX_DAILY_ETH=0.05
MAX_SLIPPAGE_BPS=300
AUTO_SELL=true
```

3. Prefer Alchemy WSS:

```env
RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
WSS_RPC_URL=wss://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
```

4. When a BUY signal fires, the bot **does not** buy immediately. It creates a pending approval:

```bash
npm run pending
npm run approve -- <id>
# or
npx tsx src/cli.ts reject <id>
```

Exits: if `AUTO_SELL=true`, TP/SL/time exits broadcast without a second approval (only for positions you already approved to open).

## Network

| | Mainnet |
|--|--|
| Chain ID | `4663` |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | https://robinhoodchain.blockscout.com |
| Docs | https://docs.robinhood.com/chain/ |

Contract addresses live in `src/chain/addresses.ts` — **re-verify on Blockscout before live trading**.

## Commands

| Command | Description |
|---------|-------------|
| `npm run scan` | Start ingest + paper/live loop |
| `npm run status` | Mode, counts, daily spend |
| `npm run report` | Paper P&L summary |
| `npm run positions` | Open positions |
| `npm run pending` | Pending live approvals |
| `npm run approve -- <id>` | Approve + execute |

## Risk

Memecoins on a new L2 can go to zero. Honeypots, rugs, and copycats are common. Paper results do not predict live results. You are responsible for keys, caps, and every approved trade.

## Out of scope (v1)

- X/Twitter social scanning
- Robinhood brokerage Agentic MCP
- Stock Tokens / Morpho Earn
- Fully unattended live sniping (no approval)

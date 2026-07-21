# Robinhood Chain Paper Bot

Scan **Robinhood Chain** (Ethereum L2, chain ID `4663`) for new meme / DEX activity, **paper-trade** first, then optionally execute **live Uniswap swaps** behind hard spend caps and human approval.

This is **onchain wallet trading**, not Robinhood brokerage / Agentic MCP equities.

## Quick start

```bash
cp .env.example .env
npm install
npm run ui          # dashboard at http://127.0.0.1:8787 — Start/Stop here
# or terminal-only:
npm run scan
```

**Do not run `ui` and `scan` at the same time** (two scanners = double entries).

In another terminal:

```bash
npm run status
npm run report
npm run positions
```

Default `EXECUTION_MODE=paper` — no private key required.

Paper BUY defaults to score **≥ 40**. Tune with `BUY_SCORE_THRESHOLD` / `WATCH_SCORE_THRESHOLD` in `.env`.

### Dashboard UI

`npm run ui` serves a local control panel:

- Start / Stop + running heartbeat
- Equity, realized / unrealized PnL
- Open positions (scout / moon)
- Open orders (pending live approvals)
- Edit take-profit, stop-loss, max hold, max open positions (1–5)

Binds to `UI_HOST` / `UI_PORT` (default `127.0.0.1:8787`).

### Paper → live on WSL (same code)

1. Clone repo on WSL, `cp .env.example .env`, set Alchemy `RPC_URL` + `WSS_RPC_URL`
2. Paper: `EXECUTION_MODE=paper`, `npm run ui` — train/test
3. Pull updates: `git pull && npm install` → restart UI
4. Live: separate `DB_PATH=./data/live.db`, set `PRIVATE_KEY`, `EXECUTION_MODE=live`, small caps

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

- Base bonus: trending +12 / boost +18
- Momentum extras (15m vol, buys, 24h vol, Δ) × `TRENDING_MOMENTUM_SCALE` (default **0.55**)
- At most `MAX_TRENDING_OPEN_POSITIONS` (default **3**) of your open slots may be trending/boost

### Moon / runner book (stay past +65%)

Early entry is unchanged — launches still open on the **scout** book with the normal scan.

If a scout position shows early strength (launch source + ≈+35% within 40m, optional DexPaprika momentum), it upgrades to **moon**:

1. Sell ~35% at the normal TP (+65%) — bank a free ride  
2. Stop moves to breakeven on the rest  
3. Optional trims at +2× / +5× / +10×  
4. Trail the remainder (default giveback 30 points from peak PnL)  
5. Max hold lifted to `MOON_MAX_HOLD_MINUTES` (default 24h; `0` = none)

At most `MAX_MOON_POSITIONS` (default **2**) runners at once. Website/X scoring can plug into moon detect later; v1 is onchain-only.

### Overnight edge rules (paper training)

Tuned from closed-trade analysis (prefer boost + mid-liq; avoid late majors):

| Rule | Default |
|------|---------|
| Mid-liq sweet spot | `PREFERRED_LIQ_MIN/MAX_ETH` = **5–50** (score bonus) |
| Skip mega-liq trending | `SKIP_TRENDING_LIQ_ETH=50` |
| Late-entry skip | 15m vol ≥ `LATE_ENTRY_VOL_ETH_15M` (12) or buys ≥ `LATE_ENTRY_BUYS` (45) |
| Confirming edge for BUY | `BUY_REQUIRE_CONFIRMING_EDGE=true` — need boost, **launch+liq**, mid-liq, or moderate momentum |
| Dead-chop blacklist | 2× near-flat max-hold (`CHOP_FLAT_PNL_PCT=5`) → `REENTRY_AFTER_CHOP_MS` (48h) |

### Anti–instant-rug + confirm-then-enter (paper + live)

**Strategy shift:** do not buy because a launch “survived” a timer. Buy only after
**confirmed strength** — on-chain mid price up during the defer window **and**
DexPaprika **positive** 15m Δ (vol/buys only as AND confirmers). The old OR-gate
let dump volume pass (e.g. MEOW Δ=−37% with high sells).

| Gate | Default |
|------|---------|
| Reject unknown liq | `REJECT_NULL_LIQUIDITY=true` |
| Min launch WETH | `MIN_LAUNCH_LIQUIDITY_ETH=0.5` |
| Settle then re-read pool WETH | `LAUNCH_LIQ_SETTLE_MS` (optional short) |
| **Min age before BUY** | `MIN_LAUNCH_AGE_MS=120000` (2m) — non-blocking defer; mid-wait probes every `LAUNCH_LIQ_PROBE_MS` abort on LP pull / price dump |
| **Confirm window** | `LAUNCH_CONFIRM_MS=90000` — after age ok, wait again + re-check |
| **On-chain appreciation** | `REQUIRE_ONCHAIN_APPRECIATION=true` — mid must rise ≥ `LAUNCH_MIN_APPRECIATION_PCT` (8%) vs first defer quote; abort on `LAUNCH_PRICE_DROP_MAX_PCT` giveback |
| **Launch momentum** | `REQUIRE_LAUNCH_MOMENTUM=true` — **mandatory** 15m Δ≥25% **and** vol≥2 ETH **and** buys≥15; refuse negative Δ |
| **Entry liq floor** | `MIN_LAUNCH_ENTRY_LIQUIDITY_ETH=7` |
| **Launch-only entries** | `ENTRY_LAUNCH_ONLY=true` (paper+live) — skip trending/boost |
| **Live early LP drain** | `EARLY_RUG_WINDOW_MS` + `EARLY_RUG_LIQ_FRACTION` — emergency sell if pool WETH collapses after entry |
| Buy→sell quoter roundtrip | `REQUIRE_SELLABLE_QUOTE=true` — fail if unsellable or tax > `MAX_ROUNDTRIP_TAX_BPS` (2500 = 25%) |
| Live re-check at Yes | same gates run again at execute (LP may vanish during approval TTL) |

Logs: `DEFER BUY …`, `DEFER CONFIRM …`, `DEFER SKIP … on-chain flat/down`, `momentum dump`, `momentum ok (Δ≥25%+…)`, `EARLY RUG #…`.

Paper skips opens that fail these gates (no synthetic “fake entry” prices). Train in `EXECUTION_MODE=paper` first; promote only after rugs show up as `SKIP` / `gate:` / `DEFER SKIP` in logs instead of opens.

### Overnight live moon-hunt (tiny size after paper looks clean)

Still enters as **scout**, then upgrades to **moon** if it runs. For unattended overnight:

| Knob | Suggested |
|------|-----------|
| `MAX_OPEN_POSITIONS` / `MAX_MOON_POSITIONS` | **2** / **2** |
| `MAX_BUY_ETH` | **0.001** (~$2) until paper confirms |
| `MAX_DAILY_ETH` | **0.005** |
| `ENTRY_LAUNCH_ONLY` | **true** |
| `TRENDING_ENABLED` | **false** |
| `AUTO_APPROVE_BUYS` | **true** (no Yes click) |
| `AUTO_SELL` | **true** (trim/trail/stop on-chain) |
| `REQUIRE_ONCHAIN_APPRECIATION` | **true** |
| `MIN_LAUNCH_ENTRY_LIQUIDITY_ETH` | **7** |
| `DB_PATH` | separate live DB e.g. `./data/live-overnight.db` |

Flow: launch → defer+confirm → on-chain up + positive Δ → sellable → auto-buy → scout → moon if +35% early → trim/trail with `AUTO_SELL`.

### Re-entry guard (stop-loss / chop churn)

Trending can keep surfacing the same names after a stop-loss. The bot blocks re-entry by **contract address and ticker** (so Jimothy copycats are covered too):

| Situation | Default cooldown |
|-----------|------------------|
| Last exit was `stop_loss` | `REENTRY_AFTER_STOP_MS` (6h) |
| Hard loss (≤ −50% / −100%) or 2+ stop-losses in window | `REENTRY_AFTER_HARD_LOSS_MS` (24h) |
| 2× dead-chop max-hold (\|pnl\| ≤ 5%) | `REENTRY_AFTER_CHOP_MS` (48h) |
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
| `npm run ui` | Local dashboard (start/stop, params, positions) |
| `npm run scan` | Start ingest + paper/live loop (terminal) |
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

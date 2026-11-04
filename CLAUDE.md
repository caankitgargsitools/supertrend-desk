# AnkGenie (Supertrend Desk) — handover for Claude Code

Automated futures/options/crypto trading desk on Dhan (NSE/BSE/MCX) and Delta Exchange (crypto), with a strategy lab,
marketplace, paper and live trading. Built for and with the owner, a Chartered Accountant.

## How to work with the owner (standing rules — always follow)
- Address the owner as **"Papa"**. Reply in Hindi when he writes in Hindi; otherwise English.
- Answers go inline in chat. No documents/files unless he asks.
- When he says "discuss first, don't implement", only discuss.
- Owner login: ca.ankitgarg@gmail.com.
- Be honest about losses and limits. Never claim "all fine" without checking; separate "the system ran correctly"
  from "the strategy will make money".
- Never show the Dhan token, webhook URL or secret, Delta API keys, the private push key, or webhook secrets in the
  browser (the Orders page strips them).
- P&L is shown in whole rupees, truncated.
- No profit share is taken from the wallet (old billing code unused). Instead **Shukrana** (31 Oct 2026, migration 57):
  Papa's share of clients' new profit, settled by hand outside the portal on a running basis. Only "Shukrana due" and
  "Shukrana accepted" (amount, date, optional note; no payment mode). Due = rate × each rise of the client's running
  LIVE net (after charges, hidden trades out) above its previous best, from when their rate was set (`shukrana_rates`,
  a changed rate applies to later rises); accepted = `shukrana_accepted` (never deleted; corrections are negative
  entries); balance = accepted − due, below zero = owed. Functions `shukrana_summary` / `shukrana_overview` /
  `shukrana_set_rate` / `shukrana_accept`; admins reminded daily 10:17 IST (`shukrana_remind`, notification kind
  "shukrana", link `/?shukrana=1`). Client: card on the Wallet page; admin: Admin › Shukrana. Test: `tests/ui/ui_shukrana.mjs`.
- Backtests: don't add the futures premium. Every-year-profitable rule stands; minute strategies with < 3 years of
  history use the quarter rule (3 of the last 4 quarters), approved by Papa.
- Nothing goes live with real money until a supervised 1-lot test (engine action `live_test`).
- Never write test rows to the production database. Test with mocks (tests/) or rollback.
- Destructive SQL (DELETE/DROP) needs Papa's approval — don't work around it; use `hidden` flags or other approaches
  (e.g. hidden trades/signals are excluded by RLS and by the totals functions).
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Standing rules for all work (set by Papa, 23 Oct 2026)
1. **AI and paid services are layered by cost: free → cheapest → costlier.** Wherever the platform uses AI (news or
   filing summaries, sentiment, strategy explanations, trade journal, chart commentary) or paid data (market feeds,
   fundamentals), try a free option first: a rules/code engine, Gemini free tier, free exchange or public data. Fall
   through to the cheapest paid tier (e.g. Claude Haiku 5.5), then costlier ones (Claude Sonnet 5.5 / Opus 5.5), only
   when the cheaper one fails, refuses or gives an answer that doesn't pass validation.
   - Free AI tiers may train on inputs: send them **only public data** — never Papa's positions, P&L, API keys or
     personal data. Anything private goes to a paid tier that doesn't train on inputs (or stays in code).
   - **Log every call**: which tier answered and its cost (a table such as `ai_calls`), so cost is visible.
   - Before adding or changing any AI or paid-data use, show Papa where it is used and the plan, then wait for his go.
2. **Every running process must show it is working.** Never leave a screen silently waiting.
   - A thin activity bar at the top while anything talks to the server (`#netbar`, driven by the fetch wrapper).
   - A spinner on any button while its action runs (`run(btn, fn)` adds `.busy`; buttons clicked just before a
     server request get it automatically).
   - A progress bar with time left where the duration is roughly known (backtests, lab runs, imports, report
     generation: `progressHTML(frac, startedAt)`), and a spinning circle (`.spin`) where it isn't.
   - Pages show a loading state while their data loads (`withLoading(pane, promise)`).

## Layout
- `index.html` — the whole web app (static, no build), deployed by Vercel on push to `main`.
- `supabase/functions/engine/*.ts` — the engine (Deno edge function). **This folder is the source of truth.**
  - `index.ts` tick loop, orders (paper/live), stops, per-second prices (`pricesLoop`/`pricesTick`/`secondRisk`),
    audit, lab entry points, notifications, reconcile.
  - `execution.ts` Dhan order client (routed through the DB function `dhan_send` for Dhan's static-IP rule:
    IP 13.206.175.148 must be whitelisted at Dhan), chase/stop rules.
  - `dhan.ts` Dhan data client: per-tick memo, shared pacing (210 ms data, 1.05 s quotes per token), batched LTP.
  - `lab.ts` strategy lab (generate, screen, tougher test, quarter rule, re-verdict). `backtest.ts`, `rules.ts`,
    `risk.ts`, `logic.ts` (sessions, holidays), `crypto.ts` (Delta), `audit.ts` (daily self-check), `margins.ts`,
    `sizing.ts`, `structures.ts`, `instruments.ts`.
- `supabase/migrations/*.sql` — notes of every migration applied (applied via the Supabase MCP / dashboard).
- `tests/sim` — Node tests with an in-memory fake Supabase and simulated Dhan (see tests/sim/README.md).
- `tests/ui` — Playwright checks with mocked Supabase responses.

## Backend
- Supabase project `umryzxusbdttbcshkajt` (region ap-south-1).
- Engine deploy: the deployed function is a one-line wrapper that imports this repo's raw file at a pinned commit:
  `import "https://raw.githubusercontent.com/caankitgargsitools/supertrend-desk/<SHA>/supabase/functions/engine/index.ts";`
  Steps: push the commit, then deploy the wrapper with the new SHA (verify_jwt **false**).
- Build check: `cd supabase/functions/engine && npx esbuild index.ts --bundle --format=esm --platform=neutral "--external:npm:*" --outfile=/dev/null`
- Edge runtime limit: about 2 s of CPU per invocation — long work is split (lab instalments, 10-second price runs).
- Cron jobs (pg_cron, call `public.engine_call(action)`):
  `tick` every minute (NSE/MCX hours), `tick_crypto` every minute, `prices` every 10 s while any position is open
  (prices every second inside), `orders` while live orders are worked, `reconcile` every 5 min, `audit` daily 07:40 IST,
  lab jobs, margins, token check, billing.
- SQL via the MCP tool: statements containing the words drop/delete are blocked or need approval.

## Key behaviours (current state)
- Strategies run side by side in each tick (up to 8); booking trades/sending orders is serialized (`actLocked`).
- Every signal records `lag_ms` (decision delay after candle close), shown in the signal log.
- Prices: `live_prices` (per instrument) and `live_marks` (running P&L per open position, pushed to the app via
  Realtime). The minute tick and the order manager reuse these prices (no extra Dhan quote calls).
- Stops/targets/trailing stops are checked every second (`secondRisk`) and on 1-minute candles (`liveRisk`);
  exits are claimed with `exec_state='stopping'` + `exec_at` so they never run twice. Option premiums: minute only.
- Bulk actions (29 Oct 2026): Strategies page — tick rows (archived too) → Activate, Pause, Go live, Back to paper,
  Exit positions now (`desk_engine` flatten per open one; live ones warned), Allow new trades again (`kill_allow`), Archive
  (flat only), Restore. Strategy Lab (admins) — tick rows / select all shown → Save as strategies (the version the table
  shows, paused + paper; skips ones still in the tougher test or already on the desk), Star / Remove star, Download Excel.
  Test: `tests/ui/ui_bulk.mjs`. Also "Delete permanently" for ticked archived strategies (delete filtered on
  `archived = true`; Papa asked for it so the list doesn't grow too heavy).
- **Compare** (29 Oct 2026; sidebar "Compare", `cmpPane`, `renderCmp`): "⇄ Compare" on lab rows/cards/detail and desk
  list rows/cards/strategy page, or ⇄ Compare in either bulk bar; up to 4 (list in this browser's localStorage `cmp`,
  each keeps its colour slot `c`; a bar at the bottom shows the picks). Lab strategies use their futures backtest
  (`trades_long`), desk strategies their lab backtest if `lab_id`, else their own paper/live trades. Shows cards, profit
  curve, falls from the peak, profit per year, a figure table with the best marked (records under half the longest
  aren't marked) and an "All together" column, how alike their months are (correlation), and the rules. Period
  1Y/3Y/5Y/All. Colours `--cmp1..4` validated for both looks. Test: `tests/ui/ui_compare.mjs` (args: theme width).
  The lab strategy page (admin and public detail) has the same charts for the version open (`labCurveHTML` /
  `drawLabCurve`): profit curve, falls from the peak with the max drawdown marked (dates, days down, days to make back),
  profit per year / quarter / month, period 1Y/3Y/5Y/All.
- Lab strategy details open right under the clicked row (a `tr.ldrow` holding `#lab_detail`; after its card on a
  phone) instead of below the whole table; `labPlaceDetail` / `labParkDetail` move the one panel, `labShowDetail` scrolls
  only enough to show it. The lab table's CSS is scoped to its own rows (`.lab-table > tbody > tr > td`, `> thead`) so
  it doesn't leak into the tables inside the panel.
- **Combinations** (31 Oct 2026, Papa; admin sidebar tab, `comboPane`, `renderCombo` / `comboRun` / `comboEval`): pairs
  and threes of current passed lab strategies on the same asset and timeframe, different rules (best of each
  `familyKey` by consistency, top 150 families for pairs / 50 for threes, plus desk strategies' current results). Over
  the period all members were tested: share of their market time spent in a trade together ("In a trade together"),
  share of that on opposite sides, each one's net / max fall / net÷fall and the same together; "lessens the
  drawdown" = opposite sides ≥ 20% (`COMBO_MIN_OPP`, 31 Oct, after Papa saw long-only pairs on the same side 100%
  scoring better only because their trades fell at different times) AND net÷fall together > every member alone.
  Long-only / short-only members are tagged. Background check (31 Oct, migration 56, engine `combos.ts`, cron `lab-combos`
  every 10 min → action `combos`): a cheap per-group signature check; a changed asset/timeframe is re-checked in
  instalments (5,000 combinations ≈ 0.5 s CPU, position in `lab_combo_groups.cursor`), pairs then threes, same pool and
  rules as the page; combinations that lessen are upserted into `lab_combos` with `first_seen` (no longer qualifying →
  `current = false`, never deleted); the first full pass sets `baseline_at`, later new finds notify admins (kind "lab",
  link `/?combo=1`). Page shows a "New" tag (first seen after the baseline, last 30 days), an "Only new" filter and the
  last check time. Months alike = correlation over every calendar month of the common period (0 when no trades), the
  same in page and engine. Test: `tests/sim/combos.test.mjs`. Filters: opposite sides ≥ 0/20/30/40/50%, only those that lessen, search; row opens charts (members + all
  together). Computed in the browser from `trades_long`, nothing stored. Trades closing at the same moment count as one
  step for falls (also fixed in Compare's `cmpStats`).
- **Opposite positions in one Dhan account** (31 Oct 2026, migration 55): Dhan shows one net position per contract and
  product (a long and a short of two strategies = 0). `crossInside` (engine): before an order goes to Dhan, another live
  strategy's opposite order in the same contract/product still resting unfilled is cancelled and the two are matched in
  the desk at the LTP (`live_orders.cross_qty` / `cross_px`; a bigger order sends only the rest, its price = average) —
  avoids the exchange's self-trade check cancelling one of two same-moment opposite orders. Exit check subtracts the
  account's other live strategies' holdings (`othersHolding`) before deciding Dhan holds the position. The order manager
  re-reads each order's state before acting (a matched one is skipped). Reconcile already compares per-contract nets.
  Still to check in the supervised test (Gold Mini pair): margin Dhan blocks for each strategy's broker stop order
  while the account is net flat. Tests: `tests/sim/sim.test.mjs` "pair:" cases.
  Delta (same day): one net position per coin too. When another live strategy of the account holds the coin, an exit
  goes as a plain market order for this strategy's own part (after subtracting the others; refused if nothing of it is
  there), and its stop at Delta is plain instead of reduce-only (`pos_broker.stopRO`; re-placed when that changes).
  Market orders don't rest, so no matching inside the desk is needed on Delta. Tests: "delta pair:" cases.
  Test: `tests/ui/ui_combo.mjs` (args: theme width).
- Tables (31 Oct 2026, Papa): `makeSortable(table)` makes any heading without its own sort clickable (numbers by value,
  text A–Z, `td[data-v]` overrides; remembered per table id) — used by the Prediction Lab table; Combinations headings
  drive its own sort (`combo.sort` / `combo.sortDir`). `floatHeads()`: a fixed copy of a long table's heading row stays
  under the top bar while the table scrolls past (`#gfhead`; clicks go to the real heading); the Strategy Lab keeps
  its own `labFloatHead`.
- **System health** (31 Oct 2026, Papa: daily self-audit of every service; migration 58): `desk_health()` (SQL) checks 20
  services — website (fetched by `health_ping` at :09, read at :11), database, engine call answers, cron jobs, market
  and crypto ticks, live prices of open positions, live orders, broker match, Dhan token (amber within 3 h of expiry),
  strategy errors, daily self-check, margins, phone notifications, Strategy Lab, family counts, Ideas Lab, Combinations,
  Prediction Lab server, backtests (last 7 days) — ok / warn / fail / off, stored in `health_runs`. Cron `desk-health`
  hourly at :11, `desk-health-day` 08:11 IST sends admins a summary (kind "health", `/?health=1`); a check newly red
  alerts at once. Admin sidebar "System health" (`healthPane`, `renderHealth`, "Check now" → `health_check_now`) with a
  red dot on the link (`healthDot`, every 5 min) while anything is red or no check ran for 2 h. Test: `tests/ui/ui_health.mjs`.
  The cron checks read only the latest `cron.job_run_details` rows by runid (migration 62; the table can't be indexed);
  job history is kept 7 days (cron job 34 `job-history-cleanup`, 02:53 IST, approved by Papa 1 Nov 2026). Check ≈ 0.6 s.
- **Stock futures** (1 Nov 2026, Papa: "start with stock futures on 10 liquid Nifty 50 stocks"; `stocks.ts`, migration 59):
  RELIANCE, HDFCBANK, ICICIBANK, INFY, TCS, SBIN, BHARTIARTL, AXISBANK, LT, KOTAKBANK. Like the indices, signals and
  backtests use the share price (Dhan NSE_EQ, instrument EQUITY; no futures premium added) and orders go to the
  near-month stock future (`resolveLeg` → FUTSTK in `fno_contracts`, kept by `syncFno`; quantity = lots × lot size).
  Lot sizes from Dhan's F&O list at every request (`stockLots`), fallbacks in `STOCKS`. Futures only (no stock options;
  kept out of the lab's option-pricing queue), charges as index futures, slippage 0.03% (six busiest) / 0.04%, default
  margin 20%. Splits / bonuses: the lab's candle download (Dhan client with `adjust = false`) looks for overnight jumps
  matching a split / bonus ratio (`findSplits`, open and close must both match) in the raw daily and intraday candles and
  stores them in `stock_actions` (never deleted); every read (`readCandles`, and Dhan candles for NSE_EQ) multiplies
  earlier prices by the factor; files keep raw prices (`readCandles(..., raw = true)`). Not in the Prediction Lab (small
  server). Lab weight 1 per stock (as a commodity); strict-mode class "S". UI: preset group "Stocks (F&O)" (`STK`),
  `VAR_STOCK`. Tests: `tests/sim/stocks.test.mjs`, `tests/ui/ui_stocks.mjs`.
  Ex-dates (same day, migration 60; `stockExDate` in index.ts, `adjustPosition` / `splitFactor` in stocks.ts): the day's
  first price of a stock strategy (per-second loop and minute tick, before any stop check) against its own price from
  an earlier day (pos_ltp, or last_close when flat), else Dhan's raw close; a split / bonus ratio → `stock_actions` row
  for today (in_daily / in_intraday = whether Dhan's raw candles still show the jump) and each strategy adjusted once
  (`ca_day`): units and lot size ÷ f (lots unchanged), entry / stop / target / best / trailing points or ATR / broker fill /
  waiting breakout trigger × f, broker stop cancelled (syncStop places a new one), owner notified. 1:2 / 1:3 bonuses
  (25–33% gaps) count only when Dhan's F&O list shows the new lot (re-downloaded to check; else "price gapped" alert, no
  change). Flat stock strategies take Dhan's current lot (`stockLotSync`). The nightly download re-judges a known action
  inside unbroken raw candles (Dhan later adjusting its history turns that flag off). Test: `tests/sim/exdate.test.mjs`.
- Strategy Lab asset picker (1 Nov 2026, Papa; migration 61): a multiple-choice drop-down (`#lab_asset_btn` /
  `#lab_asset_pop`) — "All assets", asset types (Indices, Stocks, Commodities (MCX), Crypto; `ASSET_TYPES`,
  `assetTypeOf`) with a tick that selects the whole type (half-ticked when partly), and each asset. `lab.assets` ([] = all),
  `lab.asset` = "ALL" or keys joined by commas (`lab_feed`'s p_asset takes a comma list); admin queries use
  `labAssetQ` (`asset=in.(…)`). Remembered in this browser (localStorage `labAssets`). Test: `tests/ui/ui_lab_assets.mjs`
  (args: theme width).
- **Security review 1 Nov 2026** (engine entry points, database rules, browser): the engine accepts only the engine
  secret, a user JWT for `marks`, the prediction key or GitHub OIDC; `flatten` / `refresh` without a strategy_id are
  refused (400). Fixed: a client could edit engine-owned columns of their own strategy (now blocked by `guard_strategy`,
  migration 64 — SECURITY INVOKER, `current_user = 'authenticated'` = a direct app edit); `pos_option_type` was put on the
  page unescaped (XSS against the admin); the Dhan webhook secret was logged in `algo_signals.payload` (no longer; 121 rows
  stripped); private variation-run results reachable by id (migration 65); `esc()` now escapes `'`; CSV cells starting
  with = + - @ are prefixed; notification links open only this site. Still open (Papa to decide): table grants to anon
  are ALL (RLS is the only barrier) — revoke and grant back what the app needs; `set_live` lets a client go live without
  the supervised test; `notify_test` has no rate limit.
- **Lots wizard** (2 Nov 2026, Papa; Capital page card `#lw_card`, `lw` / `lwPlan` / `lwRender` / `lwChanges`): sizes the
  current mode's (Live / Paper) strategies four ways — equal capital each, a % each, lots per asset, or equal risk
  (default: capital × % ÷ (backtest worst fall per lot `sizing.dd_per_lot` × safety multiple)). Margin per lot =
  `lab_margins.price` × lot size × Dhan's rate (`dhanRateFor`); options / structures are left out. Capital prefilled
  with capital + that mode's P&L. "Apply these lots" saves `lots` and `sizing.mode = 'FIXED'` for ticked strategies that
  change; 0-lot or unsized ones are left as they are. The engine exits with the quantity held (`pos_qty`) and enters
  (also after a reversal) with the saved lots, so a change applies from the next entry. Test: `tests/ui/ui_lots_wizard.mjs`
  (args: theme width).
  **Same ₹ on a typical day** (4 Nov 2026, Papa; the default and recommended way, `lw.method = "move"`, `lwMove` /
  `lwMoveLots`): equal per strategy (several strategies per asset while in trial; one per asset when live), lots =
  target ÷ (price × lot size × the asset's typical day's move), whole lots; target = the box `#lw_moveAmt` or the
  largest whose margin fits the wizard's limit. Typical day's move = average true range of the last 20 daily candles ÷
  previous close (`dayMovePct` in margins.ts), stored as `lab_margins.day_move` by engine action `day_moves` (cron
  `day-moves`, 08:51 IST daily; migration 73). Too-big contracts round to 0 lots (shown, left as they are). Tests:
  `tests/sim/daymove.test.mjs`, `tests/ui/ui_lots_wizard.mjs`.
  Fixed lots obey the limit too (2 Nov 2026, Papa): `sizeEntry` → `fixedLotsFit` (sizing.ts) cuts a fixed-lot entry to the lots
  that fit under "Never use more than" × (capital + P&L) minus this mode's other open positions (40 wanted, room for 36 →
  36; Papa, 2 Nov), skips only below 1 lot; only when a capital is set and the margin per lot is known; an exit in the
  same signal still goes. Test: `tests/sim/sizing.test.mjs`.
- **Drawdown check** (2 Nov 2026, Papa; Capital page `#cap_dd`, `capDd`): for the mode's active strategies (Live / Paper
  tab), each one's trades from `cmpLoad` (lab backtest × the lots it trades now, else its own desk trades) → worst fall
  alone (all its years), all together on one curve (common period from the latest first trade; all history if that is
  under a year), average, upper bound (sum), margin if all are in a trade — as % of capital + that mode's P&L.
  Suggested "Never use more than" = 100 − 1.5 × max(together, worst single), floored to 5, 10–90% ("Use N%" fills the box;
  Save keeps it). Tested in `tests/ui/ui_lots_wizard.mjs`. `floatHeads` skips tables inside closed `<details>`.
- **Strategies table views** (2 Nov 2026, Papa: "a very precise view"): `#lp_view` Simple (default; `listColsSimple`: Asset
  with the Lab # and timeframe under it, Long / short, Lots (held; "N next" when flat), Running P&L, Booked P&L, Status)
  or Detailed (the full table as before). Remembered in localStorage `lpView`; desktop only (phones keep the cards).
  Test: `tests/ui/ui_list_simple.mjs` (args: theme width).
- **Spread watcher** (2 Nov 2026, Papa, after the arbitrage research: colocated nanosecond arbitrage is out of reach;
  measure what our speed can use first; migration 69, engine `spreads.ts`, action `spreads`, cron `spread-watch` every
  minute; watch only, no orders, 30 days from `spread_state.started_at` to `until`, rows in `spread_ticks` never deleted).
  Best bid / ask (Dhan `quoteMany` = /marketfeed/quote, sharing the one-a-second quote pacing): nb = the 10 stocks NSE vs
  BSE every minute in market hours (intraday charges `nbCostPct` ≈ 0.041% at ₹10 lakh); cf = every F&O stock's share vs
  near / next future every 15 min (cost `CF_COST_PCT` 0.25%, yearly = net × 365 ÷ days); cx = Delta India vs CoinDCX
  futures BTC/ETH/SOL every minute 24x7 (`CX_COST_PCT` 0.236%, both funding rates). Security ids from Dhan's NSE_FNO
  (UNDERLYING_SECURITY_ID) and BSE_EQ lists, once a trading day from 08:30 (that round quotes nothing). Admin page
  "Spread watcher" (`spreadPane`, `renderSpread`, SQL `spread_summary`). Tests: `tests/sim/spreads.test.mjs`,
  `tests/ui/ui_spread.mjs` (args: theme width).
- **Desk** (3 Nov 2026, Papa, from a Polymarket bot screen he liked; sidebar "Desk" for every user, `deskPane`,
  `renderDesk`, state `desk`): a control-room page, deliberately dark in both looks (`#deskPane` own `--dk-*` colours),
  Live / Paper toggle (default Live if any active live strategy). Ticker strip (latest moves and closed trades), IST clock,
  NSE / MCX / Delta open lights; account card (running P&L from `pos_upnl`, booked = sum of the mode's `algo_trades`
  incl. archived strategies, win rate, margin in use vs the saved limit, long / short, margin by asset); **profit flow**
  canvas (Papa's design): one stream per open position into a pool; each live price move (`onMark` → `deskMove`) sends
  green dots for a gain, red for a loss; the pool's dot count follows the running total (about one per ₹1,200, 150–1,500),
  red throughout while the total is a loss; drawn as the "plasma storm" (Papa, 3 Nov, idea 2 of 6 in a preview): free dots ride a
  swirling current inside a changing outline (`deskShape`) with light trails, three soft clouds; every stream carries a steady
  trickle (`desk.amb`), price moves send 2–8 bright dots with trails, at most 3 soft rings at a time; the running P&L box sits in the panel's top-right corner (Papa, 3 Nov), with the mode's booked P&L under it (`desk.booked` = `bookOf`, Papa, 4 Nov); on phones the cloud is about half the width and the panel 500 px tall, the label column as wide as the longest asset name needs (≤ a third), longer names wrap; seven decorative agents (`DK_AGENTS`, `deskAgents`: server feed, pricing, investigation, strategy, risk guard, order, audit — Papa, 3 Nov: "just for decor", no data or decisions) (a column on the right-hand side under the running P&L box, overlapping the cloud a little — Papa, 3 Nov; each a very small computer with its name below in its own colour, a very faint, small glow while one of its streams is lit) with thin, dashed, on-and-off streams to every asset (made more visible 3 Nov); each trade stream ends at its own point inside the cloud and its tail sways like a snake (`deskWiggle`); an asset whose market is shut (`deskClosed` → `marketOpenFor`, crypto never) gets a big red dot (no text — Papa, 4 Nov), no stream into the cloud and no agent streams; full-screen button (`#dk_fs`, `deskFull`: browser full screen where allowed, else the panel covers the page; Esc / same button exits; leaving the Desk exits); strategy tiles coloured by running P&L (tap opens the strategy); 3-week
  timeline (open positions as bars, closed trades as dots); capital flow (margin: asset → long / short → in profit / in
  loss); activity list; stats bar. Animation runs only while the page is open and visible (`deskStop`). Test:
  `tests/ui/ui_desk.mjs` (args: theme width).
- **Desk · capital deployed vs profit** (3 Nov 2026, Papa: "a perpetual graph … any time in the past"; migration 70):
  cron `desk-snapshot` every 5 min → `desk_snapshot()` stores per user and mode margin in use, running P&L, realised P&L
  (`ledger_net_user`) and open positions in `desk_snapshots` (kept for good, ~600 rows a day); `desk_series(mode, from, to,
  points)` returns them bucketed (~600 points) plus the first snapshot's time. Desk panel `#dk_cvp_box` (`dkCvp`,
  `deskCvpLoad` / `deskCvpBuild` / `deskCvpDraw`): shaded capital deployed (right scale) and a profit line (left scale,
  green above zero, red below) — tabs Realised / Running / Total, periods 1D–1Y / All, From–To dates, drag to zoom (Reset
  zoom), Expand, hover read-out (deployed, profit, profit ÷ deployed). Before the first snapshot (first rows 3 Nov 2026, 18:44 IST)
  deployed is estimated from closed trades (entry price × units × today's margin rate, dashed)
  and running P&L isn't on record; the live end is the current state. Tested in `tests/ui/ui_desk.mjs`.
- **Same page after a refresh** (3 Nov 2026, Papa): `savePage` stores the page, the open strategy and the Strategies tab in
  this browser (localStorage `lastPage`, per user) on every page change; start-up reads it and, when a saved page will be reopened, keeps the loading card up
  instead of the Strategies list (no flash; Papa, 3 Nov), then `restorePage` reopens it after the data loads (admin pages only for admins; a strategy that no longer exists → the
  list; links with ?s= / ?lab= … still win). Test: `tests/ui/ui_refresh.mjs` (args: theme width).
- **One set of figures, always fresh** (3 Nov 2026, Papa: figures differed between pages and the app showed stale data):
  `bookOf(mode)` (every closed trade of the mode, after charges, hidden out, archived / deleted strategies included —
  `myTrades` from `loadPnl`, the signed-in user only) and `runOf(mode)` (open positions' running P&L and margin from the
  live prices) feed Capital (server figure only when "count from" is set), Desk, the Strategies totals ("these rows" plus
  "account …incl. archived") and the Trades tab (archived strategies ticked by default). `refreshAll` reloads strategies,
  positions, P&L, capital and the open page's own data (`deskSoft`, `loadCap`, Live / Trades / Orders tabs) every 30 s while
  the app is on screen (market open or not) and on coming back (visibilitychange, pageshow, focus, online; at most every
  10 s). Unsaved strategy settings are kept (`formDirty`). Test: `tests/ui/ui_sync.mjs`.
- **Exit safety (Phase 1, 4 Nov 2026, Papa: "stop silent losses"; migration 71; tests `tests/sim/safety.test.mjs`)**:
  paused = no new entries only — the tick, the per-second stop (`secondRisk`) and reconcile also run paused strategies
  that hold a position (stops, exit signals, square-off; entries blocked by `_block`). Exits of a single-leg futures
  position go to the contract held (`heldLeg` from `pos_broker`, quantity held), never "today's" near month. One decision
  per candle: `claimSignal` writes the signal row before any order (migration 66's unique index; a repeat sends and
  changes nothing). Live Dhan exits are booked `provisional` with `order_batch`; `fixLedger` finds the trade by batch and
  confirms it with Dhan's fills (structures leg by leg). An exit Dhan rejects (also at market) puts the position back
  from `live_orders.restore`, hides the provisional trade and sets `exec_state = 'exit_retry'` (`exitFailed`): the broker
  stop goes back in, `retryExit` tries again every minute, after 5 tries (`EXIT_TRIES`) it stops, pauses and asks to close
  by hand; the same for exits that didn't go (Delta, a stop that couldn't be cancelled). `cancelStop` confirms a stop is
  really gone before an exit (else nothing is sent). `stuckWorking`: "working" for 10+ min → orders re-read from Dhan
  (fill booked / failure handled / queued leg sent / empty flag cleared, owner told). A partly filled entry that is given
  up or cancelled keeps the part filled (`partEntry`: pos_qty, lots, margin, its own stop). Dhan stop orders are day
  orders: none is placed outside the session (`syncStop`), an expiry at the close isn't an alert, the stop goes back in at
  the next open, reconcile alerts when an open position has no broker stop 5 min into its session. Options close on their
  expiry day at 14:30 (`expiryExitDue`; `risk.expiry_exit = false` / `risk.expiry_exit_time` per strategy); a held option is
  never priced from another expiry (`Dhan.premium` exact); entries take the next expiry Dhan lists (`Dhan.expiries`).
  UI: "Exit retrying" chip; the Pause confirmation says positions keep their stops.
- **Error circuit breaker (Phase 2, 4 Nov 2026; Papa took only this part of the account risk layer — no account daily
  loss limit, no position caps; paper and live alike; migration 72)**: per user in `risk_state`, the minute ticks
  (market and crypto) count runs where every strategy run of the account failed (`breakerAfterTick`); one that worked
  resets the count; strategies only waiting for their candle don't count. At `BREAKER_TICKS` (5) new entries stop for the
  whole account (`_block`; exits, stops, square-off keep running) and the owner is notified once; only "Allow new trades
  again" (`breaker_allow`, own account or admin) clears it. Red banner `#breakerAlert` (`loadBreaker`, every minute).
  Tests: `tests/sim/safety.test.mjs` "breaker:", `tests/ui/ui_alert.mjs`.
- Holidays: `market_holidays` table + `tradingSession` in logic.ts.
- Daily self-check (`desk_audit`): replays each strategy's last 30 days of trades with the backtest engine and flags
  missed/extra trades, different exits, or the desk > 0.25% worse on price. Shown on the Trades page.
- Totals (`ledger_net_user`, `ledger_net`, `admin_users`) exclude hidden trades.
- Lab strictness (rev 4, 23 Oct 2026): a **vault** (last 6 months; 3 for MCX minute strategies) is held back from
  generation, ranking and every check (`preVault`), and tested once at the end (check kind `vault`); a **luck
  adjustment** (Deflated Sharpe on the trades, `stats.ts`, tries = lab-wide rule families from `lab_trial_families()`,
  95% needed); ≥ 3 of 4 neighbouring settings profitable; profitable without its best 5% of trades; ≥ 30 trades
  (daily) / 100 (minute) over the years tested; doubled slippage for daily strategies too. Breeding from winners is off
  (`lab_settings.evolve`). `lab_reverdict` re-scores stored results under the current rules (rev 5); full re-tests go through `lab_refresh`.
  First preview: none of the 24 desk lab strategies passes the luck test (best t = 3.4).
- **Simple rules (rev 5, 27 Oct 2026, Papa: "relax, reward continuous profit")** — the default; `lab_settings.strict`
  brings back rev 4. The full test is only the strategy itself, its years and the vault. Pass = profitable in all but
  one year in five (8 of 10, 4 of 5; quarter rule unchanged), profitable in total with slippage doubled, ≥ 30 / 100
  trades, vault profitable. Luck, best-trades cut, nearby settings, other assets/timeframes and phase 2 are shown for
  information only. Ranked by the **consistency score** (`consistencyScore`): years 25, quarters 25, smoothness 20
  (R² of the month-end curve + evenness of yearly profits), return ÷ drawdown 15, worst year 15; Lab page column
  "Consistency", default sort. Stored results are re-scored in place by action `lab_reverdict` (no backtests).
  Passing = worth paper trading, not proven.
- Lab phase 2 (finalists only, i.e. strategies that passed everything above): 100 runs on shuffled candles
  (`noise.ts` `shuffledData`; check kind `noise`, tf 0 = real) and 1,000 sets of random entries (`random`); the real
  result must beat 95% of each. Overfitting gauge: Probability of Backtest Overfitting (CSCV, `stats.ts` `pbo`) per run,
  asset and mode from every fresh try's monthly results (`lab_months` → `lab_pbo`), shown on the Lab page.
  Near-identical winners are already grouped as twins (`lab_assign_twin`, 80%+ shared entries).
- Kill rule (phase 3, `kill.ts`, run daily with the self-check): a running lab strategy's own trades (per lot) against
  2,000 bootstrap sets of its backtest trades; under the worst 1% after 10 trades or the worst 5% after 20, `kill_at`
  is set, new trades stop (exits still run) and the owner is notified. "Allow new trades again" (`kill_allow`) clears it
  and it is judged on later trades only.
- **Ideas lab (step 3, 25 Oct 2026; `ideas.ts`, migration 45)**: 7 ideas from research, 47 settings written into the
  ledger `idea_tries` before testing (trend following daily on MCX incl. minis + indices + crypto; relative strength among
  commodities; index short-term reversal; index opening-range breakout; index calendar effects; option selling and
  crypto funding signal were built next, same day). Each setting = a portfolio for ₹35 lakh (`lab_settings.ideas_capital`):
  one contract per commodity picked by risk (`pickContracts`, minis where the big lot is too big), each trade sized so a
  lot's daily ATR ≈ 0.2% of capital. Tests: 8 of 10 years profitable (Papa's choice for portfolios), doubled slippage
  (total and 8 of 10 years), ≥ 100 trades, best 5% of trades removed, ≥ 75% of the idea's settings profitable, luck
  (Deflated Sharpe on monthly returns; tries = the ledger, finished ideas counted by effective tries ρ + (1 − ρ)·M),
  held-back last 6 months. Passing all = "finalist", then stage 2 (migration 48): 100 runs of the whole portfolio on
  shuffled candles (each asset shuffled on its own, same contracts and sizing; `idea_legs` kind 'noise', k 1..100) and
  1,000 sets of random entries (kind 'random', `weightedRandomEntries`, close to close, costs left out on both sides);
  p ≤ 5% in each = passed (`stage2Verdict`). Option selling can't be shuffled or randomised (real option prices, every
  week traded): its finalists pass with `stage2.applies = false` and the reason shown. Score 0–100:
  years 30, return/drawdown 20, slippage years 15, months 10, settings 10, luck 15. Runs one idea at a time, cron
  `ideas-lab` every 2 min → `engine_call('ideas')`, only while `labQuiet`; independent of the Strategy Lab (26 Oct, Papa:
  two separate labs) — it ignores lab runs, rests and manual stops and waits only for a slow database (pause_reason
  'slow'); switch `lab_settings.ideas_enabled`. Own sidebar tab and page "Ideas Lab" (admins; `ideasPane`, refreshes every
  30 s while open); the Strategy Lab page is back to its own content. The random generator is paused
  (`lab_settings.enabled = false`, 25 Oct). First full round (25–26 Oct): 0 of 47 settings passed; closest: iron condor
  1.5 SD with a short-strike exit (Sharpe 1.0, 3 of 4 years, luck 52%), trend following (4–12%/yr, luck ≤ 36%).
  Generator v1 (26 Oct, migration 49; Papa: 20 new ideas a day, `lab_settings.ideas_per_day`): plain code, no AI —
  `generatedIdeas()` = 8 signals × 5 filters × 5 markets × 2 directions (396, seeded order fixed in advance, research
  recipes skipped), 4 settings each with the rules carried in the setting; `generateDaily` writes up to the day's
  quota into `idea_defs` (none while 20 generated ideas wait), the combined near-misses (`COMBO_1`, kind "combo": parts
  = existing settings, capital split equally or by risk, figures only while every part has history; option parts stay
  real in stage 2) first. The Ideas Lab chains its instalments continuously while it has work.
  Option selling (idea 5, migration 46): weekly Nifty iron condors / hedged strangles / credit spreads, in 09:30 the day
  after an expiry, out 14:30 on expiry day (`weeklyExpiries`: Nifty expiry Thursday until 28 Aug 2025, Tuesday after,
  holidays a day earlier — `weeklyExpiryWeekday` in logic.ts, also used by the backtester's `isExpiry`); short strikes
  sd × 20-day volatility × √days out, capped at 10 − wing steps (Dhan's rolling data covers ATM ± 10); lots so the wing
  width risks ≤ 2% of capital. Priced by `priceBatch` with plan-level legs (`Plan.sk`) from Dhan expired options
  (cache `lab_opt_cache`), in 8-second resumable slices chained call to call (`ideas_lease_until` prevents overlap);
  `edge_fill` prices strikes beyond ± 10 at intrinsic / 0.05 so big-move weeks aren't dropped (counted, `edge_legs`).
  Crypto funding signal (idea 6, migration 47; Papa chose the unhedged version — Delta India has no spot to hedge
  with): short a coin when the previous day's Binance funding > th % per 8h, long when < −th, else out
  (`fundingTrades`, each day held booked with the day's funding: Delta's rate from Dec 2023, Binance's before). Binance
  history (free, fapi.binance.com, reachable from Supabase) stored as lab candles kind "FB", refreshed weekly.

- **Prediction Lab (27 Oct 2026, migration 51; `prediction.ts`, `predictor/`)**: Chaturbhuj — Papa's name for the forecasting model
  (28 Oct: "don't call it Kronos"; use Chaturbhuj in everything Papa sees). It is the open-source Kronos-mini (MIT;
  code pinned at commit 67b630e, weights from Hugging Face on the server; library names in code stay Kronos). Chaturbhuj forecasts every lab asset on 5m, 15m, 30m, 1h, 4h
  and daily candles, 10 candles ahead (o/h/l/c). Scored per step against baselines: direction vs "last move continues",
  close vs "price stays the same", high–low range vs the recent average swing; paired t-values; "Beats" = t > 2 with
  ≥ 100 forecasts. Replay from 2025-09-01 (after the base model's training data) kept apart from live forecasts (`pred_stats.mode`),
  in passes (Papa, 27 Oct: results soon, then ever more data): pass 1 ≈ 100 evenly spread candles per asset and
  timeframe, each later pass halves the spacing (nested, grid fixed in the server's kv `grid|asset|tf`) down to every
  10th candle (every one for 4h/daily); it keeps going in the background. Server memory: candles as arrays, raw 5m bars
  trimmed after building; first start needed the AWS disk enlarged to 20 GB (27 Oct). Step 1 (migration 52): 5 paths per forecast on 1h/4h/daily
  (`pred_settings.samples`; the average path is the forecast, the share of paths up per step gives the confidence;
  `pred_stats.conf` bands lo/mid/hi = ≤3, 4, 5 of 5 agreeing; older single-path forecasts on those timeframes are
  redone). Step 2: correction layer `predictor/calib.py` — logistic model per timeframe and step, pooled across assets
  (inputs: Chaturbhuj's move ÷ usual swing, paths agreeing, last 1/5/20-candle moves, time of day, asset type), refitted every
  3 h walk-forward (each month only from outcomes known before it; needs 300), `pred_stats.cal_n/hit_cal`; page columns
  "Corrected" and "All paths agree". Fine-tuning (28 Oct, migration 54): GitHub Actions `chaturbhuj-finetune.yml` (manual; free runners; no stored key:
  each request carries a GitHub-signed OIDC token, accepted by the engine only for this repo's main branch and this
  workflow — `githubOidcOk`, header `x-gh-oidc`, opens pred_pull and model_run only): `finetune.py` trains the Chaturbhuj predictor (tokenizer frozen, the base model's recipe) on every asset and
  timeframe's candles before 2025-09-01 only (last 90 days before it for checking, best checkpoint kept), `evaluate.py`
  compares original vs fine-tuned on the same unseen candles from the cutoff (per asset group in parallel), `report.py`
  sends the results (`pred_push` model_run → `pred_models`); weights = GitHub release asset. Page section "Fine-tuning".
  The server keeps the original until Papa chooses (switching would need model-tagged stats). Runs on the Dhandha AWS server (t4g.small, Mumbai, shared with the
  crawler) as Docker `ankgenie-predictor` (image `ghcr.io/caankitgargsitools/ankgenie-predictor`, GitHub Actions
  `predictor-image.yml`, own Watchtower; `--memory 1200m`, low CPU priority; forecast detail in SQLite on its volume).
  It talks only to the engine with its own key (`x-pred-key`, sha256 in `pred_settings.key_hash`, made on the page by
  `pred_create_key`, shown once inside the setup script): `pred_pull` (settings, assets, signed links to the lab's
  candle files, live bars, holidays) and `pred_push` (heartbeat `pred_worker`, `pred_latest`, `pred_stats` whole-month
  rows). Crypto candles: Binance public 5m. Live Dhan 5m candles: engine `pred_feed` every 5 min into `pred_bars`
  (only while the server reported in the last 30 min). Page: admin tab "Prediction Lab". Watch only; path: accuracy →
  paper trading → live, each with Papa's go. Tests: `predictor/tests/test_predictor.py`, `tests/sim/pred.test.mjs`,
  `tests/ui/ui_pred.mjs`.

## Incident 23 Oct 2026 (state to restore)
- A daytime lab re-test (3,930 saved strategies) plus per-second price writes used up the database's disk allowance on
  the smallest Supabase compute (~0.5–1 GB RAM, DB 778 MB, lab_results ~870 MB with toast): API 503s 16:34–17:17 IST,
  sign-in down until ~17:25, cron "job startup timeout" (about half the ticks missed) until ~22:25 IST.
- Still in place: engine light mode now switches itself on only while the database is slow (`slowDb`, from another
  session's fix; `ENGINE_LIGHT=1` forces it); lab cron jobs
  2, 3, 10, 12, 15 paused and `lab_settings.paused_until` set; 3,930 strategies still queued in `lab_refresh`
  (re-test runs now night-only, 100 per run). Restored: jobs 24, 19, 18, 6; authenticator statement_timeout back to 8s.
- 24 Oct: re-test resumed in small batches (Papa chose this over the upgrade for now): `lab_settings.retest_until_done`
  makes the lab run only re-test batches of 100 with 10 minutes' rest, while `labQuiet` (night, weekends, holidays, or
  no Dhan market of a running strategy open ±15 min). Lab jobs 3 and 10 back on; 2, 12, 15 stay paused.
- 24 Oct afternoon: re-test paused again (statement timeouts, up to 72/h) with `paused_until` ~03:07 IST 25 Oct; runs
  356–364 re-tested ~900 saved strategies, none passed. Fixes: the queued-winners lookup filters `basic_passed` (uses
  `lab_results_robust_q`); rule-family counts for the luck test are stored in `lab_settings.families` by
  `lab_families_refresh()` (cron `lab-families`, 03:10 IST) — the live function took ~9 s and timed out, and the engine
  had silently used 10 tries; it now refuses to judge without the stored counts. Lab page: "From" lists each recent run
  with a per-run summary (passed / failed and the top reasons).
- Recommended to Papa: one-size compute upgrade; later, move old lab results out of the database (needs approval).
- Seen in the outage: an ENTRY signal logged twice when the position update was slow (one position booked) — make
  entry logging idempotent per candle.

## Pending decisions for Papa (gone through with Papa on 4 Nov 2026; ask again only what is still open)
Decided 4 Nov 2026 (to build, in this order): (9) a second live strategy on the same asset only **warns** when going live;
(10/12) lots follow the typical day's move **at each new entry**, changes under ±20% ignored; (1) positional futures
**roll the day before expiry** (exit, re-enter the same side in the next month); then the GitHub items: a one-time
backtester cross-check with vectorbt (free), 10–20 well-known strategy ideas through the Ideas Lab (free), and tick-level
prices from Dhan's WebSocket feed (paid: show Papa the server plan and monthly cost first, build only after his go).
Done 4 Nov 2026 (migration 74): `notify_test` limited to once a minute per user; the 10 backtests stuck "running" marked
failed ("stopped: never finished"); Anshul's two paper strategies paused, his error stop cleared, he was notified to
connect Dhan; cloud-session start-up hook (`.claude/settings.json`, `.claude/hooks/session-start.sh`). Kept as is:
clients may go live by themselves (Papa: keep `set_live` as it is); the Strategy Lab generator stays on.
Still open:
1. **Broker stops across the night**: Dhan stop orders are day orders; use Dhan's Forever Order (GTT) for positional
   stops? Test in the supervised 1-lot test. (Papa, 4 Nov: discuss later.)
2. **Database permissions**: tighten table grants (anon / authenticated have ALL; RLS is the only barrier). (Discuss later.)
3. **Supabase compute upgrade**: not done yet; later.
4. **Prediction Lab**: Papa chose the confident-only signal (all 5 paths agree + corrected ≥ 55%) as the next step, but
   keep it pending until he asks. Other ideas from 1 Nov (filter on lab strategies, range for stops / lots, bigger models,
   fine-tune round 2) stay on the shelf.
5. **Lot sizing, the rest of the 1 Nov questions**: capital and limit per account, rules for clients.
6. The unfinished question "Also, I want to understand…" (1 Nov).

## Open items
- **Held futures across their expiry (found 1 Nov 2026, awaiting Papa's choice):** a positional futures strategy keeps
  its position past the contract's expiry in the desk's books, but the exchange settles it (index futures in cash,
  stock futures by delivery of the shares). A later exit resolves to the next month's contract and would open a new
  opposite position. Options: square off (and re-enter in the next month = roll) on the day before expiry, or block
  positional futures over expiry. Must be fixed before any positional futures strategy goes live.
- Supervised 1-lot live test (NATGASMINI, Lab #6038) once Papa adds Dhan funds and whitelists the IP.
- Risk-based lot sizing per strategy (drawdown-based), and not running two strategies on the same asset at once
  (GOLD 1 kg contract dominated the paper loss) — proposed, awaiting Papa's go-ahead.
- Tick-level prices/stops need Dhan's WebSocket feed on an always-on server (~₹500–1,500/month) — offered, not built.
- Slippage column on Orders + per-strategy slippage summary (signal price vs fill) — proposed.
- Pending (Papa, 27 Oct) for the Prediction Lab, after the Chaturbhuj results: server expansion (separate
  t4g.medium ~₹2,000/month, or the Dhandha server to t4g.large); larger versions of Chaturbhuj (base model small, base); fine-tuning
  Chaturbhuj on our assets (train only on data before Sept 2025, then monthly walk-forward; free Kaggle/Colab GPU first,
  rented GPU ~₹50–150/h if needed); longer look-back (up to 2,048 candles for mini); more context inputs (India VIX
  with Nifty, Bitcoin with other coins); more samples per forecast on the shorter timeframes.
- Ideas from the Tradl.ai review (one-page backtest report, morning brief, featured shelves) — proposed.

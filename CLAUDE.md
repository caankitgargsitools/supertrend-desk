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
- Cron jobs (pg_cron): since 6 Nov 2026 (migration 81) one job `engine-minute` → `engine_minute()` does the minute work in one
  session (`tick` in NSE/MCX hours, `tick_crypto`, `orders` while live orders are worked, `push`, `spreads`, the backtest
  kick, `desk_snapshot`; every 5 min `reconcile` and `pred_feed`); `live-prices` every 10 s in market hours or while a
  position is open (prices every second inside); `audit` daily 07:40 IST (then `kill`); `desk-health` hourly; lab jobs
  (paused since 6 Nov), margins, token check, day moves, Shukrana reminder.
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
  Test: `tests/ui/ui_bulk.mjs`. **Add to marketplace** (5 Nov 2026, Papa; admins): the ticked strategies that aren't archived,
  bought (locked) or a listing's copy, and aren't already listed (not hidden), each go through `publish_strategy` as a
  draft listing (title = name without "Lab #n · ", summary = asset · futures/options · candle size, one price typed in
  the confirm box), backtests queued; published from the Marketplace page. Also "Delete permanently" for ticked archived strategies (delete filtered on
  `archived = true`; Papa asked for it so the list doesn't grow too heavy).
- **Marketplace: add several at once** (5 Nov 2026, Papa: admins and users): a "Select" tick on every published listing,
  "Select all shown", a bar with the count, the total price (owned ones are free copies) and "Add selected" → one form
  (capital each or lots per trade, max lots, the risk tick) → `buy_listing` per listing, a progress line while it runs;
  ones that fail (e.g. not enough in the wallet) stay ticked. `mk.pick`, `renderMkBulk`, `bulkBuyForm`. Test:
  `tests/ui/ui_market_bulk.mjs` (args: role theme width).
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
  RELIANCE, HDFCBANK, ICICIBANK, INFY, TCS, SBIN, BHARTIARTL, AXISBANK, LT, KOTAKBANK; **6 Nov 2026 (Papa) 23 more** (33):
  ITC, HINDUNILVR, BAJFINANCE, BAJAJFINSV, MM (Dhan's "M&M": `DHAN_ALIAS`, mapped in `fnoUnderlying`, since & breaks links /
  filters), MARUTI, TMPV (Tata Motors passenger vehicles after the demerger), TATASTEEL, JSWSTEEL, SUNPHARMA, TITAN,
  ADANIENT, ADANIPORTS, NTPC, POWERGRID, ONGC, COALINDIA, HCLTECH, WIPRO, ULTRACEMCO, ASIANPAINT, HDFCLIFE, SBILIFE (ids /
  lots from Dhan's NSE_FNO list; admin engine action `instr_find` {seg, q, ins} searches a Dhan list). **Sensex 50** index too
  (6 Nov: Dhan IDX_I 83, BSE F&O SENSEX50, lot 75, step 50, monthly, Thursday). Fixed the same day: order symbols lost
  digits before "1!" (`/\d*!$/` → `/[1-9]!$/`), so NIFTYNXT501! had resolved to "NIFTYNXT". **Coins** (6 Nov): BNB, ADA,
  AVAX, LINK, LTC switched on (crypto_assets, synced from Delta); DOGE added but off (thin on Delta India). Like the indices, signals and
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
  `tests/sim/daymove.test.mjs`, `tests/ui/ui_lots_wizard.mjs`. **It follows the move by itself** (Papa, 4 Nov 2026,
  pending item): Apply saves `sizing = { mode: "MOVE", move_amt }` (also a "How many lots" choice in the strategy form,
  `z_mode` MOVE / `z_move`); at every new entry `sizeEntry` → `moveLots` (sizing.ts) sets lots = move_amt ÷ (entry price ×
  lot size × today's `day_move`), keeps the lots held when the exact figure is within ±20% (`MOVE_BAND`), saves new lots
  on the strategy, skips the entry below 1 lot, then the "Never use more than" limit applies as for fixed lots. Lists
  show "≈N next". Tests: `tests/sim/sizing.test.mjs` "move:", `tests/sim/safety.test.mjs` "move sizing".
- Going live warns (doesn't block — Papa, 4 Nov 2026) when another live strategy of the account trades the same asset
  (`sameAssetWarn`, single and bulk Go live). Test: `tests/ui/ui_bulk.mjs`.
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
- **Desk · one screen** (6 Nov 2026, Papa: "fit it in one screen … hide the menu on the left"): on screens ≥ 1280 px the
  Desk opens as one screen-high grid (`body.dk-one`, `deskOneApply`; toggle `#dk_one` "One screen" / "Show menu", on by
  default, remembered in localStorage `deskOne`): the left menu is hidden while the Desk is open (`hideNewPanes` removes
  the class on leaving). Layout (rearranged 6 Nov, Papa, 1920×1080 screen; columns left → right, his screen sits to his
  left so the account is on the right): capital deployed vs profit over capital flow · strategy tiles over timeline ·
  the profit flow, a tall column over both rows (~845 px wide at 1920) · account over activity; the stats bar below
  (dates, note and Expand of the capital chart hidden). **Quotes strip** in the top bar (replaces the scrolling feed;
  migration 77): **every tradable asset** (6 Nov, Papa: "add the new assets"): all indices (Nifty 50, Sensex, Bank Nifty, Fin
  Nifty, Midcap first), one quote per MCX commodity (`TICKER_MCX`, big contracts), all 33 stocks (by NSE symbol), every coin, plus
  anything else an active strategy trades; grouped with labels (Indices / MCX / Stocks / Crypto, `.dk-qg`); in one-screen the
  quotes take the full width under the title (≈5 rows) and the Live / Paper switch sits in the title row; price and % today vs the previous close, a chip flashes green / red when its price moves (`deskQuotes`, every
  3 s from `live_prices`; `ticker_ref` = asset per contract + previous close, engine `tickerRefresh` with action
  `day_moves` and hourly in the token check for new assets, action `ticker`; the per-second prices also fetch the
  fixed indices every round, `TICKER_FIXED`, and the rest of `ticker_ref` every 5th round in the same batched requests). Many open positions (lane < 27 px): each lane's name and amount on one line (`desk.laneH`), the label column
  widens for it; 30+ positions fit from ~900 px tall. Capital deployed vs profit is minute by minute (migration 76:
  `desk-snapshot` cron every minute from 6 Nov 13:46 IST, `desk_series` down to 1-minute buckets; 1H and 1D ranges, 1D the default; "1 point = N min" beside the periods, `#dk_cvp_step`). The one-screen cloud is bigger (R up to 45% of the room right of the labels; phones unchanged). Timeline / capital flow size to their boxes
  (`clientHeight`), long asset names shorten with "…" (`dkFit`, full name on hover), narrow boxes get shorter labels.
  Tested in `tests/ui/ui_desk.mjs` (args: theme width [height]; every panel inside the window, no page scroll).
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
- **Positional futures roll the day before expiry** (Papa, 4 Nov 2026; closes the open item "held futures across
  expiry"): `rollDue` — a carried-overnight (not intraday / product I) single-leg futures position (index, stock, MCX; not
  crypto, not structures) from 15:00 IST (`risk.roll_time`) on the weekday before its contract's expiry (at once if that
  was missed; `risk.roll = false` opts out). `rollFutures`: event ROLL = the exit leg to the held contract + an entry leg
  for the same side and lots marked `_after: expiry` (queueDhan resolves it in the contract after); the closed part is
  booked ("Rolled to the next month before the … expiry"), the position keeps its stops, entry price = the price now,
  `pos_expiry` = the new contract's expiry (`heldFutExpiry` reads it, else the held sec / the near month on the entry
  day). A roll exit Dhan refuses goes the exit-retry way (the retry exits). Holidays before the expiry aren't known, so a
  holiday can make the roll a day later at worst. Tests: `tests/sim/safety.test.mjs` "roll".
- **Reads over 1,000 rows** (found 4 Nov 2026): the database answers at most 1,000 rows a request whatever `.limit()`
  asks. `pagedRows` (lab.ts) reads 1,000 at a time; used for the Ideas Lab's stage-2 rows and pending legs and the
  Strategy Lab's checks. Three Ideas Lab finalists (tries 134, 136, 466) had been judged "random-entry test didn't
  finish" because their random row was cut off (the tests had finished: p 0.27 and 0.30, failing; 466's full shuffled
  runs give p 0.08, failing too). Also fixed: a random-entry leg waits until every real leg of its try is done (136's had
  run first, real 0 → "100%"); 136 re-queued. Fake database
  `LIMITS.maxRows` mimics the cap; test `tests/sim/pagedrows.test.mjs`.
- **Shared paper data (TEMPORARY, 5 Nov 2026, Papa; see pending item 0)**: `SHARED_PAPER_DATA = true` (accounts.ts). A user
  with no Dhan token reads market data through the admin's Dhan login (`dataAccount`: the user's own capital / limit
  kept, webhook fields empty, `shared_data` set); their price requests are grouped under the admin (`dataUid`) so they
  batch with his. Used only by the minute tick (`runOne`, the tick's price seed) and the per-second prices; a live
  strategy on shared data is refused ("Connect your own Dhan account … to trade this strategy live"); orders, reconcile,
  broker stops, funds and fills still read the user's own account. Test: `tests/sim/safety.test.mjs` "shared data".
- **Dhan Data API plan watch** (6 Nov 2026, Papa, after the plan showed "Deactive" at 09:00 and every price request was
  refused with DH-902 until it was renewed ~10:05; migration 75): the hourly token check (`tokenCheck` → `dataPlanCheck`)
  reads Dhan's /v2/profile (`dataPlan`, `dataValidity`) per connected account into `broker_accounts.data_plan` /
  `data_valid_until`, and notifies the owner (kind "error", link `/?conn=1`, pushed to the phone) 7, 5, 3 and 1 day(s)
  before the plan ends (`DATA_WARN_DAYS`, `dataWarnDue`; a missed day warns at the step reached) and at once when Dhan
  reports it inactive; `data_warned` = "<validity>|<days>" or "off" stops repeats. Test: `tests/sim/dataplan.test.mjs`.
- **Admin › User activity** (6 Nov 2026, Papa; migration 78): tab `#ad_activity` (`loadActivity`, SQL `admin_activity()`, admins
  only): per user — active time in the last 24 h (5-minute presence marks: the app calls `touch_presence()` at most every
  5 min while on screen, `touchPresence`, table `user_presence`, counted from 6 Nov 2026; Supabase's auth audit log is empty),
  last seen / last sign-in, capital (Capital page), Live and Paper cells (active strategies, open, margin in use, booked P&L via
  `ledger_net_user`, running P&L = sum of `pos_upnl`), closed trades in 24 h, Dhan connected, error-breaker stop. 7 columns,
  wrapping cells; a summary line. **In use and pages** (same day, migration 79): the app counts per page seconds on screen,
  seconds in use (a scroll, wheel, tap, pointer move or key in the last 30 s) and visits (`pgAct`, `pgFlush` about once a
  minute and when hidden → `log_activity`, table `user_page_time` per 5-minute bucket, capped); the Active cell shows open /
  in use / visits (`engaged_min`, `visits_24h`); "Pages ▸" opens a row per page (`aaPages` → `admin_user_pages(p_user,
  p_hours)`: visits, on screen, in use, last visit; 24 h / 7 days; labels `PAGE_LABEL`). Test: `tests/ui/ui_activity.mjs`
  (args: theme width).
- **Desk · system feeds** (6 Nov 2026, Papa chose pulse bars and these 6 feeds; migration 80): at the top of the Activity panel
  (`#dk_feeds`, `.dk-pulse`), one small equalizer each for Dhan NSE/BSE prices, Dhan MCX prices, Delta prices, the stop
  watcher, the order manager and the broker match. From `desk_feeds()` every 5 s (ages repainted each second,
  `deskFeedsLoad` / `deskFeedsPaint` / `feedState`): green and bouncing while the feed is within its own rhythm — prices and
  stops 20 s, order manager 150 s, broker match 420 s (Papa: a 5-minute check stays green until the next is due) — amber
  up to 2.5× that, then red and blinking (bars move unevenly: every 450 ms new heights from the feed's current pattern — random, wave, climb, burst — switched every 3–8 s; 42 px tall, bright green (Papa: taller, brighter, slower), `dkPulseTick`; amber slower and lower); grey when it has nothing to do (market shut, no open position; the loop runs only
  then). Hover: when it last worked, and "no live orders / strategy" when the job runs with nothing to do. Tested in
  `tests/ui/ui_desk.mjs`.
- **Desk quotes on phones** (6 Nov 2026, Papa): folded to one row by default; "All ▾" / "Less ▴" (`#dk_qtog`, `dkQFold`,
  localStorage `dkQOpen`); big screens unchanged. Tested in `tests/ui/ui_desk.mjs`.
- **Show password** (6 Nov 2026, Papa, after a client's phone sign-in failed twice with "wrong email or password" while the
  same password worked on another device): an eye button inside the sign-in password and the two new-password fields
  (`input[data-eye]` → `.pwbox` / `.eye`; hidden again on submit); never on the broker key fields. Test:
  `tests/ui/ui_login_eye.mjs` (args: theme width).
- **Android app** (6 Nov 2026, Papa; `android/`): AnkGenie 1.0, package `com.ankgenie.app`, Android 5.0+, a full-screen
  WebView of https://supertrend-desk.vercel.app/ (live site, so portal changes need no new app; other sites open in the
  browser; back button goes back; links to the site open in the app). Built by `android/build.sh` without the Android SDK
  (dl.google.com is blocked from cloud sessions): Ubuntu's aapt / dalvik-exchange / zipalign / apksigner + android.jar
  API 33 from GitHub. Not a Trusted Web Activity (its Google libraries can't be downloaded here), so **phone
  notifications don't work inside the app** (WebView has no web push); Chrome's "Install app" still gets them. The
  signing key isn't in the repo; a rebuild with a new key means uninstalling the old app first.
- **Options on stocks and MCX** (6 Nov 2026, Papa: points 3 and 4; `listedopts.ts`): stock options (NSE OPTSTK, all 33 stocks)
  and options on MCX futures (OPTFUT: CRUDEOIL, CRUDEOILM, NATURALGAS, NATGASMINI, GOLD, GOLDM, SILVER, SILVERM, COPPER, ZINC —
  web `MCX_OPT`; aluminium, lead, nickel, silver micro have none). Contracts come from Dhan's lists, not the option chain:
  `syncFno` keeps OPTSTK and `syncMcx` OPTFUT (into fno_contracts, seg MCX_COMM) for the two nearest expiries (`nearestTwo`);
  `sizeEntry` → `pickListed`: next listed expiry (after today with roll_on_expiry), the listed strike nearest the price
  moved by `strike_offset` in listed strikes (`_strike` → `entryLeg`); `premiumOf` → `findListed` + that contract's LTP;
  `resolveLeg` sends to the exact OPTSTK / OPTFUT contract (MCX quantity in lots). Single options only (structures refused on
  stocks / MCX). Stock option backtests: Dhan rolling options with instrument OPTSTK; MCX options can't be backtested (Dhan
  has no expired MCX options) — the backtest says so. Form: Options enabled for those assets, `#listedOptHint`, structures
  disabled; picking a stock / MCX asset still defaults to futures. Tests: `tests/sim/stocks.test.mjs`, `tests/sim/safety.test.mjs`
  "stock option entry", `tests/ui/ui_stocks.mjs`. Paper first; nothing live before the supervised test.
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

## Audit 6 Nov 2026 (five reviews: website code, engine, database, GUI screenshots, strategy rules; reports were in the
## session scratchpad — findings and what was built are recorded here)
- **Engine order path (built, engine v144, commit 48ce11d; tests `tests/sim/safety2.test.mjs`)**: `must()` wraps every
  write on the money path (position after a signal / stop / roll / retry, order state, fills, ledger rows, stop records):
  three tries, then it throws → `last_error`, the breaker, an alert; a stop whose record couldn't be saved is cancelled
  again (`stoprec-` alert) so two stops never rest. `finishNow` re-reads the position under `actLocked` before booking and
  sends nothing if it changed meanwhile (INFO "Skipped: the position changed"). **Partial exits**: `failRow` reads Dhan's
  fill of a rejected / cancelled exit — the filled part is marked filled, only the rest goes again at market (a new
  `live_orders` row, same batch), `fixLedger` prices the exit on all its fills; if the rest fails too, `bookPart` books the
  closed part as a real trade and the position shrinks to what Dhan still holds (`pos_qty`, `pos_lots`, `pos_margin`,
  `pos_broker.legs`), then `exitFailed` retries as before. Delta: a partly filled exit shrinks the position the same way,
  and a stop that can't be cancelled before an exit stops the exit (`stopcancel-` alert), like Dhan since 4 Nov.
  `claimSignal` takes over a PENDING claim older than 2 minutes (a worker killed between claim and send no longer blocks
  the candle — a square-off reuses the same candle every minute). Split day: `SPAN_CACHE` / `DAILY_CACHE` cleared for the
  stock when `stock_actions` gets today's row; a failed ex-date check skips that second's stop check (alert `exdate-`).
  `checkStop` books under `actLocked`; the four `waitUntil` chains catch. Breaker: an account counts as failing only when
  none of its active strategies has `last_error` null (one bad strategy among quiet ones no longer stops the account).
  The tick and the price loop read strategies with `pagedRows`. The tick closes a lab run `running` with a lease expired
  over an hour (`failed`, "engine watchdog"). `live_marks` written only when the price moved or every 15 s (Realtime
  decoding was 18% of database time); `algo_chart` on a new bar or every 5 min; the per-second loop caches accounts and
  the admin account for a minute. Self-check: one strategy per call; the kill rule runs after it as action `kill`
  (3 strategies per call, chained). `selfCall(body)` = the engine calling itself.
- **Database (migration 81)**: one cron job `engine-minute` → `engine_minute()` runs the minute work in one session
  (tick in NSE/MCX hours, tick_crypto, orders, push, spreads while the watch lasts, backtest kick, desk_snapshot; every
  5 min reconcile and pred_feed) — the seven jobs that used to start together at :00 (1, 6, 13, 16, 18, 19, 28, 35, 36)
  are switched off with `cron.alter_job(active := false)`, not dropped. `live-prices` (job 24) only Mon–Fri 08:55–23:59
  IST or while a position is open. Job 7 (`deploy-fee-renewals`, retired billing) off. Policies calling `is_owner()` /
  `auth.uid()` wrapped in `(select …)`. Indexes `lab_results_robust_status_idx`, `algo_backtests_waiting_idx`,
  `lab_results_promoted_idx`. `trg_strategy_notify` sends one error notification per cause per account per hour (was
  per strategy). `portal_settings` (dead table) token and secret blanked.
- **Morning card (migration 82, engine v145)**: SQL `morning_card(p_user)` (open positions with entry / now / stop and the
  stop's distance in %, today's booked P&L, expiries today, active live / paper, kill-rule count, Dhan token hours left,
  data plan days left, breaker, admins' lab passes of the last 24 h) feeds both the engine action `morning` — one note
  per user with active strategies at 08:30 IST from `engine_minute()`, kind "morning", tag `morning-<user>-<day>`, link
  `/?home=1` — and the Home card the website reads. `client_statement(p_user, p_month)`: a month's trades by mode /
  strategy / asset, live net to month end and its high-water mark, Shukrana accepted in the month, the rate, the Shukrana
  summary (the monthly statement's figures). `lab_scores(ids)`: lab consistency scores for a client's own strategies
  (the `lab_results_list` view is security-invoker, so clients couldn't read ranks). Test: `tests/sim/morning.test.mjs`.
- **Self-check corrected (engine v146, `audit.ts`)**: the daily "N strategies with gaps" was mostly an artefact — three
  SILVERM strategies exited by hand and paused on 29 Oct 14:26 were replayed as if still running (13 "missed" trades a
  day). Now: a paused strategy is judged only up to the moment it stopped (`cutPaused`: last run or last trade's exit;
  note "Paused since …"), an exit made by hand (`MANUAL_EXIT`: Manual exit / Exit positions now) is a "Note:" not a gap,
  and desk entries made while the backtest still held the hand-closed trade are notes too; "Note:" issues don't count
  toward the verdict. Test: `tests/sim/audit.test.mjs`. Real divergences remaining today are small ("Desk did worse"
  by 0.3–1% on exits).
- **Trade story and slippage (migration 85)**: `trade_story(p_trade)` — one closed trade's entry and exit signals (what
  fired, when, the decision delay), the broker orders of each leg, fill prices beside the desk's own (slippage in points
  and rupees; positive = worse for the trader); `slippage_summary(p_user)` — per strategy, live fills' slippage against
  the signal prices (legs, average, worst, rupee total). Both for the owner or an admin; the website shows them as the
  Trades tab's "Story ▸" and a Slippage card (closes the open item "slippage column + per-strategy slippage summary").
- **Strategy rule families (6–7 Nov 2026, engine v147; `tests/sim/{data_oi,piv,fib,gap,squeeze,gen_cover,cal,vix,div,stockmom,wf,method}.test.mjs`)**:
  volume stored for every asset (`toCol(rows, true)`; old files v → 0) and open interest fetched (`oi: true`, `Raw/DayBar.oi`;
  real OI only for MCX in the lab — index / stock signals run on spot) → indicator `OI` (oi_rising / oi_falling /
  oi_up_price_up / oi_up_price_down). New indicators in rules.ts: `PIV` (classic / Camarilla / CPR from the previous day
  or week: above/below/cross pp, r1, s1; cpr_narrow / cpr_wide = CPR width vs k × 20-period median), `FIB` (zigzag swings
  by k × ATR or n-bar fractals, `indicators.ts swings`, no look-ahead: pullback_to_382/50/618 within tol × ATR with a
  confirmation candle, rally_* mirrors, in_zone_bull/bear, broke_down/up_786; every condition may carry a `level`;
  `RuleSet.fill = "LEVEL"` makes the backtester fill at the level intrabar on the next candle (`simulateRules`), entries
  only; `tgt.type = "FIB"` targets = extensions of the last swing (`riskInit(..., swing)`; live: `_swing` travels with
  the new state into `armRisk`)), `GAP` (open vs previous close in daily-ATR units: gap_up_gt / gap_dn_gt / gap_filled /
  gap_held), `RANGE` (nr_n, inside_bar on the previous candle; range_gt_atr / range_lt_atr), `KC` Keltner (above_upper /
  below_lower / squeeze = Bollinger inside Keltner / squeeze_release), `BB` bandwidth_pctile_lt / _gt, `CAL`
  (is / not_expiry_day, days_to_expiry_lt, turn_of_month, event_day ± n from table `market_events` — migration 83,
  admins read; `loadMarketEvents` once a day → `logic.ts setMarketEvents`), `VIX` (India VIX, Dhan IDX_I 21, a
  non-tradable data asset `DATA_ASSETS`, kept out of `LAB_ASSETS`: vix_gt / lt / rising / pctile_gt / lt; the lab's data
  phase refreshes its candles; user backtests download it when rules use it; live: `rulesExt` in index.ts fetches daily
  + 5-minute VIX when `rulesUse(rules, "VIX")`), `DIV` (RSI / MACD bull / bear divergence over the last two swings).
  Honest note in code: pivots and Fibonacci are mostly folklore — built so the lab can test them fairly. Generator
  (lab.ts `TplRow` tables): DON, PIV, KC, GAP, FIB (half with LEVEL fills), DIV, RANGE, VOL, TIME, CAL (indices + stocks),
  VIX (indices) added; MCX gets intraday strategies 30% of the time; mirrors / nearby settings know the new params.
  Ideas Lab: `stockmom` (order 18) — cross-sectional momentum on the 33 stock futures, 3/6/12-month skipping the last
  month, top 3/5, with / without bottom-k short, 0.5% risk per position. Lab method: `labWalkForward` (lab.ts; table
  `lab_walkforward`, migration 84; engine action `lab_walkforward`, nightly 03:30 IST from `engine_minute`, migration 86)
  re-ranks each asset/mode group quarter by quarter on the trades before the quarter, picks the top k and records only
  the next quarter → the stitched out-of-sample curve (caveat in code: a survivor pool); `consistencyScore(..., plateau)`
  adds a soft 0–10 plateau part when ≥ 3 nearby-setting results exist (other weights scaled to 90); `regimeStats`
  (VIX tercile / ADX > 25 vs < 20 / above vs below SMA200) stored as `metrics.regimes` by `screenOne`. `pagedRows` at
  every capped lab / ideas read; the whole-table `lab_tried` paging replaced by `triedOf()` fingerprint lookups.
  Combinations notify once per run (`comboDigest`) instead of once per asset / timeframe. Left out on purpose:
  stock-futures OI, per-commodity MCX expiry calendars for CAL, a live resting limit order for LEVEL fills, VIX for crypto.
- **Website (6–7 Nov 2026; UI suite 35 tests × dark 1440 / light 1440 / dark 390, all pass; new tests `tests/ui/ui_group,
  ui_orders, ui_live_tab, ui_conn, ui_golive, ui_strat_ux, ui_rules, ui_home, ui_story.mjs`, shared mock `tests/ui/_mock.mjs`)**:
  - **Strategies grouped by asset** (Papa, 6 Nov: "which strategy is live, and is the best one live?"): "Group by asset"
    tick (default on, localStorage `lpGroup`) + Fold all / Unfold all; a group = underlying · timeframe · futures-or-options
    (`grpKey`), header row `tr.lpg` (cards `div.lpgd`) with the counts (N strategies · L live · P paper · archived), the
    group's Running and Booked P&L (live via `[data-grun]`), and a tag — green "best is live" / amber "best isn't live"
    (title names the best with its score and each live one's rank); ranks = the lab's consistency score via
    `rpc("lab_scores")` (chunked by 100, cached ≤ 10 min) as a chip "★ 1 of 7" / "3 of 7" / "lab –"; default order inside a
    group = rank. Lab rows / cards carry "On desk · Live / Paper / Paused" (`labDeskMark`) opening the strategy. Note from
    the walk-forward (7 Nov): the lab's ranking describes the past; in 12 of 13 asset groups the top-3-by-consistency picks
    earned less next quarter than the average passed strategy — a basket beats "the best one".
  - **One store, one vocabulary**: `loadPnl` reads `algo_trades` once per refresh (`TRADE_COLS`) into `allTrades` /
    `myTrades`; `tradesOf()` feeds Trades, Live, Desk, Capital, the strategy's Trades tab and Compare (4 readers and 2
    pagers gone); `lab_margins` read once (`loadMargins`); one `stats(rows)` (same-moment steps) replaces `tradeTotals` /
    `tradeStats` (`cmpStats` builds on it), `pct()`, whole-percent win rates; `rupees()` guards NaN, `equityOf(st, mode)`;
    `fmtDate` ("06 Nov, 15:49" IST) / `fmtDay`; `istParts(ms)` is the only place with the 5:30 offset (`istMs` parses IST
    text); `rupeesSigned`, `fmtNum`, the Unicode minus; `lang="en-IN"` on date inputs. Labels, verbatim everywhere:
    **Running P&L**, **Booked P&L**, **Capital**, **Margin in use**, **Limit** (Desk chart "Capital deployed vs profit" and
    backtest / marketplace "Net profit" kept). `rupeesShort` stays on the Desk stats and the dense admin research tables.
  - **Cleanup**: `renderList` no longer calls `renderLive`; `refreshAll` owns the Orders poll; 150 ms debounce on the
    search box; the hidden strategy rail, dead totals, `marketOpen` / `robCells` / `lit` / `needsUpgrade`, the duplicate
    resize listener and dead CSS are gone; the two stacked CSS themes collapsed (82 overridden first-theme declarations
    removed, screenshots pixel-identical); shared `tile()`, `cls()`, `chips(s, which)`, `plural()`; `paintMarks` indexes
    once per paint and flashes via rAF; `document.hidden` guards on the 6 remaining timers.
  - **UX**: backtest tab fits a phone; the Compare tray is full only on Strategies / strategy / Lab, a 36 px pill
    elsewhere, none on Admin / Health / Connections / Wallet / sign-in / phones (badge on the Compare tab); Live tab hides
    empty columns (≤ 8, "Show every column"); strategy header shows only tiles with values, the Position tile "Long 2 lots ·
    +₹4,250" with in / now / SL / T and a **stop-distance meter** (`stopMeterHTML`, also on Simple rows, cards and the Home
    card, live-updated), chart expert fields under "Chart settings"; the form has a sticky save bar ("Unsaved changes" /
    Discard), lot size read-only from the preset with "override", stop / target / trailing boxes hidden while Off; Orders
    show `brokerText` ("Dhan accepted" / "Dhan rejected: insufficient margin (DH-905)", raw behind ▸); Trades tab: open
    positions above the closed list, "Filters (N) ▸", the daily Dhan check moved here; Wallet: Shukrana as one sentence +
    one number; Marketplace "Edit listing ▸"; one-line footer disclaimer (none on terms / sign-in); Capital in tabs
    (Capital & limit · Lots wizard · Closed trades) with the suggestion reworded; **go-live dialog** with a summary table
    (asset · lots · ≈ margin · stop · expiry / roll, charges note, same-asset warning) and a typed LIVE for the account's
    first go-live (`firstLive`); new client: a 4-step checklist card on the empty Strategies page + "Where do these come
    from?" link on Connections. Not done: hiding Desk / Compare / Capital for a brand-new client (needs the navigation
    decision, question 3).
  - **Home card** (`loadMorning` / `renderMorning` ← `morning_card`, top of Strategies, `?home=1`): open positions with
    stop meters, Booked P&L today, live / paper counts, expiries today, token / data-plan / breaker / kill / lab-pass lines
    only when relevant. **Trade story** "Story ▸" (← `trade_story`) on both trade lists, a **Slippage** card
    (← `slippage_summary`, live only); **Monthly statement** on the Wallet (← `client_statement`: month picker, printable
    card with print CSS, client-side CSV). The rule builder knows OI, PIV, FIB, GAP, RANGE, KC, CAL, VIX, DIV (choice
    drop-downs src / kind / mode / monthly, an "Entry fill" CLOSE / LEVEL select on the Buy / Sell sets, FIB on the target
    type); Lab settings has a market-event days editor (admins). Lab-page cards for regimes / plateau / walk-forward: later.
- **No stop-loss warning on going live** (Papa, 7 Nov 2026, chose option B over a forced "disaster" stop): the go-live
  dialog (single and bulk) lists strategies with neither a stop-loss nor a trailing stop (`hasPriceStop`, `noStopHTML`)
  — they exit only on their rules at a closed candle (once a day for daily ones), nothing caps a move in between and no
  stop order rests at the broker — and Go live stays disabled until "I understand: go live without a stop-loss" is
  ticked (`#cf_nostop`, with the typed LIVE when both apply; `wireLiveType`). Test: `tests/ui/ui_golive.mjs`. Same day the
  morning card's "without a stop" count was fixed to count trailing stops (`eff_stop`, migration 87): 6 of 18 paper
  positions had no price stop, not 10.
- **Still open from the audit**: regimes / plateau / walk-forward cards on the Lab page; `regimeStats` in user backtests.
- **Open questions put to Papa 6 Nov 2026 (no answer within a minute → pending, ask again)**: (1) switch the four lab
  jobs (3, 10, 26, 29) back on now that the dispatcher is in and the tick closes stuck runs; (2) revoke the blanket ALL
  grants from anon / authenticated and grant back what the app uses; (3) rebuild the navigation as 5 client entries
  (Home · Strategies · Marketplace · Money · Settings) + Research and Admin for admins; (4) the DROP / archival batch —
  superseded lab results' trade payloads to storage files (~250 MB), 7 dead tables (`strategies`, `signals`,
  `settings`, `strategy_chart`, `lab_robust_bak_1013`, `owner_invite`, `portal_settings`), 15 dead functions, merging
  the 13 duplicate permissive policy pairs; (5) a mandatory luck test before anything goes live; (6) a hold-to-flatten
  kill switch on the home screen; (7) **signal lag** (22–32 s on Dhan assets in market hours, 3–7 s on crypto at night):
  every distinct asset / timeframe is one Dhan candle request paced 210 ms apart on the one shared token, and the
  per-second quote loop shares that token — the two ways out are Dhan's WebSocket feed (Papa: not now) or building the
  minute candles from the desk's own per-second prices (`price_bars`, as `owncandles.ts` does when Dhan refuses) at the
  cost of candles that differ slightly from Dhan's; Papa to choose. Also still open: Lab run 966 was stuck "running" since 07:53 IST — the engine watchdog
  closes it an hour after its lease; the lab jobs stay off until Papa says.

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
Decided 4 Nov 2026: (9) a second live strategy on the same asset only **warns** when going live — built; (10/12) lots
follow the typical day's move **at each new entry**, changes under ±20% ignored — built; (1) positional futures **roll
the day before expiry** — built. Next, the GitHub items: a one-time
backtester cross-check with vectorbt (free) — **done 4 Nov 2026** (`tests/xcheck/`: on Binance daily SOL / BTC 2021–2026
the desk's MACD and EMA-cross trades match vectorbt 203/203 and 49/49, its 3×ATR trailing stop matches an independent
re-implementation 203/203; charges, slippage, intraday, options and other indicators not covered); 10–20 well-known
strategy ideas through the Ideas Lab (free) — **added 4 Nov 2026**: 9 ideas × 4 settings (`wellKnownIdeas` in ideas.ts,
orders 9–17, source research): intraday index VWAP trend, Supertrend + VWAP, previous day's high / low breakout, liquidity
sweep of yesterday's high / low, EMA 9/21 + RSI, Heikin Ashi trend (5 / 15-minute, out by 15:15); daily ADX/DI trend,
Bollinger breakout, 52-week high (all markets). The classic daily ones were already in the generator (220 ideas, 929
settings, 0 passed). Settings that carry rules may carry `intraday` and `tf`. Test: `tests/sim/wellknown.test.mjs`. Tick-level
prices from Dhan's WebSocket feed: plan shown 4 Nov (Dhandha server ₹0 extra, or a separate one ~₹350–600/month,
watch-only for a week first) — Papa: "not now", keep pending.
Done 4 Nov 2026 (migration 74): `notify_test` limited to once a minute per user; the 10 backtests stuck "running" marked
failed ("stopped: never finished"); Anshul's two paper strategies paused, his error stop cleared, he was notified to
connect Dhan; cloud-session start-up hook (`.claude/settings.json`, `.claude/hooks/session-start.sh`). Kept as is:
clients may go live by themselves (Papa: keep `set_live` as it is); the Strategy Lab generator stays on.
Still open:
0. **SUPER URGENT · SUPER IMPORTANT — roll back the shared paper data before any public / larger roll-out** (Papa,
   5 Nov 2026). Turned on for close family users only: a user without a Dhan login paper trades on the admin's Dhan
   prices (`SHARED_PAPER_DATA` in accounts.ts, `dataAccount` / `dataUid`). Risks: exchange data redistribution
   (NSE vendor licence, Dhan API terms are for the account holder), one shared request budget, one token failing
   stops everyone's paper. Roll back = set `SHARED_PAPER_DATA = false` and redeploy; then every user connects their own
   Dhan account even for paper (free, no funds needed). Remind Papa whenever new users are added.
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

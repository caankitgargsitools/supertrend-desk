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
- No profit share is charged (billing code exists but is not used).
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

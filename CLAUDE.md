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
- Holidays: `market_holidays` table + `tradingSession` in logic.ts.
- Daily self-check (`desk_audit`): replays each strategy's last 30 days of trades with the backtest engine and flags
  missed/extra trades, different exits, or the desk > 0.25% worse on price. Shown on the Trades page.
- Totals (`ledger_net_user`, `ledger_net`, `admin_users`) exclude hidden trades.
- Lab strictness (rev 4, 23 Oct 2026): a **vault** (last 6 months; 3 for MCX minute strategies) is held back from
  generation, ranking and every check (`preVault`), and tested once at the end (check kind `vault`); a **luck
  adjustment** (Deflated Sharpe on the trades, `stats.ts`, tries = lab-wide rule families from `lab_trial_families()`,
  95% needed); ≥ 3 of 4 neighbouring settings profitable; profitable without its best 5% of trades; ≥ 30 trades
  (daily) / 100 (minute) over the years tested; doubled slippage for daily strategies too. Breeding from winners is off
  (`lab_settings.evolve`). `lab_reverdict` (re-scoring stored results) is retired: re-tests go through `lab_refresh`.
  First preview: none of the 24 desk lab strategies passes the luck test (best t = 3.4).
- Lab phase 2 (finalists only, i.e. strategies that passed everything above): 100 runs on shuffled candles
  (`noise.ts` `shuffledData`; check kind `noise`, tf 0 = real) and 1,000 sets of random entries (`random`); the real
  result must beat 95% of each. Overfitting gauge: Probability of Backtest Overfitting (CSCV, `stats.ts` `pbo`) per run,
  asset and mode from every fresh try's monthly results (`lab_months` → `lab_pbo`), shown on the Lab page.
  Near-identical winners are already grouped as twins (`lab_assign_twin`, 80%+ shared entries).
- Kill rule (phase 3, `kill.ts`, run daily with the self-check): a running lab strategy's own trades (per lot) against
  2,000 bootstrap sets of its backtest trades; under the worst 1% after 10 trades or the worst 5% after 20, `kill_at`
  is set, new trades stop (exits still run) and the owner is notified. "Allow new trades again" (`kill_allow`) clears it
  and it is judged on later trades only.

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
- Ideas from the Tradl.ai review (one-page backtest report, morning brief, featured shelves) — proposed.

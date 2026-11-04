# Backtester cross-check (one-time, 4 Nov 2026; Papa's pending item "GitHub review 10b")

Checks the desk's backtester (`simulateRules` in `supabase/functions/engine/backtest.ts`) against an independent
implementation on the same candles: vectorbt for the signal-driven trades, and a day-by-day re-implementation of the
desk's documented trailing-stop rule.

Result on Binance daily candles, Jan 2021 – Jun 2026 (trades entered from 1 Mar 2021, after the indicators warm up):

| Check | Desk | Independent | Match |
|---|---|---|---|
| SOL · MACD(8,21,5) above / below signal (Lab #104958) | 203 trades | 203 (vectorbt) | 203 / 203 same day, side, entry and exit price |
| BTC · EMA(13) above / below EMA(34) (Lab #299283's main rule) | 49 | 49 (vectorbt) | 49 / 49 |
| SOL · the MACD rule + trailing stop 3 × ATR(14) | 203 | 203 (re-implemented rule) | 203 / 203 |

vectorbt's own trailing stop trails by a percentage of the peak and uses the day's high before the low, so it gives
other trades (224); the desk trails by a fixed 3 × ATR distance and checks the stop before a day's new best (the
cautious reading of a daily candle). Not covered here: charges and slippage, intraday rules, options, other indicators
(Heikin Ashi, ADX, Donchian, BTC filter, HA strength), MCX / NSE session handling.

How to run it again: put daily candles as `[{t,o,h,l,c}, …]` in `SOL.json` and `BTC.json` in a folder (the 2026 run
fetched Binance's public `data-api.binance.vision` klines through the database's `net.http_get`, since this machine
can't reach Binance), then:

    node tests/xcheck/bundle.mjs <folder>/run/backtest.mjs        # bundles the desk's backtester
    cp tests/sim/fakesb.mjs <folder>/run/ && cp tests/xcheck/ours.mjs <folder>/run/
    node <folder>/run/ours.mjs <folder>/SOL.json '<rules json>' ['<risk json>'] > <folder>/run/sol_macd.json   # etc.
    pip install vectorbt && python3 -I tests/xcheck/vbt_check.py <folder>

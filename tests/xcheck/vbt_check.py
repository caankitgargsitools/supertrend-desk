# Independent cross-check of the desk's backtester with vectorbt (4 Nov 2026, Papa: pending item 10b).
# Same candles (Binance daily), same timing rule: decide at each day's open from the completed days, fill at that open.
# Indicators are computed here with pandas (independently of the desk's own code), trades simulated by vectorbt.
import json, sys
import numpy as np, pandas as pd, vectorbt as vbt

D = sys.argv[1]

def load(name):
    b = pd.DataFrame(json.load(open(f"{D}/{name}.json")))
    b.index = pd.to_datetime(b.t + 19800, unit="s").dt.strftime("%Y-%m-%d")
    return b

def ema_tv(x, n):  # TradingView-style EMA: seeded with the SMA of the first n values (the desk's documented method)
    out = np.full(len(x), np.nan); a = 2 / (n + 1); v = x.values
    out[n - 1] = v[:n].mean()
    for i in range(n, len(v)): out[i] = a * v[i] + (1 - a) * out[i - 1]
    return pd.Series(out, index=x.index)

def ema_line(x, n):
    s = pd.Series(x).dropna()
    e = ema_tv(s, n)
    return e.reindex(x.index)

def atr(b, n):  # Wilder ATR (RMA of true range)
    pc = b.c.shift(1)
    tr = pd.concat([b.h - b.l, (b.h - pc).abs(), (b.l - pc).abs()], axis=1).max(axis=1)
    tr.iloc[0] = b.h.iloc[0] - b.l.iloc[0]
    out = np.full(len(tr), np.nan); out[n - 1] = tr.iloc[:n].mean()
    for i in range(n, len(tr)): out[i] = (out[i - 1] * (n - 1) + tr.iloc[i]) / n
    return pd.Series(out, index=b.index)

def run(b, long_c, short_c, trail_atr=None):
    # yesterday's completed candle decides today's open
    L = long_c.shift(1).fillna(False).astype(bool); S = short_c.shift(1).fillna(False).astype(bool)
    kw = {}
    if trail_atr is not None:
        a = atr(b, 14).shift(1)  # ATR of the completed days at the entry
        kw = dict(sl_stop=(trail_atr * a / b.o).fillna(np.inf).values, sl_trail=True, high=b.h, low=b.l, stop_entry_price="price")
    pf = vbt.Portfolio.from_signals(b.c, entries=L & ~L.shift(1).fillna(False), short_entries=S & ~S.shift(1).fillna(False),
        price=b.o, open=b.o, upon_opposite_entry="reverse", fees=0, slippage=0, init_cash=1e12, size=1, size_type="amount", accumulate=False, **kw)
    t = pf.trades.records_readable
    return pd.DataFrame({"side": np.where(t["Direction"] == "Long", "LONG", "SHORT"), "in": t["Entry Timestamp"].values, "out": t["Exit Timestamp"].values,
                         "pin": t["Avg Entry Price"].values, "pout": t["Avg Exit Price"].values})

def compare(name, ours_file, mine, warm):
    ours = pd.DataFrame(json.load(open(ours_file)))
    o = ours[ours["in"] >= warm].reset_index(drop=True); m = mine[mine["in"] >= warm].reset_index(drop=True)
    pts = lambda d: ((d.pout - d.pin) * np.where(d.side == "LONG", 1, -1) / d.pin * 100)
    ko = set(zip(o["in"], o["side"])); km = set(zip(m["in"], m["side"]))
    both = ko & km
    print(f"\n== {name} (trades entered from {warm}) ==")
    print(f"  desk backtester: {len(o)} trades, sum of % moves {pts(o).sum():.1f}%")
    print(f"  vectorbt       : {len(m)} trades, sum of % moves {pts(m).sum():.1f}%")
    print(f"  same entry day and side: {len(both)}; only desk: {len(ko - km)}; only vectorbt: {len(km - ko)}")
    j = o.merge(m, on=["in", "side"], suffixes=("_d", "_v"))
    if len(j):
        print(f"  of the matched: same exit day {int((j.out_d == j.out_v).sum())}/{len(j)}, entry price equal {int((abs(j.pin_d - j.pin_v) < 1e-6).sum())}/{len(j)}, exit price within 0.1% {int((abs(j.pout_d / j.pout_v - 1) < 0.001).sum())}/{len(j)}")
        bad = j[(j.out_d != j.out_v) | (abs(j.pout_d / j.pout_v - 1) >= 0.001)]
        for _, r in bad.head(6).iterrows(): print(f"    differs: {r['side']} in {r['in']}: desk out {r.out_d} @ {r.pout_d:.4g}, vectorbt out {r.out_v} @ {r.pout_v:.4g}")
    for k in sorted(ko - km)[:4]: print("    only desk:", k)
    for k in sorted(km - ko)[:4]: print("    only vectorbt:", k)

sol = load("SOL"); btc = load("BTC")
m = ema_line(sol.c, 8) - ema_line(sol.c, 21); sg = ema_line(m, 5)
compare("SOL daily · MACD(8,21,5) above / below signal (Lab #104958)", f"{D}/run/sol_macd.json", run(sol, m > sg, m < sg), "2021-03-01")
f, s = ema_line(btc.c, 13), ema_line(btc.c, 34)
compare("BTC daily · EMA(13) above / below EMA(34) (Lab #299283's main rule)", f"{D}/run/btc_ema.json", run(btc, f > s, f < s), "2021-03-01")
compare("SOL daily · MACD(8,21,5) + trailing stop 3 × ATR(14)", f"{D}/run/sol_macd_trail.json", run(sol, m > sg, m < sg, trail_atr=3), "2021-03-01")

# ---- The trailing stop as the desk documents it, written again here day by day (not with the desk's code): fixed
# distance 3 × ATR(14) of the completed days at the entry, from the best price since entry; each day the stop is checked
# before that day's own high / low can raise the best (cautious); a day opening through the stop fills at the open.
def run_trail(b, long_c, short_c, k=3.0):
    L = long_c.shift(1).fillna(False).astype(bool).values; S = short_c.shift(1).fillna(False).astype(bool).values
    A = atr(b, 14).values; o, h, l, d = b.o.values, b.h.values, b.l.values, list(b.index)
    out, pos = [], None
    prevL = prevS = None
    for i in range(1, len(b)):
        if pos:  # yesterday's range after the entry (checked at today's open, as the desk does)
            j = i - 1; st = pos["best"] - pos["dir"] * k * pos["atr"]
            if (pos["dir"] == 1 and o[j] <= st and j > pos["j"]) or (pos["dir"] == -1 and o[j] >= st and j > pos["j"]):
                out.append({**pos["t"], "out": d[j], "pout": o[j]}); pos = None
            elif (pos["dir"] == 1 and l[j] <= st) or (pos["dir"] == -1 and h[j] >= st):
                out.append({**pos["t"], "out": d[j], "pout": st}); pos = None
            else: pos["best"] = max(pos["best"], h[j]) if pos["dir"] == 1 else min(pos["best"], l[j])
        long_now, short_now = L[i] and not S[i], S[i] and not L[i]
        side = pos["t"]["side"] if pos else "FLAT"
        if side == "LONG" and short_now: out.append({**pos["t"], "out": d[i], "pout": o[i]}); pos = None; side = "FLAT"; enter = "SHORT"
        elif side == "SHORT" and long_now: out.append({**pos["t"], "out": d[i], "pout": o[i]}); pos = None; side = "FLAT"; enter = "LONG"
        elif side == "FLAT" and long_now and not prevL: enter = "LONG"
        elif side == "FLAT" and short_now and not prevS: enter = "SHORT"
        else: enter = None
        if enter and not pos and not np.isnan(A[i - 1]):
            pos = {"dir": 1 if enter == "LONG" else -1, "best": o[i], "atr": A[i - 1], "j": i, "t": {"side": enter, "in": d[i], "pin": o[i]}}
        prevL, prevS = long_now, short_now
    if pos: out.append({**pos["t"], "out": d[-1], "pout": b.c.values[-1]})
    return pd.DataFrame(out)

compare("SOL daily · MACD(8,21,5) + trailing stop 3 × ATR(14), desk rule re-implemented", f"{D}/run/sol_macd_trail.json", run_trail(sol, m > sg, m < sg), "2021-03-01")

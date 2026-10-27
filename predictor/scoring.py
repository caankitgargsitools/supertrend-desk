"""Scoring a forecast against what happened, and the simple guesses it must beat.

For each step h ahead (1 … H), from the last close the model saw:
  direction – Kronos's predicted close vs the last close, against the real move (flat moves left out);
              baseline: the last candle's move continues.
  close     – |predicted − real close| in % of the last close; baseline: the price stays the same.
  range     – highest high − lowest low over the h candles, error in %; baseline: the average such swing over the
              recent candles (an ATR-like guess).
Paired differences (baseline error − Kronos error) are summed with their squares, so the page can say how sure the
difference is (a t-value; forecasts that overlap in time make it look surer than it is, which the page says)."""
from __future__ import annotations

import math


def swing_baseline(h: list[float], l: list[float], steps: int, window: int = 50) -> float | None:
    """Average of (max high − min low) over `steps` consecutive candles, across the last `window` such stretches."""
    n = len(h)
    if n < steps + 5:
        return None
    vals = []
    for end in range(n, max(steps, n - window), -1):
        vals.append(max(h[end - steps:end]) - min(l[end - steps:end]))
    return sum(vals) / len(vals) if vals else None


def score(last: float, prev: float, pred: list[list[float]], act_h: list[float], act_l: list[float], act_c: list[float], base_r: dict[int, float | None]):
    """Rows per step h for which the real candle exists. pred: [[o,h,l,c], ...]; act_*: real candles after the origin."""
    rows = []
    if not (last > 0):
        return rows
    for k in range(min(len(pred), len(act_c))):
        h = k + 1
        pc, ac = pred[k][3], act_c[k]
        move = ac - last
        r = {"h": h, "dir_n": 0, "hit": 0, "hit_mom": 0}
        if move != 0:
            r["dir_n"] = 1
            r["hit"] = int(pc != last and (pc - last > 0) == (move > 0))
            r["hit_mom"] = int(last != prev and (last - prev > 0) == (move > 0))
        r["ae_k"] = abs(pc - ac) / last * 100
        r["ae_flat"] = abs(last - ac) / last * 100
        ph = max(max(p) for p in pred[:h])
        pl = min(min(p) for p in pred[:h])
        ar = max(act_h[:h]) - min(act_l[:h])
        r["re_k"] = abs((ph - pl) - ar) / last * 100
        b = base_r.get(h)
        r["re_atr"] = abs(b - ar) / last * 100 if b is not None else r["re_k"]
        rows.append(r)
    return rows


def t_value(d_sum: float, d_sq: float, n: int) -> float | None:
    """Mean paired difference ÷ its standard error."""
    if n < 3:
        return None
    mean = d_sum / n
    var = max(0.0, (d_sq - n * mean * mean) / (n - 1))
    se = math.sqrt(var / n)
    return mean / se if se > 0 else None

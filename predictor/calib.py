"""The correction layer (27 Oct 2026, Papa's step 2): a small logistic model that learns, per timeframe and step ahead,
how far to trust Kronos's direction call, from Kronos's own forecast and a few plain facts about the moment.

Inputs: Kronos's predicted move ÷ the usual swing, how many of its paths agree, the last 1, 5 and 20 candles' moves,
the time of day, and whether the asset is an index, MCX or crypto. Output: the chance the price ends higher.

Walk-forward only: each month's corrected calls come from a model trained on forecasts whose outcome was known before
that month began, so it is never tested on what it learned from. All assets of a timeframe are pooled (more data)."""
from __future__ import annotations

import json
import math

import numpy as np

from series import day_start

MIN_TRAIN = 300   # forecasts with a real move needed before a month gets corrected calls
L2 = 1.0          # gentle shrinkage: with few clear patterns the model stays close to "no idea" (50%)


def features(pred_c: float, last: float, up: float | None, feats: dict, h: int) -> list[float]:
    sw = feats.get("sw") or 0
    move = (pred_c - last) / (sw * math.sqrt(h)) if sw > 0 else 0.0
    tod = feats.get("tod") or 0.0
    clip = lambda x: max(-5.0, min(5.0, float(x or 0)))
    return [1.0, clip(move), (up - 0.5) * 2 if up is not None else 0.0, clip(feats.get("mom1")), clip(feats.get("mom5")), clip(feats.get("mom20")),
            math.sin(2 * math.pi * tod), math.cos(2 * math.pi * tod), float(feats.get("kind") == "crypto"), float(feats.get("kind") == "mcx")]


def fit(X: np.ndarray, y: np.ndarray, l2: float = L2, iters: int = 25) -> np.ndarray:
    """Logistic regression by Newton's method with an L2 penalty (not on the intercept)."""
    w = np.zeros(X.shape[1])
    pen = np.full(X.shape[1], l2); pen[0] = 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(X @ w, -30, 30)))
        g = X.T @ (p - y) + pen * w
        H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(pen + 1e-9)
        step = np.linalg.solve(H, g)
        w -= step
        if np.max(np.abs(step)) < 1e-6:
            break
    return w


def month_start(m: str) -> int:
    return day_start(m + "-01")


def walk_forward(db, tf: int, horizon: int) -> set:
    """Fills scores.p_cal for every month of timeframe tf that has enough earlier data. Returns the assets touched."""
    rows = db.execute("""select s.asset, s.t, s.h, s.month, s.up_act, f.last, f.pred, f.up, f.feats from scores s
                         join forecasts f on f.asset = s.asset and f.tf = s.tf and f.t = s.t
                         where s.tf = ? and s.dir_n = 1 and f.feats is not null""", (tf,)).fetchall()
    touched = set()
    for h in range(1, horizon + 1):
        data = []
        for asset, t, hh, month, up_act, last, pred, up, feats in rows:
            if hh != h:
                continue
            pc = json.loads(pred)[h - 1][3]
            u = json.loads(up)[h - 1] if up else None
            data.append((asset, t, month, up_act, features(pc, last, u, json.loads(feats), h)))
        if not data:
            continue
        data.sort(key=lambda r: r[1])
        known_after = lambda t: t + (h + 1) * (tf * 60 if tf < 1440 else 2 * 86400)  # when the outcome was known
        updates = []
        for m in sorted({r[2] for r in data}):
            ms = month_start(m)
            train = [r for r in data if known_after(r[1]) < ms]
            if len(train) < MIN_TRAIN:
                continue
            X = np.array([r[4] for r in train]); y = np.array([r[3] for r in train], dtype=float)
            w = fit(X, y)
            for r in data:
                if r[2] == m:
                    p = float(1 / (1 + math.exp(-max(-30, min(30, float(np.dot(w, r[4])))))))
                    updates.append((round(p, 4), r[0], tf, r[1], h))
                    touched.add(r[0])
        db.executemany("update scores set p_cal=? where asset=? and tf=? and t=? and h=?", updates)
    return touched

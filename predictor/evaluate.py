"""Original Kronos-mini against our fine-tuned one, on the same unseen candles (from 1 Sept 2025, after the training
cutoff), scored exactly like the Prediction Lab (scoring.py). Run by GitHub Actions after finetune.py, one asset group
per job (indices, MCX, crypto) so the jobs run side by side.

For each asset and timeframe: up to N candles evenly spread over the unseen months; each model forecasts the next 10
candles from the same 256 candles before it, with the same random seed. Totals per step ahead (1, 3, 5, 10):
direction right (each model, and "last move continues"), closing-price error (each model and "price stays the same"),
range error (each model and the average swing), and the paired difference fine-tuned vs original with its t-value.
"""
from __future__ import annotations

import argparse
import json
import os
import time

from scoring import score
from series import day_start

STEPS = (1, 3, 5, 10)


def origins(s, start: int, end: int, n: int, min_bars: int) -> list[int]:
    idx = [i for i in range(min_bars - 1, len(s) - 10) if start <= s.t[i] < end]
    if len(idx) <= n:
        return idx
    step = len(idx) / n
    return [idx[int(k * step)] for k in range(n)]


def compare(worker, base, tuned, tfs, start: str, n: int, log=print, kinds=None) -> list[dict]:
    """Per asset and timeframe: totals for both models over the same candles."""
    out = []
    t0, t1 = day_start(start), int(worker.clock())
    for a in sorted(worker.assets.values(), key=lambda x: x.key):
        if kinds and a.kind not in kinds:
            continue
        for tf in tfs:
            s = a.series.get(tf)
            if not s:
                continue
            idx = origins(s, t0, t1 - (tf * 60 if tf < 1440 else 86400) * 11, n, worker.settings.get("lookback", 256))
            jobs = [j for j in (worker.job(a, tf, i) for i in idx) if j]
            if len(jobs) < 10:
                continue
            row = {"asset": a.key, "tf": tf, "n": len(jobs), "steps": {}}
            preds = {}
            for name, m in (("base", base), ("ft", tuned)):
                res = []
                for k in range(0, len(jobs), 16):
                    part = jobs[k:k + 16]
                    res += m.forecast([{**j, "t": j["t_in"]} for j in part], 10)
                preds[name] = res
            for h in STEPS:
                acc = {k: 0.0 for k in ("dir_n", "hit_base", "hit_ft", "hit_mom", "ae_flat", "ae_base", "ae_ft", "re_atr", "re_base", "re_ft", "d", "d2", "rd", "rd2", "n")}
                for j, pb, pf in zip(jobs, preds["base"], preds["ft"]):
                    i = j["i"]
                    if i + h >= len(s):
                        continue
                    act = (s.h[i + 1:i + 1 + h], s.l[i + 1:i + 1 + h], s.c[i + 1:i + 1 + h])
                    rb = score(j["last"], j["prev"], pb[:h], *act, j["base_r"])[-1]
                    rf = score(j["last"], j["prev"], pf[:h], *act, j["base_r"])[-1]
                    acc["n"] += 1
                    acc["dir_n"] += rb["dir_n"]; acc["hit_base"] += rb["hit"]; acc["hit_ft"] += rf["hit"]; acc["hit_mom"] += rb["hit_mom"]
                    acc["ae_flat"] += rb["ae_flat"]; acc["ae_base"] += rb["ae_k"]; acc["ae_ft"] += rf["ae_k"]
                    acc["re_atr"] += rb["re_atr"]; acc["re_base"] += rb["re_k"]; acc["re_ft"] += rf["re_k"]
                    d, rd = rb["ae_k"] - rf["ae_k"], rb["re_k"] - rf["re_k"]  # > 0: fine-tuned closer
                    acc["d"] += d; acc["d2"] += d * d; acc["rd"] += rd; acc["rd2"] += rd * rd
                row["steps"][str(h)] = {k: round(v, 6) for k, v in acc.items()}
            out.append(row)
            log(f"{a.key} {tf}: {len(jobs)} candles compared")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--start", default="2025-09-01")
    ap.add_argument("--per-pair", type=int, default=60)
    ap.add_argument("--kinds", default="", help="nse,mcx,crypto (empty = all)")
    ap.add_argument("--out", default="out/eval.json")
    a = ap.parse_args()
    from runner import KronosRunner
    from store import Store
    from worker import Engine, Worker, http_json
    import tempfile
    tmp = tempfile.mkdtemp()
    w = Worker(Engine(os.environ["SUPABASE_URL"], os.environ["PRED_KEY"]), None, Store(os.path.join(tmp, "e.sqlite")), get=http_json)
    w.say = lambda *_: None
    w.alive = lambda *_: None
    w.refresh()
    w.settings.setdefault("lookback", 256)
    threads = os.cpu_count() or 4
    base = KronosRunner("mini", threads=threads, samples=1)
    tuned = KronosRunner("mini", threads=threads, samples=1, weights=a.weights)
    t0 = time.time()
    kinds = set(a.kinds.split(",")) if a.kinds else None
    rows = compare(w, base, tuned, list(w.settings.get("tfs") or [5, 15, 30, 60, 240, 1440]), a.start, a.per_pair, kinds=kinds)
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w") as f:
        json.dump({"start": a.start, "per_pair": a.per_pair, "kinds": a.kinds or "all", "minutes": round((time.time() - t0) / 60, 1), "rows": rows}, f)
    print(f"compared {len(rows)} asset-timeframe pairs in {round((time.time() - t0) / 60)} min")


if __name__ == "__main__":
    main()

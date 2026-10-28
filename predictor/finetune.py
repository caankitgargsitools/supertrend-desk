"""Fine-tuning Kronos-mini on our own markets (Papa, 28 Oct 2026), run by GitHub Actions (kronos-finetune.yml).

What it learns from: every lab asset's candles on 5m, 15m, 30m, 1h, 4h and daily, built exactly as the forecaster
builds them, but only candles that ended BEFORE the cutoff (1 Sept 2025, where the replay starts). The replay months
stay unseen, so the comparison in evaluate.py is honest. The last 90 days before the cutoff are kept apart to judge
the training as it goes (the best checkpoint by that check is kept).

How: the Kronos project's own recipe (finetune/train_predictor.py): the tokenizer stays as it is, the predictor learns
to give the next candle's tokens, AdamW with a one-cycle learning rate, gradients clipped. Each training sample is one
asset and timeframe picked at random, and a random window of 256 candles plus the 10 that followed (as the forecaster
uses them), normalised on the 256 only.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import tempfile
import time

import numpy as np

from series import IST, day_start

CUTOFF = "2025-09-01"
VAL_DAYS = 90
LOOKBACK = 256
HORIZON = 10
CLIP = 5.0
TFS = [5, 15, 30, 60, 240, 1440]


def stamps(ts) -> np.ndarray:
    """Kronos's time features (minute, hour, weekday, day, month) from IST times."""
    import datetime as dt
    out = np.zeros((len(ts), 5), dtype=np.float32)
    for k, t in enumerate(ts):
        d = dt.datetime.fromtimestamp(int(t), IST)
        out[k] = (d.minute, d.hour, d.weekday(), d.day, d.month)
    return out


class Windows:
    """Training and checking windows from every asset's series, cut at the cutoff."""

    def __init__(self, assets: dict, tfs=TFS, cutoff: str = CUTOFF, val_days: int = VAL_DAYS, lookback=LOOKBACK, horizon=HORIZON, seed=7):
        self.lookback, self.horizon = lookback, horizon
        cut = day_start(cutoff)
        val_from = cut - val_days * 86400
        self.train, self.val = [], []  # (array OHLCV [n,6], times [n], last index usable)
        for a in assets.values():
            for tf in tfs:
                s = a.series.get(tf)
                if not s or len(s) < lookback + horizon + 1:
                    continue
                t = np.asarray(s.t, dtype=np.int64)
                o, h, l, c, v = (np.asarray(x, dtype=np.float64) for x in (s.o, s.h, s.l, s.c, s.v))
                x = np.stack([o, h, l, c, v, v * (o + h + l + c) / 4], axis=1)
                step = tf * 60 if tf < 1440 else 86400
                end = t + step * (horizon + 1)  # the window's last candle (with the 10 ahead) must have ended
                tr = [i for i in range(lookback - 1, len(t) - horizon) if end[i] <= val_from]
                va = [i for i in range(lookback - 1, len(t) - horizon) if t[i] >= val_from and end[i] <= cut]
                key = f"{a.key}|{tf}"
                if tr:
                    self.train.append((key, x, t, tr))
                if va:
                    self.val.append((key, x, t, va))
        self.rng = random.Random(seed)

    def sample(self, pool, n, rng=None):
        rng = rng or self.rng
        # pairs weighted by the square root of their windows: long 5-minute series count more, but not overwhelmingly
        w = [math.sqrt(len(p[3])) for p in pool]
        xs, ss = [], []
        for _ in range(n):
            key, x, t, idx = rng.choices(pool, weights=w)[0]
            i = rng.choice(idx)
            lo = i + 1 - self.lookback
            win = x[lo:i + 1 + self.horizon].astype(np.float32)
            past = win[:self.lookback]
            mean, std = past.mean(axis=0), past.std(axis=0)
            win = np.clip((win - mean) / (std + 1e-5), -CLIP, CLIP)
            xs.append(win)
            ss.append(stamps(t[lo:i + 1 + self.horizon]))
        return np.stack(xs), np.stack(ss)


def load_assets(engine, get, history_from: str, cutoff: str = CUTOFF, tfs=TFS):
    """All assets' series, as the forecaster builds them, from history_from on (a throwaway worker does the loading)."""
    from store import Store
    from worker import Worker
    tmp = tempfile.mkdtemp()
    w = Worker(engine, None, Store(os.path.join(tmp, "load.sqlite")), get=get, clock=lambda: day_start(cutoff) + 120 * 86400)
    w.history_from = day_start(history_from)
    w.say = lambda *_: None  # no heartbeats from the training run
    w.alive = lambda *_: None
    w.refresh()
    return w.assets


def train(runner, windows: Windows, minutes: float, batch: int = 16, lr: float = 4e-5, val_batches: int = 30, every: int = 200, log=print):
    """Fine-tunes runner's predictor in place; returns the best state (by the checking windows) and a summary."""
    import torch
    model, tok = runner.p.model, runner.p.tokenizer
    tok.eval()
    for p in tok.parameters():
        p.requires_grad_(False)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, betas=(0.9, 0.95), weight_decay=0.1)
    vrng = random.Random(123)
    val = [windows.sample(windows.val, batch, vrng) for _ in range(val_batches)] if windows.val else []

    def step_loss(x, s):
        x, s = torch.from_numpy(x), torch.from_numpy(s)
        with torch.no_grad():
            t0, t1 = tok.encode(x, half=True)
        logits = model(t0[:, :-1], t1[:, :-1], s[:, :-1, :])
        loss, _, _ = model.head.compute_loss(logits[0], logits[1], t0[:, 1:], t1[:, 1:])
        return loss

    def check():
        if not val:
            return float("nan")
        model.eval()
        with torch.no_grad():
            v = [step_loss(x, s).item() for x, s in val]
        model.train()
        return float(np.mean(v))

    start = time.time()
    base_val = check()
    best, best_state, history, steps, bad = base_val, {k: v.detach().clone() for k, v in model.state_dict().items()}, [], 0, 0
    log(f"checking loss before training: {base_val:.4f}")
    model.train()
    while time.time() - start < minutes * 60:
        # learning rate: warm up over the first 200 steps, then cosine down over the time budget
        frac = (time.time() - start) / (minutes * 60)
        for g in opt.param_groups:
            g["lr"] = lr * min(1.0, (steps + 1) / 200) * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, frac))))
        x, s = windows.sample(windows.train, batch)
        loss = step_loss(x, s)
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=3.0)
        opt.step()
        steps += 1
        if steps % every == 0:
            v = check()
            history.append({"step": steps, "train": round(loss.item(), 4), "check": round(v, 4), "min": round((time.time() - start) / 60, 1)})
            log(f"step {steps}: train {loss.item():.4f}, check {v:.4f}")
            if v < best - 1e-4:
                best, bad = v, 0
                best_state = {k: t.detach().clone() for k, t in model.state_dict().items()}
            else:
                bad += 1
                if bad >= 6:  # no better for 6 checks in a row: stop, keep the best
                    log("no improvement for 6 checks: stopping")
                    break
    model.load_state_dict(best_state)
    model.eval()
    return best_state, {"steps": steps, "minutes": round((time.time() - start) / 60, 1), "check_before": round(base_val, 4), "check_best": round(best, 4),
                        "history": history, "train_pairs": len(windows.train), "val_pairs": len(windows.val),
                        "train_windows": sum(len(p[3]) for p in windows.train), "val_windows": sum(len(p[3]) for p in windows.val)}


def save(state: dict, path: str, meta: dict):
    from safetensors.torch import save_file
    save_file({k: v.contiguous() for k, v in state.items()}, path, metadata={"meta": json.dumps(meta)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, default=200)
    ap.add_argument("--history-from", default="2021-01-01")
    ap.add_argument("--cutoff", default=CUTOFF)
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    from runner import KronosRunner
    from worker import Engine, http_json
    os.makedirs(a.out, exist_ok=True)
    t0 = time.time()
    assets = load_assets(Engine(os.environ["SUPABASE_URL"], os.environ["PRED_KEY"]), http_json, a.history_from, a.cutoff)
    print(f"loaded {len(assets)} assets in {round(time.time() - t0)} s")
    win = Windows(assets, cutoff=a.cutoff)
    print(f"{len(win.train)} asset-timeframe pairs to learn from, {len(win.val)} to check on")
    runner = KronosRunner("mini", threads=os.cpu_count() or 4, samples=1)
    state, summary = train(runner, win, a.minutes)
    meta = {"base": "NeoQuasar/Kronos-mini", "cutoff": a.cutoff, "history_from": a.history_from, "lookback": LOOKBACK, "horizon": HORIZON,
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **{k: v for k, v in summary.items() if k != "history"}}
    save(state, os.path.join(a.out, "kronos-mini-ft.safetensors"), meta)
    with open(os.path.join(a.out, "train.json"), "w") as f:
        json.dump({**meta, "history": summary["history"]}, f)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()

"""Prediction Lab worker (runs on Papa's AWS server in Docker).

Every minute: reads settings, live 5-minute candles and holidays from the engine (pred_pull; the candle history
once a day), takes crypto candles from Binance's public data, makes a Kronos forecast for every finished candle of every
asset and timeframe (live first), fills the replay of past months in the spare time, scores forecasts as the real
candles come in, and every few minutes sends the monthly totals and the latest forecasts back (pred_push) with a
heartbeat. Only public market data comes here; the server key opens only pred_pull and pred_push.
"""
from __future__ import annotations

import gzip
import math
import json
import os
import time
import traceback
import urllib.request
from array import array
from bisect import bisect_left
from dataclasses import dataclass, field

from scoring import score, swing_baseline
from series import Bars, build, daily_from, day_start, future_times, ist_day, merge, session
from store import Store

VERSION = "1.0"
MIN_BARS = 64
CALIB_EVERY = 3 * 3600  # seconds between refits of the correction layer
PRETTY = {5: "5 min", 15: "15 min", 30: "30 min", 60: "1 hour", 240: "4 hours", 1440: "daily"}
DEFAULT_SAMPLES = {"60": 5, "240": 5, "1440": 5}  # paths per forecast by timeframe (the rest: 1); the server is small
TRIM_DAYS = 6    # raw 5-minute bars kept after building (a tail rebuild needs the last 3 days)
KEEP_DAYS = 200  # 5-minute history kept before the replay start (memory: the server has 2 GB, shared)
REPLAY_STRIDE = {5: 10, 15: 10, 30: 10, 60: 10, 240: 1, 1440: 1}  # replay origins at least n candles apart
REPLAY_FIRST = 100  # pass 1 of the replay: about this many forecasts per asset and timeframe (a verdict needs 100)
BATCH = int(os.environ.get("PRED_BATCH", "16"))
BINANCE = "https://data-api.binance.vision/api/v3/klines"


def http_json(url: str, body: dict | None = None, headers: dict | None = None, timeout: int = 60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return json.loads(raw)


class Engine:
    def __init__(self, url: str, key: str):
        self.url = url.rstrip("/") + "/functions/v1/engine"
        self.key = key

    def pull(self, files: bool):
        return http_json(self.url, {"action": "pred_pull", "files": files}, {"x-pred-key": self.key}, timeout=120)

    def push(self, body: dict):
        return http_json(self.url, {"action": "pred_push", **body}, {"x-pred-key": self.key}, timeout=120)

    def file(self, url: str):
        return http_json(url, timeout=120)


def binance(pair: str, start: int, end: int, get=http_json) -> dict:
    """5-minute Binance spot candles [start, end] (epoch seconds) as columns."""
    out = {"t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
    a = start * 1000
    while a <= end * 1000:
        j = get(f"{BINANCE}?symbol={pair}&interval=5m&startTime={a}&endTime={end * 1000}&limit=1000")
        if not j:
            break
        for k in j:
            out["t"].append(int(k[0]) // 1000); out["o"].append(float(k[1])); out["h"].append(float(k[2]))
            out["l"].append(float(k[3])); out["c"].append(float(k[4])); out["v"].append(float(k[5]))
        if len(j) < 1000:
            break
        a = int(j[-1][0]) + 300000
    return out


@dataclass
class Asset:
    key: str
    kind: str  # nse | mcx | crypto
    binance: str | None = None
    base: dict = field(default_factory=dict)       # 5-minute bars t -> (o,h,l,c,v)
    daily_file: dict | None = None
    series: dict = field(default_factory=dict)     # tf -> Bars
    index: dict = field(default_factory=dict)      # tf -> {t: i}
    last5: int = 0                                 # newest 5-minute bar built into the series

    def rebuild(self, tfs, holidays, now, tail_days: int | None = None):
        """Builds every timeframe; with tail_days only the last days are rebuilt and joined to what was there.
        Afterwards the raw 5-minute bars are trimmed to the last few days (enough for the next tail rebuild) and the
        candles kept as compact arrays: the server's memory is small and shared."""
        cut = None
        if tail_days is not None and self.series and self.base:
            cut = day_start(ist_day(max(self.base))) - tail_days * 86400
        src = self.base if cut is None else {t: v for t, v in self.base.items() if t >= cut}
        for tf in tfs:
            if tf >= 1440:
                files = self.daily_file
                if cut is not None and files and files.get("t"):
                    k0 = next((k for k, t in enumerate(files["t"]) if int(t) >= cut), len(files["t"]))
                    files = {c: v[k0:] for c, v in files.items() if isinstance(v, list)}
                b = daily_from(src, self.kind, holidays, now, files)
            else:
                b = build(src, tf, self.kind, holidays, now)
            old = self.series.get(tf)
            if cut is not None and old is not None:
                n = bisect_left(old.t, cut)
                b = Bars(list(old.t[:n]) + b.t, list(old.o[:n]) + b.o, list(old.h[:n]) + b.h, list(old.l[:n]) + b.l, list(old.c[:n]) + b.c, list(old.v[:n]) + b.v)
            b = Bars(array("q", b.t), array("d", b.o), array("d", b.h), array("d", b.l), array("d", b.c), array("d", b.v))
            self.series[tf] = b
            self.index[tf] = {t: i for i, t in enumerate(b.t)}
        self.last5 = max(self.base) if self.base else 0
        if self.base:
            lo = day_start(ist_day(self.last5)) - (TRIM_DAYS - 1) * 86400
            self.base = {t: v for t, v in self.base.items() if t >= lo}


def candle_end(a: Asset, tf: int, t: int, holidays) -> int:
    day = ist_day(t)
    o, c = session(a.kind, day, holidays)
    return day_start(day) + c * 60 if tf >= 1440 else min(t + tf * 60, day_start(day) + c * 60)


class Worker:
    def __init__(self, engine, runner, store: Store, get=http_json, clock=time.time):
        self.engine, self.runner, self.store, self.get, self.clock = engine, runner, store, get, clock
        self.assets: dict[str, Asset] = {}
        self.settings: dict = {}
        self.holidays: dict = {}
        self.files_day = ""
        self.dirty: set = set()
        self.latest_dirty: set = set()
        self.last_push = 0.0
        self.started = clock()
        self.error = None
        self.replay_ptr = store.get("replay_ptr", 0)
        self.phase = None  # what it is doing before the first full round (shown on the page)

    def alive(self, phase: str):
        """A heartbeat at least once a minute during long work (the first round can take several minutes)."""
        if self.clock() - getattr(self, "_beat", 0) >= 60:
            self._beat = self.clock()
            keep = self.phase
            self.say(phase)
            self.phase = keep

    def say(self, phase: str | None):
        """Reports a starting step straight away, so the page never waits in silence."""
        self.phase = phase
        print(time.strftime("%H:%M:%S"), phase or "running", flush=True)
        try:
            self.engine.push({"worker": self.heartbeat(list(self.settings.get("tfs") or []))})
        except Exception as e:
            print("report failed:", e, flush=True)

    # ---------- data ----------
    def refresh(self):
        now = int(self.clock())
        today = ist_day(now)
        files = self.files_day != today
        p = self.engine.pull(files)
        self.settings = p.get("settings") or {}
        self.holidays = {(h["exch"], str(h["day"])[:10]): (int(h["opens_at"][:2]) * 60 + int(h["opens_at"][3:5]) if h.get("opens_at") else None) for h in p.get("holidays", [])}
        tfs = list(self.settings.get("tfs") or [5, 15, 30, 60, 240, 1440])
        replay_from = day_start(str(self.settings.get("replay_from") or "2025-09-01"))
        live = {b["asset"]: b for b in p.get("bars", [])}
        first = not self.assets
        listed = p.get("assets", [])
        for n, a in enumerate(listed):
            if first:
                self.alive(f"starting: loading price history ({n} of {len(listed)} assets)")
            kind = "crypto" if a.get("crypto") else "mcx" if a.get("commodity") else "nse"
            x = self.assets.get(a["key"]) or Asset(a["key"], kind, a.get("binance"))
            self.assets[a["key"]] = x
            changed = False
            if files and kind != "crypto":
                links = (p.get("files") or {}).get(a["key"]) or []
                parts = []
                for f in sorted(links, key=lambda f: (f["kind"] != "D", f["kind"])):
                    try:
                        cols = self.engine.file(f["url"])
                    except Exception as e:  # a missing file leaves that part out
                        self.error = f"{a['key']} {f['kind']}: {e}"
                        continue
                    if f["kind"] == "D":
                        x.daily_file = cols
                    elif f["kind"] == "I5" or f["kind"].startswith("I5Y:"):
                        parts.append(cols)
                parts.sort(key=lambda c: c["t"][0] if c.get("t") else 0)
                x.base = {**merge(*parts), **{t: v for t, v in x.base.items() if t > max((c["t"][-1] for c in parts if c.get("t")), default=0)}}
                # Only what the replay needs (warm-up for 256 four-hour candles); daily candles come from the daily file.
                keep_from = replay_from - KEEP_DAYS * 86400
                x.base = {t: v for t, v in x.base.items() if t >= keep_from}
                changed = True
            if kind == "crypto" and x.binance:
                start = max(x.base) + 300 if x.base else replay_from - KEEP_DAYS * 86400
                if start < now - 600:
                    x.base.update(merge(binance(x.binance, start, now - 300, self.get)))
                    changed = True
            elif a["key"] in live:
                before = len(x.base)
                x.base.update(merge(live[a["key"]]["bars"]))
                changed = changed or len(x.base) != before
            if changed or not x.series:
                # Full rebuild when the day's history files came in (indices, MCX) or the first time; else the last days.
                x.rebuild(tfs, self.holidays, now, None if ((files and kind != "crypto") or not x.series) else 3)
        if files:
            self.files_day = today
        return tfs

    # ---------- forecasting ----------
    def job(self, a: Asset, tf: int, i: int) -> dict | None:
        s = a.series[tf]
        L = int(self.settings.get("lookback") or 256)
        if i + 1 < MIN_BARS:
            return None
        lo = max(0, i + 1 - L)
        H = int(self.settings.get("horizon") or 10)
        base_r = {h: swing_baseline(s.h[lo:i + 1], s.l[lo:i + 1], h) for h in range(1, H + 1)}
        sw = base_r.get(1) or 0
        mom = lambda n: (s.c[i] - s.c[i - n]) / sw / math.sqrt(n) if sw > 0 and i >= n else 0.0
        tod = 0 if tf >= 1440 else (s.t[i] + 19800) % 86400 / 86400
        feats = {"mom1": round(mom(1), 4), "mom5": round(mom(5), 4), "mom20": round(mom(20), 4), "tod": round(tod, 4), "kind": a.kind, "sw": sw}
        return {"asset": a.key, "tf": tf, "t": s.t[i], "i": i, "key": f"{a.key}|{tf}|{s.t[i]}", "feats": feats,
                "o": s.o[lo:i + 1], "h": s.h[lo:i + 1], "l": s.l[lo:i + 1], "c": s.c[lo:i + 1], "v": s.v[lo:i + 1], "t_in": s.t[lo:i + 1],
                "future": future_times(s.t[i], tf, H, a.kind, self.holidays), "last": s.c[i], "prev": s.c[i - 1], "base_r": base_r}

    def samples(self, tf: int) -> int:
        """Paths drawn per forecast (settings.samples per timeframe; 5 on 1h, 4h and daily by default)."""
        sm = self.settings.get("samples") or DEFAULT_SAMPLES
        return max(1, min(10, int(sm.get(str(tf), 1))))

    def run_jobs(self, jobs: list[dict], mode: str):
        """Forecasts in batches. With several paths per forecast each job is repeated in the batch (every row draws its
        own path); the stored forecast is the average path, plus per step the share of paths ending above the last close."""
        H = int(self.settings.get("horizon") or 10)
        by_len: dict[tuple, list[dict]] = {}
        for j in jobs:
            by_len.setdefault((len(j["c"]), self.samples(j["tf"])), []).append(j)
        done, total = 0, len(jobs)
        for (_, K), group in by_len.items():
            step = max(1, BATCH // K)
            for k in range(0, len(group), step):
                part = group[k:k + step]
                rows = [{**j, "t": j["t_in"], "key": f"{j['key']}|{r}"} for j in part for r in range(K)]
                paths = self.runner.forecast(rows, H)
                for n, j in enumerate(part):
                    mine = paths[n * K:(n + 1) * K]
                    pred = [[sum(p[h][c] for p in mine) / K for c in range(4)] for h in range(H)]
                    up = [round(sum(1 for p in mine if p[h][3] > j["last"]) / K, 3) for h in range(H)] if K > 1 else None
                    self.store.add(j["asset"], j["tf"], j["t"], mode, j["last"], j["prev"], j["base_r"], [[round(x, 6) for x in r] for r in pred], K, up, j.get("feats"))
                    self.dirty.add((j["asset"], j["tf"]))
                    if mode == "live":
                        self.latest_dirty.add((j["asset"], j["tf"]))
                self.store.commit()
                done += len(part)
                self.alive(f"forecasting: {done} of {total} {mode} forecasts in this round")

    def live_jobs(self, tfs) -> list[dict]:
        now = int(self.clock())
        out = []
        for a in self.assets.values():
            for tf in tfs:
                s = a.series.get(tf)
                if not s or not len(s):
                    continue
                i = len(s) - 1
                end = candle_end(a, tf, s.t[i], self.holidays)
                fresh = now - end <= (18 * 3600 if tf >= 1440 else max(tf * 60, 900))
                if fresh and not self.store.has(a.key, tf, s.t[i]):
                    j = self.job(a, tf, i)
                    if j:
                        out.append(j)
        return out

    def replay_plan(self, tfs):
        """The replay in passes (Papa, 27 Oct: results soon, then ever more data in the background). Pass 1 takes about
        REPLAY_FIRST evenly spread candles per asset and timeframe since the replay start; each later pass halves the
        spacing (twice as many), down to every REPLAY_STRIDE candles. Every pass keeps the candles of the passes before
        it, and the spacing and starting candle are fixed the first time, so chosen candles never move as new ones
        arrive. All assets finish a pass before any starts the next. Returns the work of the current pass."""
        start = day_start(str(self.settings.get("replay_from") or "2025-09-01"))
        now = int(self.clock())
        pairs = []
        for a in sorted(self.assets.values(), key=lambda x: x.key):
            for tf in tfs:
                s = a.series.get(tf)
                if not s or not len(s):
                    continue
                gk = f"grid|{a.key}|{tf}"
                grid = self.store.get(gk)
                if not grid:
                    i0 = max(MIN_BARS - 1, bisect_left(s.t, start))
                    if i0 >= len(s):
                        continue
                    base, n_in = REPLAY_STRIDE.get(tf, 10), len(s) - i0
                    top = base
                    while n_in // top > REPLAY_FIRST:
                        top *= 2
                    grid = {"t0": s.t[i0], "top": top, "base": base}
                    self.store.put(gk, grid)
                i0 = bisect_left(s.t, grid["t0"])
                last = len(s) - 1
                while last >= i0 and now - s.t[last] <= 86400 + tf * 60:  # newer candles belong to the live forecasts
                    last -= 1
                have = self.store.times(a.key, tf)
                levels, stride, k = [], grid["top"], 0
                while True:
                    idx = range(i0, last + 1, stride)
                    levels.append((k, stride, [i for i in idx if s.t[i] not in have], len(idx)))
                    if stride <= grid["base"]:
                        break
                    stride, k = max(grid["base"], stride // 2), k + 1
                pairs.append((a, tf, levels))
        cur = min((next((lv[0] for lv in levels if lv[2]), None) for _, _, levels in pairs), key=lambda x: 1e9 if x is None else x, default=None)
        passes = max((len(levels) for _, _, levels in pairs), default=0)
        if cur is None:
            return [], {"pass": passes, "passes": passes, "total": 0, "done": 0, "complete": True}
        plan, total, todo_n = [], 0, 0
        for a, tf, levels in pairs:
            lv = levels[min(cur, len(levels) - 1)]
            total += lv[3]
            if cur < len(levels) and lv[2]:
                plan.append((a, tf, list(lv[2])))
                todo_n += len(lv[2])
        return plan, {"pass": cur + 1, "passes": passes, "total": total, "done": total - todo_n, "complete": False}

    def replay_step(self, tfs, budget_s: float = 40):
        """Replay forecasts round-robin across assets and timeframes until the time budget is used."""
        t0 = self.clock()
        plan, state = self.replay_plan(tfs)
        self.replay_state = state
        if not plan:
            return 0
        done = state["done"]
        n = 0
        while self.clock() - t0 < budget_s and plan:
            a, tf, todo = plan[self.replay_ptr % len(plan)]
            self.replay_ptr += 1
            take, todo[:] = todo[:BATCH], todo[BATCH:]
            jobs = [j for j in (self.job(a, tf, i) for i in take) if j]
            if jobs:
                self.run_jobs(jobs, "replay")
                n += len(jobs)
            plan = [p for p in plan if p[2]]
        self.store.put("replay_ptr", self.replay_ptr)
        self.replay_state["done"] = done + n
        return n

    # ---------- scoring and reporting ----------
    def score_all(self, tfs):
        H = int(self.settings.get("horizon") or 10)
        for a in self.assets.values():
            for tf in tfs:
                s, ix = a.series.get(tf), a.index.get(tf)
                if not s:
                    continue
                for t, mode, last, prev, base_r, pred, scored, up in self.store.open_forecasts(a.key, tf, H):
                    i = ix.get(t)
                    if i is None:
                        continue
                    avail = min(H, len(s) - 1 - i)
                    if avail <= scored:
                        continue
                    rows = score(last, prev, json.loads(pred), s.h[i + 1:i + 1 + avail], s.l[i + 1:i + 1 + avail], s.c[i + 1:i + 1 + avail],
                                 {int(k): v for k, v in json.loads(base_r).items()}, json.loads(up) if up else None)
                    self.store.save_scores(a.key, tf, t, mode, rows, avail)
                    self.dirty.add((a.key, tf))
        self.store.commit()

    def latest(self, a: Asset, tf: int) -> dict | None:
        s, ix = a.series.get(tf), a.index.get(tf)
        rec = self.store.recent(a.key, tf, 1)
        if not s or not rec:
            return None
        t = rec[-1]["t"]
        i = ix.get(t)
        if i is None:
            return None
        row = self.store.db.execute("select pred from forecasts where asset=? and tf=? and t=?", (a.key, tf, t)).fetchone()
        pred = json.loads(row[0])
        fut = future_times(t, tf, len(pred), a.kind, self.holidays)
        lo = max(0, i - 59)
        actual = [{"t": s.t[k], "o": s.o[k], "h": s.h[k], "l": s.l[k], "c": s.c[k]} for k in range(lo, min(len(s), i + 1 + len(pred)))]
        recent = self.store.recent(a.key, tf, 20)
        for r in recent:
            k = ix.get(r["t"])
            r["a"] = [s.c[m] for m in range(k + 1, min(len(s), k + 1 + len(r["p"])))] if k is not None else []
        return {"asset": a.key, "tf": tf, "made_at": candle_end(a, tf, t, self.holidays), "last_close": s.c[i],
                "path": [{"t": fut[k], "o": p[0], "h": p[1], "l": p[2], "c": p[3]} for k, p in enumerate(pred)], "actual": actual, "recent": recent}

    def report(self, tfs, force=False):
        now = self.clock()
        if not force and now - self.last_push < 240:
            return
        lat = [x for x in (self.latest(self.assets[k], tf) for k, tf in self.latest_dirty if k in self.assets) if x]
        if not lat and not self.store.get("latest_sent"):
            # Before the first live forecast: show the newest replayed ones.
            lat = [x for x in (self.latest(a, tf) for a in self.assets.values() for tf in tfs) if x]
            if lat:
                self.store.put("latest_sent", True)
        stats = self.store.totals(self.dirty)
        self.engine.push({"worker": self.heartbeat(tfs), "latest": lat, "stats": stats})
        self.dirty.clear(); self.latest_dirty.clear()
        self.last_push = now
        self.store.commit()

    def heartbeat(self, tfs) -> dict:
        now = int(self.clock())
        lag = {}
        for tf in tfs:
            worst = 0
            for a in self.assets.values():
                s = a.series.get(tf)
                if not s or not len(s):
                    continue
                end = candle_end(a, tf, s.t[-1], self.holidays)
                if now - end < (18 * 3600 if tf >= 1440 else max(tf * 60, 900)) and not self.store.has(a.key, tf, s.t[-1]):
                    worst = max(worst, now - end)
            lag[str(tf)] = worst
        mem = None
        try:
            with open("/proc/self/status") as f:
                mem = next((int(l.split()[1]) // 1024 for l in f if l.startswith("VmRSS")), None)
            load = open("/proc/loadavg").read().split()[0]
        except OSError:
            load = None
        rs = {"total": 0, "done": 0, **(getattr(self, "replay_state", None) or {})}
        status = self.phase or ("live; the replay has covered every candle" if rs.get("complete") else f"live, and replaying past months (pass {rs.get('pass', 1)})")
        return {"version": VERSION, "status": status,
                "detail": {"replay": rs, "lag_s": lag, "mem_mb": mem, "load": load, "model": getattr(self.runner, "name", "?"),
                           "samples": self.settings.get("samples") or DEFAULT_SAMPLES, "assets": len(self.assets),
                           "forecasts_hour": self.store.count(since=now - 3600), "live_total": self.store.count("live"), "replay_total": self.store.count("replay"),
                           "started": int(self.started)},
                "error": self.error}

    def resample_old(self, tfs):
        """Forecasts made with fewer paths than their timeframe now uses are redone (once per setting), so every forecast
        of a timeframe is judged the same way."""
        for tf in tfs:
            K = self.samples(tf)
            mk = f"samples|{tf}"
            if K <= 1 or self.store.get(mk) == K:
                continue
            for a in self.assets.values():
                old = [r[0] for r in self.store.db.execute("select t from forecasts where asset=? and tf=? and coalesce(k, 1) < ?", (a.key, tf, K))]
                if old:
                    self.store.forget(a.key, tf, old)
                    self.dirty.add((a.key, tf))
            self.store.put(mk, K)
            self.store.commit()

    def calibrate(self, tfs, force=False):
        """The correction layer, refitted month by month (walk-forward) every few hours."""
        if not force and self.clock() - (self.store.get("calib_at") or 0) < CALIB_EVERY:
            return
        from calib import walk_forward
        H = int(self.settings.get("horizon") or 10)
        for tf in tfs:
            self.alive(f"refitting the correction layer ({PRETTY.get(tf, tf)})")
            for asset in walk_forward(self.store.db, tf, H):
                self.dirty.add((asset, tf))
        self.store.put("calib_at", self.clock())
        self.store.commit()

    def cycle(self):
        self.error = None
        tfs = self.refresh()
        self.resample_old(tfs)
        self.phase = None
        if not self.settings.get("enabled", True):
            self.report(tfs, force=True)
            return "off"
        live = self.live_jobs(tfs)
        if live:
            self.run_jobs(live, "live")
        self.score_all(tfs)
        self.replay_step(tfs)
        self.score_all(tfs)
        self.calibrate(tfs)
        self.report(tfs)
        return "ok"


def main():
    from runner import make_runner
    url, key = os.environ["SUPABASE_URL"], os.environ["PRED_KEY"]
    os.makedirs("/data", exist_ok=True)
    w = Worker(Engine(url, key), None, Store(os.environ.get("PRED_DB", "/data/predictions.sqlite")))
    while w.runner is None:
        w.say(f"starting: loading the Kronos-{os.environ.get('PRED_MODEL', 'mini')} model (first start downloads it)")
        try:
            w.runner = make_runner()
        except Exception as e:  # no model, no forecasts: say why and try again in 5 minutes
            w.error = f"model: {type(e).__name__}: {e}"
            traceback.print_exc()
            w.say("waiting: the model couldn't be loaded, trying again in 5 minutes")
            time.sleep(300)
    w.error = None
    while True:
        t0 = time.time()
        try:
            w.cycle()
        except Exception as e:
            w.error = f"{type(e).__name__}: {e}"
            traceback.print_exc()
            try:
                w.engine.push({"worker": w.heartbeat(list(w.settings.get("tfs") or []))})
            except Exception:
                pass
        time.sleep(max(5, 60 - (time.time() - t0)))


if __name__ == "__main__":
    main()

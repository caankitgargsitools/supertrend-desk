"""Prediction Lab worker tests: no network, no real database, a stand-in model (python -m pytest predictor/tests)."""
import json
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scoring import score, swing_baseline, t_value  # noqa: E402
from series import build, daily_from, day_start, future_times, ist_day, ist_min, merge, session  # noqa: E402
from store import Store  # noqa: E402
from worker import Worker  # noqa: E402


def nse_day(day, start_px, step=1.0):
    """One NSE session of 5-minute bars 09:15–15:25, price rising by `step` per bar."""
    t0 = day_start(day) + 555 * 60
    cols = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = start_px
    for k in range(75):
        cols["t"].append(t0 + k * 300); cols["o"].append(px); cols["h"].append(px + 2); cols["l"].append(px - 2); cols["c"].append(px + step)
        px += step
    return cols, px


def weekdays(start, n):
    import datetime as dt
    d, out = dt.date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def test_sessions_and_building():
    assert session("nse", "2026-10-26") == (555, 930)
    assert session("nse", "2026-10-25") == (1440, -1)  # Sunday
    assert session("mcx", "2026-07-01")[1] == 1410 and session("mcx", "2026-12-01")[1] == 1435
    assert session("nse", "2026-11-09", {("NSE", "2026-11-09"): None}) == (1440, -1)
    cols, _ = nse_day("2026-10-26", 100)
    base = merge(cols)
    b15 = build(base, 15, "nse")
    assert len(b15) == 25 and ist_min(b15.t[0]) == 555 and b15.o[0] == 100 and b15.c[0] == 103
    b240 = build(base, 240, "nse")
    assert [ist_min(t) for t in b240.t] == [555, 795]  # 09:15–13:15, then 13:15–15:30 (shorter)
    # the day's last 15-minute candle is finished only once its last bar is in
    part = merge({k: v[:-1] for k, v in cols.items()})
    assert len(build(part, 15, "nse")) == 24
    d = daily_from(base, "nse", now=day_start("2026-10-26") + 16 * 3600)
    assert len(d) == 1 and d.o[0] == 100 and d.c[0] == 175
    assert len(daily_from(base, "nse", now=day_start("2026-10-26") + 14 * 3600)) == 0  # still trading
    assert len(daily_from(part, "nse", now=day_start("2026-10-26") + 16 * 3600)) == 0  # the last bar hasn't arrived
    print("ok   sessions, timeframes from 5-minute bars, daily")


def test_future_times():
    t = day_start("2026-10-23") + (930 - 15) * 60  # Friday 15:15, a 15-minute candle
    f = future_times(t, 15, 3, "nse")
    assert [ist_day(x) for x in f] == ["2026-10-26"] * 3 and [ist_min(x) for x in f] == [555, 570, 585]
    f = future_times(day_start("2026-10-23"), 1440, 2, "nse", {("NSE", "2026-10-26"): None})
    assert [ist_day(x) for x in f] == ["2026-10-27", "2026-10-28"]  # weekend and a holiday skipped
    f = future_times(day_start("2026-10-26") + 1435 * 60, 5, 2, "crypto")
    assert [ist_min(x) for x in f] == [0, 5]
    print("ok   times of the candles to come (weekends, holidays, crypto midnight)")


def test_scoring():
    pred = [[100, 102, 99, 101], [101, 103, 100, 102]]
    rows = score(100, 99, pred, [101.5, 104], [99.5, 100], [101, 103], {1: 2.0, 2: 3.0})
    assert rows[0]["hit"] == 1 and rows[0]["hit_mom"] == 1 and rows[0]["ae_k"] == 0 and math.isclose(rows[0]["ae_flat"], 1.0)
    assert math.isclose(rows[1]["re_k"], abs((103 - 99) - (104 - 99.5)) / 100 * 100) and math.isclose(rows[1]["re_atr"], abs(3 - 4.5))
    assert score(100, 101, pred, [101], [99], [99], {1: 2.0})[0]["hit"] == 0  # predicted up, went down
    assert score(100, 99, pred, [101], [99], [100], {})[0]["dir_n"] == 0  # flat move left out of direction
    assert swing_baseline([2] * 30, [1] * 30, 3) == 1
    assert t_value(10, 20, 10) is not None and t_value(1, 1, 2) is None
    print("ok   scoring against the baselines")


class FakeEngine:
    def __init__(self, files, bars=None):
        self.files, self.bars, self.pushed, self.pulls = files, bars or [], [], 0

    def pull(self, files):
        self.pulls += 1
        return {"settings": {"enabled": True, "tfs": [15, 1440], "horizon": 3, "lookback": 64, "replay_from": "2026-06-01"},
                "assets": [{"key": "NIFTY", "seg": "IDX_I", "crypto": False, "commodity": False}, {"key": "BTCUSD", "seg": "DELTA", "crypto": True, "binance": "BTCUSDT"}],
                "bars": self.bars, "holidays": [], "files": {"NIFTY": [{"kind": "I5", "url": "i5"}, {"kind": "D", "url": "d"}]} if files else None}

    def file(self, url):
        return self.files[url]

    def push(self, body):
        self.pushed.append(json.loads(json.dumps(body)))
        return {}


class EchoModel:
    """Stand-in: predicts the last close plus the last move (a model with some skill on a steady trend)."""
    name, samples = "echo", 1

    def __init__(self):
        self.calls = 0

    def forecast(self, jobs, horizon):
        self.calls += 1
        out = []
        for j in jobs:
            assert len(j["future"]) == horizon and len(j["t"]) == len(j["c"])
            last, step = j["c"][-1], j["c"][-1] - j["c"][-2]
            out.append([[last + step * k, last + step * k + 1, last + step * k - 1, last + step * (k + 1)] for k in range(horizon)])
        return out


def test_worker_end_to_end():
    days = weekdays("2026-08-03", 60)
    i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 20000.0
    for d in days:
        cols, px = nse_day(d, px, 0.5)
        for k in i5:
            i5[k] += cols[k]
    daily = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 18000.0
    for d in weekdays("2025-11-03", 250):
        daily["t"].append(day_start(d)); daily["o"].append(px); daily["h"].append(px + 50); daily["l"].append(px - 50); daily["c"].append(px + 10); px += 10
    now = day_start(days[-1]) + 15 * 3600 + 32 * 60  # 15:32 IST on the last day, just after the close

    def fake_binance(url):
        # 5-minute BTC bars, steady rise; pages of 1000 like Binance
        a = int(url.split("startTime=")[1].split("&")[0]) // 1000
        e = int(url.split("endTime=")[1].split("&")[0]) // 1000
        out, t = [], a - a % 300
        while t <= e and len(out) < 1000:
            p = 60000 + (t - day_start("2026-01-01")) / 300 * 0.1
            out.append([t * 1000, p, p + 5, p - 5, p + 0.1, 1.0]); t += 300
        return out

    with tempfile.TemporaryDirectory() as tmp:
        eng = FakeEngine({"i5": i5, "d": daily})
        model = EchoModel()
        w = Worker(eng, model, Store(os.path.join(tmp, "p.sqlite")), get=fake_binance, clock=lambda: now)
        w.cycle()
        st = w.replay_state
        assert st["total"] > 0, st
        s15 = w.assets["NIFTY"].series[15]
        assert len(s15) == 60 * 25
        # live: the day's last 15-minute candle (15:15–15:30) is forecast live, and the daily candle once the day is over
        live = w.store.db.execute("select asset, tf, t from forecasts where mode='live'").fetchall()
        assert ("NIFTY", 15, s15.t[-1]) in live, live
        assert any(r[0] == "NIFTY" and r[1] == 1440 for r in live)
        # replay: every 10th 15-minute candle since the replay start, older than a day
        for _ in range(30):
            if w.replay_state["done"] >= w.replay_state["total"]:
                break
            w.replay_step([15, 1440], budget_s=1e9)
        w.score_all([15, 1440])
        w.report([15, 1440], force=True)
        body = eng.pushed[-1]
        assert body["worker"]["detail"]["replay"]["done"] == body["worker"]["detail"]["replay"]["total"]
        allstats = {(s["asset"], s["tf"], s["h"], s["month"], s["mode"]): s for b in eng.pushed for s in b.get("stats", [])}  # whole-month figures: the newest wins
        stats = [s for s in allstats.values() if s["asset"] == "NIFTY" and s["tf"] == 15 and s["h"] == 1 and s["mode"] == "replay"]
        assert stats and sum(s["n"] for s in stats) > 50
        n = sum(s["dir_n"] for s in stats); hit = sum(s["hit"] for s in stats)
        assert hit == n, "a steady rise: the stand-in gets every direction right"
        lat = [x for b in eng.pushed for x in b.get("latest", []) if x["asset"] == "NIFTY" and x["tf"] == 15]
        assert lat and len(lat[0]["path"]) == 3 and lat[0]["path"][0]["t"] > lat[0]["actual"][-1]["t"] - 1
        btc = w.assets["BTCUSD"].series[15]
        assert len(btc) > 1000 and ist_min(btc.t[0]) % 15 == 0
        # a second cycle with nothing new adds no live forecasts
        before = w.store.count("live")
        w.cycle()
        assert w.store.count("live") == before
    print("ok   worker: live and replay forecasts, scoring, totals, latest forecast, crypto from Binance")


def test_no_lookahead():
    days = weekdays("2026-09-01", 10)
    i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 100.0
    for d in days:
        cols, px = nse_day(d, px)
        for k in i5:
            i5[k] += cols[k]
    seen = []

    class Spy(EchoModel):
        def forecast(self, jobs, horizon):
            for j in jobs:
                seen.append((j["t"][-1], max(j["t"])))
            return super().forecast(jobs, horizon)

    with tempfile.TemporaryDirectory() as tmp:
        w = Worker(FakeEngine({"i5": i5, "d": {"t": []}}), Spy(), Store(os.path.join(tmp, "p.sqlite")), get=lambda u: [], clock=lambda: day_start(days[-1]) + 20 * 3600)
        w.settings = {"tfs": [15], "horizon": 3, "lookback": 64, "replay_from": "2026-09-01"}
        w.refresh()
        w.settings["replay_from"] = "2026-09-01"
        w.replay_step([15], budget_s=1e9)
        rows = w.store.db.execute("select t from forecasts").fetchall()
        assert rows and all(last == mx for last, mx in seen)
        assert {r[0] for r in rows} == {t for t, _ in seen}
    print("ok   no look-ahead: each forecast's input ends at its own candle")


def test_trim_and_tail_rebuild():
    """Raw bars are trimmed after building; adding a day and rebuilding the tail gives the same candles as a full build."""
    from worker import Asset
    days = weekdays("2026-08-03", 30)
    allc = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 100.0
    for d in days:
        cols, px = nse_day(d, px, 0.7)
        for k in allc:
            allc[k] += cols[k]
    daily = {"t": [day_start(d) for d in days[:-3]], "o": [1.0] * 27, "h": [2.0] * 27, "l": [0.5] * 27, "c": [1.5] * 27}
    split = 29 * 75  # all but the last day first
    first = {k: v[:split] for k, v in allc.items()}
    last = {k: v[split:] for k, v in allc.items()}
    now = day_start(days[-1]) + 20 * 3600
    tfs = [5, 15, 60, 240, 1440]
    a = Asset("NIFTY", "nse", base=merge(first), daily_file=daily)
    a.rebuild(tfs, {}, now)
    assert len(a.base) <= 6 * 75, "raw bars trimmed to the last days"
    a.base.update(merge(last))
    a.rebuild(tfs, {}, now, 3)
    full = Asset("NIFTY", "nse", base=merge(allc), daily_file=daily)
    full.rebuild(tfs, {}, now)
    for tf in tfs:
        x, y = a.series[tf], full.series[tf]
        assert list(x.t) == list(y.t) and list(x.c) == list(y.c) and list(x.h) == list(y.h) and list(x.l) == list(y.l), tf
    assert list(a.series[1440].c[:27]) == [1.5] * 27 and len(a.series[1440]) == 30  # file days, then days built from bars
    print("ok   raw bars trimmed after building; tail rebuild equals a full build (every timeframe, daily file kept)")


if __name__ == "__main__":
    test_trim_and_tail_rebuild()
    test_sessions_and_building(); test_future_times(); test_scoring(); test_worker_end_to_end(); test_no_lookahead()
    print("all passed")

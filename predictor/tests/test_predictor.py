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


def test_replay_passes():
    """Pass 1 ≈ 100 evenly spread candles per asset and timeframe; each pass doubles them, keeping the earlier ones,
    until every 10th candle is done; the chosen candles don't move when new candles arrive."""
    days = weekdays("2026-01-05", 120)
    i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 100.0
    for d in days:
        cols, px = nse_day(d, px, 0.01)
        for k in i5:
            i5[k] += cols[k]
    now = day_start(days[-1]) + 20 * 3600
    with tempfile.TemporaryDirectory() as tmp:
        w = Worker(FakeEngine({"i5": i5, "d": {"t": []}}), EchoModel(), Store(os.path.join(tmp, "p.sqlite")), get=lambda u: [], clock=lambda: now)
        w.refresh()
        w.settings.update({"tfs": [15], "replay_from": "2026-01-05"})
        plan, st = w.replay_plan([15])
        assert st["pass"] == 1 and 50 <= st["total"] <= 100 and st["passes"] == 3, st  # ~2,937 candles: spacing 40 → 20 → 10
        first = {i for _, _, todo in plan for i in todo}
        w.replay_step([15], budget_s=1e9)
        plan2, st2 = w.replay_plan([15])
        second = {i for _, _, todo in plan2 for i in todo}
        assert st2["pass"] == 2 and st2["done"] == len(first) and not (first & second) and st2["total"] == len(first) + len(second)
        seen = []
        for _ in range(10):
            plan, st = w.replay_plan([15])
            seen.append(st["pass"])
            if st["complete"]:
                break
            w.replay_step([15], budget_s=1e9)
        assert st["complete"] and seen == [2, 3, 3], seen
        done = {r[0] for r in w.store.db.execute("select t from forecasts where tf=15")}
        s15 = w.assets["NIFTY"].series[15]
        i0 = 63
        assert done == {s15.t[i] for i in range(i0, len(s15)) if (i - i0) % 10 == 0 and now - s15.t[i] > 86400 + 900}
        # new candles: the grid stays where it was (only later candles are added)
        assert w.store.get("grid|NIFTY|15")["top"] == 40
    print("ok   replay in passes: ~100 first, doubling each pass, earlier ones kept, fixed grid, until every 10th candle")


class NoisyModel(EchoModel):
    """Stand-in that draws a different path per row: the last close plus noise, leaning up."""
    def forecast(self, jobs, horizon):
        import random
        out = []
        for j in jobs:
            rnd = random.Random(j["key"])
            last = j["c"][-1]
            out.append([[last, last + 1, last - 1, last + rnd.uniform(-1, 3) * (k + 1)] for k in range(horizon)])
        return out


def test_paths_and_confidence():
    days = weekdays("2026-03-02", 80)
    i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 100.0
    for d in days:
        cols, px = nse_day(d, px, 0.02)
        for k in i5:
            i5[k] += cols[k]
    now = day_start(days[-1]) + 20 * 3600
    with tempfile.TemporaryDirectory() as tmp:
        st = Store(os.path.join(tmp, "p.sqlite"))
        w = Worker(FakeEngine({"i5": i5, "d": {"t": []}}), NoisyModel(), st, get=lambda u: [], clock=lambda: now)
        w.refresh()
        w.settings.update({"tfs": [15, 60], "horizon": 3, "lookback": 64, "replay_from": "2026-03-02", "samples": {"60": 1}})
        for x in w.assets.values():
            x.series.clear(); x.base = merge(i5) if x.kind == "nse" else {}; x.rebuild([15, 60], {}, now)
        w.replay_step([60], budget_s=1e9)
        n1 = st.count()
        assert n1 > 0 and st.db.execute("select count(*) from forecasts where tf=60 and k=1").fetchone()[0] == n1
        # now 5 paths on 1 hour: the single-path ones are redone with 5
        w.settings["samples"] = {"60": 5}
        w.resample_old([15, 60])
        assert st.count() == 0
        w.replay_step([60], budget_s=1e9)
        rows = st.db.execute("select k, up, pred, last from forecasts where tf=60").fetchall()
        assert rows and all(r[0] == 5 for r in rows)
        ups = [json.loads(r[1]) for r in rows]
        assert all(all(x in (0, 0.2, 0.4, 0.6, 0.8, 1.0) for x in u) for u in ups) and any(0 < u[0] < 1 for u in ups), "shares of 5 paths"
        w.score_all([60])
        confs = [r[0] for r in st.db.execute("select conf from scores where tf=60 and conf is not null")]
        assert confs and all(0 <= c <= 1 for c in confs)
        tot = st.totals({("NIFTY", 60)})
        assert all(set(x["conf"]) == {"lo", "mid", "hi"} for x in tot)
        assert sum(x["conf"][b][0] for x in tot for b in x["conf"]) == sum(x["dir_n"] for x in tot), "every called move falls in one confidence band"
    print("ok   several paths per forecast: average path, share of paths up, confidence bands; single-path ones redone")


def test_correction_layer_walk_forward():
    """Kronos is wrong in a steady way (its call is backwards): the correction learns it from earlier months and fixes
    later calls; the first month has no correction (nothing earlier to learn from); a month whose pattern changes is
    not fixed, which shows it never learns from the month it judges."""
    import random
    from calib import walk_forward
    with tempfile.TemporaryDirectory() as tmp:
        st = Store(os.path.join(tmp, "p.sqlite"))
        rnd = random.Random(1)
        months = ["2026-01", "2026-02", "2026-03", "2026-04"]
        for mi, m in enumerate(months):
            for k in range(400):
                t = day_start(m + "-02") + k * 3600
                up_pred = rnd.random() < 0.5
                pc = 101.0 if up_pred else 99.0
                actual_up = (not up_pred) if mi < 3 else up_pred  # backwards in Jan–Mar, right in April
                st.add("NIFTY", 60, t, "replay", 100.0, 100.0, {"1": 1.0}, [[100, 101, 99, pc]], 5, [0.8 if up_pred else 0.2],
                       {"mom1": 0, "mom5": 0, "mom20": 0, "tod": 0.4, "kind": "nse", "sw": 1.0})
                st.save_scores("NIFTY", 60, t, "replay", [{"h": 1, "dir_n": 1, "hit": int(up_pred == actual_up), "hit_mom": 0, "ae_k": 0, "ae_flat": 0,
                                                           "re_k": 0, "re_atr": 0, "conf": 0.8, "up_act": int(actual_up)}], 1)
        st.commit()
        walk_forward(st.db, 60, 1)
        by = {}
        for m, p, up_act in st.db.execute("select month, p_cal, up_act from scores where tf=60"):
            by.setdefault(m, []).append((p, up_act))
        assert all(p is None for p, _ in by["2026-01"]), "nothing earlier to learn from"
        fixed = lambda m: sum(1 for p, u in by[m] if p is not None and (p > 0.5) == (u == 1)) / len(by[m])
        assert fixed("2026-02") > 0.95 and fixed("2026-03") > 0.95, (fixed("2026-02"), fixed("2026-03"))
        assert fixed("2026-04") < 0.05, "April's change isn't known to April's model: no peeking"
        tot = st.totals({("NIFTY", 60)})
        feb = next(x for x in tot if x["month"] == "2026-02")
        assert feb["cal_n"] == 400 and feb["hit_cal"] > 380 and feb["hit"] < 20
    print("ok   correction layer: walk-forward month by month, learns steady errors, never peeks at the month it judges")


def test_reports_send_only_changes():
    """Totals go out only when a month's figures changed; the database never gets the same row twice."""
    days = weekdays("2026-08-03", 40)
    i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
    px = 100.0
    for d in days:
        cols, px = nse_day(d, px, 0.3)
        for k in i5:
            i5[k] += cols[k]
    clock = [day_start(days[-1]) + 20 * 3600]
    with tempfile.TemporaryDirectory() as tmp:
        eng = FakeEngine({"i5": i5, "d": {"t": []}})
        w = Worker(eng, EchoModel(), Store(os.path.join(tmp, "p.sqlite")), get=lambda u: [], clock=lambda: clock[0])
        w.cycle()
        first = sum(len(b.get("stats", [])) for b in eng.pushed)
        assert first > 0
        n0 = len(eng.pushed)
        w.dirty |= {(k, tf) for k in w.assets for tf in (15, 1440)}  # everything marked touched, nothing changed
        clock[0] += 700
        w.report([15, 1440])
        assert len(eng.pushed) == n0 + 1 and eng.pushed[-1]["stats"] == [], "unchanged months are not sent again"
        clock[0] += 100
        w.report([15, 1440])
        assert len(eng.pushed) == n0 + 1, "reports at most every 10 minutes"
    print("ok   reports: only changed monthly rows, at most every 10 minutes")


if __name__ == "__main__":
    test_reports_send_only_changes()
    test_paths_and_confidence()
    test_correction_layer_walk_forward()
    test_replay_passes()
    test_trim_and_tail_rebuild()
    test_sessions_and_building(); test_future_times(); test_scoring(); test_worker_end_to_end(); test_no_lookahead()
    print("all passed")

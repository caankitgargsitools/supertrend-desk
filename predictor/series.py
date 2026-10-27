"""Candles for the Prediction Lab: 5-minute bars merged from the lab's files and the live feed, built into every
timeframe within each market session, and the times of the candles still to come.

Times are epoch seconds of a candle's start; days and minutes are IST (the desk's clock). Sessions follow the engine
(logic.ts sessionFor): NSE 09:15–15:30, MCX 09:00–23:30 (23:55 outside US summer time), crypto round the clock with the
IST calendar day as its day. Holidays: closed days have no candles; a day's own session start (MCX evening only) is
taken from the holidays list."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
DAY = 86400


def ist_day(t: int) -> str:
    return dt.datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")


def ist_min(t: int) -> int:
    d = dt.datetime.fromtimestamp(t, IST)
    return d.hour * 60 + d.minute


def day_start(day: str) -> int:
    return int(dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=IST).timestamp())


def _nth_sunday(y: int, m: int, n: int) -> str:
    d = dt.date(y, m, 1)
    d += dt.timedelta(days=(6 - d.weekday()) % 7 + 7 * (n - 1))
    return d.isoformat()


def session(kind: str, day: str, holidays: dict | None = None) -> tuple[int, int]:
    """(open, close) in minutes for an asset kind ('nse' | 'mcx' | 'crypto') on a day; (1440, -1) when closed."""
    if kind == "crypto":
        return 0, 1440
    if kind == "nse":
        o, c = 555, 930
    else:
        y = int(day[:4])
        o, c = 540, (1410 if _nth_sunday(y, 3, 2) <= day < _nth_sunday(y, 11, 1) else 1435)
    if dt.date.fromisoformat(day).weekday() >= 5:
        return 1440, -1
    h = (holidays or {}).get(("MCX" if kind == "mcx" else "NSE", day), "missing")
    if h == "missing":
        return o, c
    return (1440, -1) if h is None else (max(o, h), c)


@dataclass
class Bars:
    t: list[int]
    o: list[float]
    h: list[float]
    l: list[float]
    c: list[float]
    v: list[float]

    def __len__(self):
        return len(self.t)


def merge(*parts: dict) -> dict[int, tuple]:
    """Column sets {t,o,h,l,c[,v]} merged by time; later parts win (the live feed over older files)."""
    out: dict[int, tuple] = {}
    for p in parts:
        if not p or not p.get("t"):
            continue
        v = p.get("v") or [0.0] * len(p["t"])
        for i, t in enumerate(p["t"]):
            out[int(t)] = (float(p["o"][i]), float(p["h"][i]), float(p["l"][i]), float(p["c"][i]), float(v[i] or 0))
    return out


def build(base5: dict[int, tuple], tf: int, kind: str, holidays: dict | None = None, now: int | None = None) -> Bars:
    """Finished candles of `tf` minutes (5 … 240) built from 5-minute bars, anchored at each session's open; the last
    candle of a session may be shorter. A candle counts as finished once a later bar exists or its end (or the session
    close) has passed `now`."""
    ts = sorted(base5)
    groups: dict[int, list[int]] = {}
    keys: list[int] = []
    for t in ts:
        day = ist_day(t)
        o, c = session(kind, day, holidays)
        m = ist_min(t)
        if m < o or m >= c:
            continue
        k = day_start(day) + (o + (m - o) // tf * tf) * 60
        if k not in groups:
            groups[k] = []
            keys.append(k)
        groups[k].append(t)
    out = Bars([], [], [], [], [], [])
    for i, k in enumerate(keys):
        g = groups[k]
        day = ist_day(k)
        o, c = session(kind, day, holidays)
        end = min(k + tf * 60, day_start(day) + c * 60)
        # Finished once a later candle has bars or its own last bar is in (never on the clock alone: the feed can lag).
        finished = i + 1 < len(keys) or g[-1] + 300 >= end
        if not finished:
            continue
        b = [base5[t] for t in g]
        out.t.append(k)
        out.o.append(b[0][0])
        out.h.append(max(x[1] for x in b))
        out.l.append(min(x[2] for x in b))
        out.c.append(b[-1][3])
        out.v.append(sum(x[4] for x in b))
    return out


def daily_from(base5: dict[int, tuple], kind: str, holidays: dict | None = None, now: int | None = None, files_daily: dict | None = None) -> Bars:
    """Daily candles: the lab's daily file where it has the day, else built from the day's 5-minute bars once the
    session is over (or a later day has bars)."""
    days: dict[str, tuple] = {}
    if files_daily and files_daily.get("t"):
        for i, t in enumerate(files_daily["t"]):
            v = (files_daily.get("v") or [0] * len(files_daily["t"]))[i] or 0
            days[ist_day(int(t))] = (day_start(ist_day(int(t))), float(files_daily["o"][i]), float(files_daily["h"][i]), float(files_daily["l"][i]), float(files_daily["c"][i]), float(v))
    by: dict[str, list[int]] = {}
    for t in sorted(base5):
        day = ist_day(t)
        o, c = session(kind, day, holidays)
        m = ist_min(t)
        if o <= m < c:
            by.setdefault(day, []).append(t)
    last_day = max(by) if by else ""
    for day, g in by.items():
        if day in days:
            continue
        o, c = session(kind, day, holidays)
        over = day < last_day or (by[day][-1] + 300 >= day_start(day) + c * 60 and (now is None or now >= day_start(day) + c * 60))
        if not over:
            continue
        b = [base5[t] for t in g]
        days[day] = (day_start(day), b[0][0], max(x[1] for x in b), min(x[2] for x in b), b[-1][3], sum(x[4] for x in b))
    out = Bars([], [], [], [], [], [])
    for day in sorted(days):
        r = days[day]
        out.t.append(r[0]); out.o.append(r[1]); out.h.append(r[2]); out.l.append(r[3]); out.c.append(r[4]); out.v.append(r[5])
    return out


def future_times(last_t: int, tf: int, n: int, kind: str, holidays: dict | None = None) -> list[int]:
    """Start times of the next n candles after the one starting at last_t (skipping closed hours, weekends, holidays)."""
    out: list[int] = []
    if tf >= 1440:
        day = dt.date.fromisoformat(ist_day(last_t))
        while len(out) < n:
            day += dt.timedelta(days=1)
            o, c = session(kind, day.isoformat(), holidays)
            if o < c:
                out.append(day_start(day.isoformat()))
        return out
    t = last_t
    day = ist_day(t)
    while len(out) < n:
        o, c = session(kind, day, holidays)
        nxt = t + tf * 60
        if ist_day(nxt) == day and o <= ist_min(nxt) < c and (nxt - day_start(day)) // 60 < c:
            out.append(nxt); t = nxt
            continue
        d = dt.date.fromisoformat(day)
        while True:
            d += dt.timedelta(days=1)
            o2, c2 = session(kind, d.isoformat(), holidays)
            if o2 < c2:
                break
        day = d.isoformat()
        t = day_start(day) + o2 * 60
        out.append(t)
    return out

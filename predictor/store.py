"""The server's own record of every forecast and its score (SQLite on the server's disk). Only monthly totals and
the latest forecasts go to the database."""
from __future__ import annotations

import json
import sqlite3
import time

from series import ist_day


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, timeout=30)
        self.db.execute("pragma journal_mode=wal")
        self.db.executescript("""
        create table if not exists forecasts (
          asset text, tf integer, t integer, mode text, made integer, last real, prev real,
          base_r text, pred text, scored integer default 0, primary key (asset, tf, t));
        create table if not exists scores (
          asset text, tf integer, t integer, h integer, mode text, month text,
          dir_n integer, hit integer, hit_mom integer, ae_k real, ae_flat real, re_k real, re_atr real,
          primary key (asset, tf, t, h));
        create table if not exists kv (k text primary key, v text);
        """)
        self.db.commit()
        self._times: dict = {}

    def times(self, asset: str, tf: int) -> set:
        """Origins already forecast (kept in memory after the first read)."""
        k = (asset, tf)
        if k not in self._times:
            self._times[k] = {r[0] for r in self.db.execute("select t from forecasts where asset=? and tf=?", (asset, tf))}
        return self._times[k]

    def has(self, asset: str, tf: int, t: int) -> bool:
        return t in self.times(asset, tf)

    def add(self, asset, tf, t, mode, last, prev, base_r, pred):
        self.times(asset, tf).add(t)
        self.db.execute("insert or ignore into forecasts (asset, tf, t, mode, made, last, prev, base_r, pred) values (?,?,?,?,?,?,?,?,?)",
                        (asset, tf, t, mode, int(time.time()), last, prev, json.dumps(base_r), json.dumps(pred)))

    def open_forecasts(self, asset: str, tf: int, horizon: int):
        return self.db.execute("select t, mode, last, prev, base_r, pred, scored from forecasts where asset=? and tf=? and scored < ? order by t", (asset, tf, horizon)).fetchall()

    def save_scores(self, asset, tf, t, mode, rows, scored):
        month = ist_day(t)[:7]
        self.db.executemany("insert or replace into scores values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [(asset, tf, t, r["h"], mode, month, r["dir_n"], r["hit"], r["hit_mom"], r["ae_k"], r["ae_flat"], r["re_k"], r["re_atr"]) for r in rows])
        self.db.execute("update forecasts set scored=? where asset=? and tf=? and t=?", (scored, asset, tf, t))

    def totals(self, pairs: set[tuple[str, int]]):
        """Whole-month totals for these (asset, tf) pairs, in the pred_stats shape."""
        out = []
        for asset, tf in pairs:
            for r in self.db.execute("""select h, month, mode, count(*), sum(dir_n), sum(hit), sum(hit_mom), sum(ae_k), sum(ae_flat),
                     sum(ae_flat-ae_k), sum((ae_flat-ae_k)*(ae_flat-ae_k)), sum(re_k), sum(re_atr), sum(re_atr-re_k), sum((re_atr-re_k)*(re_atr-re_k))
                     from scores where asset=? and tf=? group by h, month, mode""", (asset, tf)):
                out.append({"asset": asset, "tf": tf, "h": r[0], "month": r[1], "mode": r[2], "n": r[3], "dir_n": r[4], "hit": r[5], "hit_mom": r[6],
                            "ae_k": r[7], "ae_flat": r[8], "d_sum": r[9], "d_sq": r[10], "re_k": r[11], "re_atr": r[12], "r_sum": r[13], "r_sq": r[14]})
        return out

    def recent(self, asset: str, tf: int, n: int = 20):
        rows = self.db.execute("select t, last, pred from forecasts where asset=? and tf=? order by t desc limit ?", (asset, tf, n)).fetchall()
        return [{"t": r[0], "last": r[1], "p": [round(x[3], 4) for x in json.loads(r[2])]} for r in reversed(rows)]

    def count(self, mode: str | None = None, since: int | None = None) -> int:
        q, a = "select count(*) from forecasts where 1=1", []
        if mode:
            q += " and mode=?"; a.append(mode)
        if since:
            q += " and made>=?"; a.append(since)
        return self.db.execute(q, a).fetchone()[0]

    def get(self, k: str, default=None):
        r = self.db.execute("select v from kv where k=?", (k,)).fetchone()
        return json.loads(r[0]) if r else default

    def put(self, k: str, v):
        self.db.execute("insert or replace into kv values (?,?)", (k, json.dumps(v)))

    def commit(self):
        self.db.commit()

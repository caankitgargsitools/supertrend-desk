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
        create table if not exists sent (k text primary key, h text);
        """)
        # Added 27 Oct (several paths per forecast, the correction layer): k = paths drawn, up = per step the share
        # of paths ending above the last close, feats = the inputs the correction layer learns from; per score:
        # conf = share of paths agreeing with the call, up_act = real move up (1) / down (0), p_cal = corrected chance up.
        for table, col, typ in (("forecasts", "k", "integer"), ("forecasts", "up", "text"), ("forecasts", "feats", "text"),
                                ("scores", "conf", "real"), ("scores", "up_act", "integer"), ("scores", "p_cal", "real")):
            if col not in {r[1] for r in self.db.execute(f"pragma table_info({table})")}:
                self.db.execute(f"alter table {table} add column {col} {typ}")
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

    def add(self, asset, tf, t, mode, last, prev, base_r, pred, k=1, up=None, feats=None):
        self.times(asset, tf).add(t)
        self.db.execute("insert or ignore into forecasts (asset, tf, t, mode, made, last, prev, base_r, pred, k, up, feats) values (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (asset, tf, t, mode, int(time.time()), last, prev, json.dumps(base_r), json.dumps(pred), k,
                         json.dumps(up) if up is not None else None, json.dumps(feats) if feats is not None else None))

    def forget(self, asset: str, tf: int, ts: list[int]):
        """Drops forecasts (and their scores) from the server's own record, e.g. single-path ones to be redone with
        several paths. Only this local file; the database's monthly totals are rewritten from it."""
        for t in ts:
            self.db.execute("delete from scores where asset=? and tf=? and t=?", (asset, tf, t))
            self.db.execute("delete from forecasts where asset=? and tf=? and t=?", (asset, tf, t))
            self.times(asset, tf).discard(t)

    def open_forecasts(self, asset: str, tf: int, horizon: int):
        return self.db.execute("select t, mode, last, prev, base_r, pred, scored, up from forecasts where asset=? and tf=? and scored < ? order by t", (asset, tf, horizon)).fetchall()

    def save_scores(self, asset, tf, t, mode, rows, scored):
        month = ist_day(t)[:7]
        self.db.executemany("insert or replace into scores (asset, tf, t, h, mode, month, dir_n, hit, hit_mom, ae_k, ae_flat, re_k, re_atr, conf, up_act, p_cal) "
                            "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(select p_cal from scores where asset=? and tf=? and t=? and h=?))",
                            [(asset, tf, t, r["h"], mode, month, r["dir_n"], r["hit"], r["hit_mom"], r["ae_k"], r["ae_flat"], r["re_k"], r["re_atr"],
                              r.get("conf"), r.get("up_act"), asset, tf, t, r["h"]) for r in rows])
        self.db.execute("update forecasts set scored=? where asset=? and tf=? and t=?", (scored, asset, tf, t))

    def totals(self, pairs: set[tuple[str, int]]):
        """Whole-month totals for these (asset, tf) pairs, in the pred_stats shape."""
        out = []
        for asset, tf in pairs:
            for r in self.db.execute("""select h, month, mode, count(*), sum(dir_n), sum(hit), sum(hit_mom), sum(ae_k), sum(ae_flat),
                     sum(ae_flat-ae_k), sum((ae_flat-ae_k)*(ae_flat-ae_k)), sum(re_k), sum(re_atr), sum(re_atr-re_k), sum((re_atr-re_k)*(re_atr-re_k)),
                     sum(case when dir_n=1 and conf<0.7 then 1 else 0 end), sum(case when dir_n=1 and conf<0.7 then hit else 0 end),
                     sum(case when dir_n=1 and conf>=0.7 and conf<0.9 then 1 else 0 end), sum(case when dir_n=1 and conf>=0.7 and conf<0.9 then hit else 0 end),
                     sum(case when dir_n=1 and conf>=0.9 then 1 else 0 end), sum(case when dir_n=1 and conf>=0.9 then hit else 0 end),
                     sum(case when dir_n=1 and p_cal is not null then 1 else 0 end), sum(case when dir_n=1 and p_cal is not null and (p_cal>0.5)=(up_act=1) then 1 else 0 end)
                     from scores where asset=? and tf=? group by h, month, mode""", (asset, tf)):
                out.append({"asset": asset, "tf": tf, "h": r[0], "month": r[1], "mode": r[2], "n": r[3], "dir_n": r[4], "hit": r[5], "hit_mom": r[6],
                            "ae_k": r[7], "ae_flat": r[8], "d_sum": r[9], "d_sq": r[10], "re_k": r[11], "re_atr": r[12], "r_sum": r[13], "r_sq": r[14],
                            # direction by how many paths agreed: under 70% (3 of 5), 70–90% (4 of 5), 90%+ (5 of 5)
                            "conf": {"lo": [r[15], r[16]], "mid": [r[17], r[18]], "hi": [r[19], r[20]]}, "cal_n": r[21], "hit_cal": r[22]})
        return out

    @staticmethod
    def _row_key(r: dict) -> str:
        return f"{r['asset']}|{r['tf']}|{r['h']}|{r['month']}|{r['mode']}"

    @staticmethod
    def _row_hash(r: dict) -> str:
        return json.dumps(r, sort_keys=True, default=lambda x: round(x, 6) if isinstance(x, float) else x)

    def unsent(self, rows: list[dict]) -> list[dict]:
        """Only the monthly rows that differ from what the database already got (28 Oct: resending every row of every
        touched asset and timeframe, ~800 rows a minute, used up the small database's processor)."""
        out = []
        for r in rows:
            got = self.db.execute("select h from sent where k=?", (self._row_key(r),)).fetchone()
            if not got or got[0] != self._row_hash(r):
                out.append(r)
        return out

    def mark_sent(self, rows: list[dict]):
        self.db.executemany("insert or replace into sent values (?,?)", [(self._row_key(r), self._row_hash(r)) for r in rows])

    def recent(self, asset: str, tf: int, n: int = 20):
        rows = self.db.execute("select t, last, pred, up from forecasts where asset=? and tf=? order by t desc limit ?", (asset, tf, n)).fetchall()
        return [{"t": r[0], "last": r[1], "p": [round(x[3], 4) for x in json.loads(r[2])], **({"up": json.loads(r[3])} if r[3] else {})} for r in reversed(rows)]

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

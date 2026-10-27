"""Kronos forecasts in batches. The model code is the official Kronos repository (MIT licence) at a pinned commit,
copied into the image; the weights come from Hugging Face on first start and stay in /data."""
from __future__ import annotations

import datetime as dt
import hashlib
import os

from series import IST

MODELS = {"mini": ("NeoQuasar/Kronos-mini", "NeoQuasar/Kronos-Tokenizer-2k", 2048),
          "small": ("NeoQuasar/Kronos-small", "NeoQuasar/Kronos-Tokenizer-base", 512),
          "base": ("NeoQuasar/Kronos-base", "NeoQuasar/Kronos-Tokenizer-base", 512)}


def _times(ts):
    import pandas as pd
    return pd.Series([dt.datetime.fromtimestamp(t, IST).replace(tzinfo=None) for t in ts])


class KronosRunner:
    def __init__(self, model: str = "mini", threads: int = 2, samples: int = 1):
        import torch
        from model import Kronos, KronosPredictor, KronosTokenizer  # the Kronos repository's package
        torch.set_num_threads(threads)
        mid, tid, ctx = MODELS[model]
        self.torch = torch
        self.name = model
        self.samples = samples
        tok = KronosTokenizer.from_pretrained(tid)
        m = Kronos.from_pretrained(mid)
        tok.eval(); m.eval()
        self.p = KronosPredictor(m, tok, device="cpu", max_context=ctx)

    def forecast(self, jobs: list[dict], horizon: int) -> list[list[list[float]]]:
        """jobs: {o,h,l,c,v (lists, same length within the batch), t (start times), future (start times)}.
        Returns per job `horizon` candles [o,h,l,c]. Each job's sampling seed comes from its asset, timeframe and time,
        so a forecast can be made again with the same result."""
        import pandas as pd
        dfs = [pd.DataFrame({"open": j["o"], "high": j["h"], "low": j["l"], "close": j["c"], "volume": j["v"]}) for j in jobs]
        seed = int(hashlib.sha256("|".join(str(j.get("key", "")) for j in jobs).encode()).hexdigest()[:8], 16)
        self.torch.manual_seed(seed)
        with self.torch.no_grad():
            out = self.p.predict_batch(dfs, [_times(j["t"]) for j in jobs], [_times(j["future"]) for j in jobs], pred_len=horizon,
                                       T=1.0, top_p=0.9, sample_count=self.samples, verbose=False)
        res = []
        for df in out:
            rows = []
            for _, r in df.iterrows():
                o, h, l, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
                rows.append([o, max(o, h, l, c), min(o, h, l, c), c])  # the model can give a high below the close
            res.append(rows)
        return res


def make_runner():
    return KronosRunner(os.environ.get("PRED_MODEL", "mini"), int(os.environ.get("PRED_THREADS", "2")), int(os.environ.get("PRED_SAMPLES", "1")))

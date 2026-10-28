"""Fine-tuning chain with stand-in Kronos weights (Hugging Face isn't reachable in tests) and synthetic prices:
windows never cross the cutoff, training lowers the loss and saves weights the runner loads, and the side-by-side test
scores both models on the same unseen candles. Needs torch and the Kronos code:
  PYTHONPATH=<Kronos repo> python predictor/tests/test_finetune.py"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import model as km  # noqa: E402  (the Kronos repository's package)

km.KronosTokenizer.from_pretrained = classmethod(lambda cls, _id: cls(d_in=6, d_model=64, n_heads=2, ff_dim=128, n_enc_layers=1, n_dec_layers=1, ffn_dropout_p=0, attn_dropout_p=0,
                                                                     resid_dropout_p=0, s1_bits=6, s2_bits=6, beta=0.05, gamma0=1, gamma=1.1, zeta=0.05, group_size=4))
km.Kronos.from_pretrained = classmethod(lambda cls, _id: (lambda m: (m.load_state_dict(STAND_IN), m)[1] if STAND_IN else m)(
    cls(s1_bits=6, s2_bits=6, n_layers=2, d_model=64, n_heads=2, ff_dim=128, ffn_dropout_p=0, attn_dropout_p=0, resid_dropout_p=0, token_dropout_p=0, learn_te=True)))
STAND_IN = None

import torch  # noqa: E402
from evaluate import compare  # noqa: E402
from finetune import Windows, save, train  # noqa: E402
from runner import KronosRunner  # noqa: E402
from series import day_start, ist_day  # noqa: E402
from store import Store  # noqa: E402
from test_predictor import FakeEngine, nse_day, weekdays  # noqa: E402
from worker import Worker  # noqa: E402

torch.manual_seed(0)
days = weekdays("2025-05-01", 200)  # May 2025 – Feb 2026: crosses the 1 Sept 2025 cutoff
i5 = {"t": [], "o": [], "h": [], "l": [], "c": []}
px = 1000.0
for d in days:
    cols, px = nse_day(d, px, 0.05)
    for k in i5:
        i5[k] += cols[k]
with tempfile.TemporaryDirectory() as tmp:
    w = Worker(FakeEngine({"i5": i5, "d": {"t": []}}), None, Store(os.path.join(tmp, "s.sqlite")), get=lambda u: [], clock=lambda: day_start(days[-1]) + 20 * 3600)
    w.say = lambda *_: None; w.alive = lambda *_: None
    w.history_from = day_start("2025-05-01")
    w.refresh()
    w.settings.update({"lookback": 64, "horizon": 10, "replay_from": "2025-09-01"})
    win = Windows(w.assets, tfs=[15, 60], lookback=64, val_days=20)
    cut = day_start("2025-09-01")
    for key, x, t, idx in win.train + win.val:
        tf = int(key.split("|")[1])
        assert all(t[i] + tf * 60 * 11 <= cut for i in idx), "a window reaches past the cutoff"
    assert win.train and win.val
    xs, ss = win.sample(win.train, 4)
    assert xs.shape == (4, 74, 6) and ss.shape == (4, 74, 5) and abs(xs[:, :64].mean()) < 0.5
    print("ok   training windows end before the 1 Sept 2025 cutoff; the last 20 days before it are kept for checking")

    base = KronosRunner("mini", threads=2)
    STAND_IN = {k: v.clone() for k, v in base.p.model.state_dict().items()}  # every load starts from the same stand-in weights
    tuned = KronosRunner("mini", threads=2)
    state, summ = train(tuned, win, minutes=0.6, batch=8, val_batches=4, every=20, log=lambda *_: None)
    print("training:", {k: summ[k] for k in ("steps", "check_before", "check_best")})
    assert summ["steps"] >= 20 and summ["check_best"] < summ["check_before"], summ
    path = os.path.join(tmp, "ft.safetensors")
    save(state, path, {"cutoff": "2025-09-01"})
    loaded = KronosRunner("mini", threads=2, weights=path)
    assert loaded.name == "mini-ft"
    assert all(torch.equal(loaded.p.model.state_dict()[k], state[k]) for k in state)
    print("ok   training lowers the checking loss; the saved weights load back into the forecaster")

    rows = compare(w, base, loaded, [15, 60], "2025-09-01", 20, log=lambda *_: None)
    assert rows and all(r["n"] >= 10 for r in rows)
    r = rows[0]["steps"]["1"]
    assert r["n"] == rows[0]["n"] and 0 <= r["hit_base"] <= r["dir_n"] and 0 <= r["hit_ft"] <= r["dir_n"]
    print("ok   side-by-side test: both models on the same unseen candles, totals per step ahead:", {k: rows[0]["steps"]["1"][k] for k in ("n", "hit_base", "hit_ft", "ae_base", "ae_ft")})
print("all passed")

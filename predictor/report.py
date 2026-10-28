"""Sends a fine-tuning run's results to the engine (pred_push 'model_run'), for the Prediction Lab page: the training
summary (train.json) and the side-by-side test on the unseen months (eval-*.json from each asset group)."""
from __future__ import annotations

import glob
import json
import os
import sys

from worker import Engine


def build(train_path: str, eval_glob: str, weights_url: str | None) -> dict:
    with open(train_path) as f:
        train = json.load(f)
    rows, meta = [], []
    for p in sorted(glob.glob(eval_glob)):
        with open(p) as f:
            e = json.load(f)
        rows += e["rows"]
        meta.append({k: e[k] for k in ("start", "per_pair", "kinds", "minutes")})
    return {"name": f"chaturbhuj-ft-{train['trained_at'][:10]}", "trained_at": train["trained_at"], "cutoff": train["cutoff"],
            "weights_url": weights_url, "train": train, "eval": {"runs": meta, "rows": rows}}


if __name__ == "__main__":
    run = build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    print(json.dumps(Engine(os.environ["SUPABASE_URL"], os.environ.get("PRED_KEY")).push({"model_run": run})))

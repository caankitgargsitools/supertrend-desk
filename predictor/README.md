# Prediction Lab worker (Kronos)

Runs Kronos-mini forecasts for every lab asset on 5m, 15m, 30m, 1h, 4h and daily candles, 1–10 candles ahead,
scores them against simple baselines and reports to the engine (`pred_pull` / `pred_push`, key `x-pred-key`).
Only public market candles reach the server.

- Image: `ghcr.io/caankitgargsitools/ankgenie-predictor:latest` (GitHub Actions `predictor-image.yml`; the package must
  be public once, in GitHub → Packages → ankgenie-predictor → Package settings → Change visibility).
- Server setup: Prediction Lab page → "Server key" → copy the setup script, run it once on the server with `sudo bash`.
  It writes `/opt/ankgenie/predictor.env` (root only), adds 2 GB of swap if the machine has none, and starts the
  container (`--memory 1200m`, low CPU priority so Dhandha's crawler comes first) plus its own Watchtower.
- Logs: `sudo docker logs -f ankgenie-predictor`. Data (forecast detail, model weights): Docker volume `ankgenie-pred`.
- Settings (env): `PRED_MODEL` (mini; small/base are pending a bigger server), `PRED_THREADS` (2), `PRED_SAMPLES` (1),
  `PRED_BATCH` (16).
- Tests: `python predictor/tests/test_predictor.py` (stand-in model, no network).

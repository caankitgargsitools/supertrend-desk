-- Prediction Lab: fine-tuning runs (28 Oct 2026; predictor/finetune.py, evaluate.py, report.py, GitHub Actions
-- kronos-finetune.yml). One row per run: the training summary and the side-by-side test of the original and the
-- fine-tuned Kronos-mini on the unseen months (from the cutoff, 1 Sept 2025). Written by the engine (pred_push
-- 'model_run', server key); admins read it on the Prediction Lab page. The weights are a GitHub release asset.
create table if not exists public.pred_models (
  name text primary key,
  trained_at timestamptz,
  cutoff date,
  weights_url text,
  train jsonb,
  eval jsonb,
  created_at timestamptz not null default now()
);
alter table public.pred_models enable row level security;
create policy pred_models_admin on public.pred_models for select using ((select public.is_admin()));

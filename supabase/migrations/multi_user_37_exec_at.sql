-- When a stop exit was claimed (exec_state 'stopping'): the per-second check and the minute tick never both exit.
alter table public.algo_strategies add column if not exists exec_at timestamptz;

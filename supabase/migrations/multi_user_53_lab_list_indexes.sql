-- 28 Oct 2026: the Strategy Lab page timed out while the small database's processor was throttled (after the
-- Prediction Lab's flood of report writes). Its heaviest reads scanned every lab result; these small partial indexes
-- let them read only the rows they need: the list of passed (or current) strategies by score, and the count of
-- strategies still in the full test. Measured: count 2.6 s → 0.2 ms; passed list 3.1 s → 1.1 s.
create index if not exists lab_results_list_passed on public.lab_results (score desc, id desc) where passed and superseded_by is null;
create index if not exists lab_results_list_current on public.lab_results (score desc, id desc) where superseded_by is null;
create index if not exists lab_results_checking on public.lab_results (id) where basic_passed and superseded_by is null and (robust_status is null or robust_status <> 'done');

---
name: portal-audit
description: Full health re-check of the AnkGenie portal — every engine test, every website test (both looks, computer and phone), the engine build, the live System health checks, and the last 24 hours of engine / database / cron errors — summarised as one green / amber / red report for Papa. Use when asked to "audit the portal", "check everything", "re-check the portal", before a big change, or weekly.
---

# Portal audit

Read-only: never write test rows to the production database, never deploy, never change data. Report in plain English
to Papa (see CLAUDE.md: address him as "Papa", whole rupees, honest about what failed).

## 1. Engine tests (tests/sim)
```bash
cd tests/sim && node build.mjs >/dev/null && node build_all.mjs >/dev/null
for f in *.test.mjs; do timeout 300 node "$f" > "/tmp/audit_$f.log" 2>&1 && echo "ok   $f" || echo "FAIL $f"; done
```
For each FAIL, show the failing case lines (`grep -A4 FAIL /tmp/audit_<file>.log`).

## 2. Engine build
```bash
cd supabase/functions/engine && npx esbuild index.ts --bundle --format=esm --platform=neutral "--external:npm:*" --outfile=/dev/null
```

## 3. Website tests (tests/ui, Playwright with mocked Supabase)
```bash
ln -sfn "$(npm root -g)" tests/ui/node_modules
python3 -m http.server 8765 >/dev/null 2>&1 &   # from the repo root
for f in tests/ui/ui_*.mjs; do timeout 120 node "$f" > "/tmp/audit_$(basename $f).log" 2>&1 && echo "ok   $f" || echo "FAIL $f"; done
```
Tests that take arguments (theme width) — run them also as `dark 390` (phone) and `light 1440`:
ui_compare.mjs, ui_combo.mjs, ui_lab_assets.mjs. Run long loops in the background and wait with Monitor.
Clean up afterwards: `rm -f tests/ui/node_modules tests/ui/*.png; pkill -f "http.server 8765"`.

## 4. Live System health (Supabase project umryzxusbdttbcshkajt, read-only SQL)
```sql
select run_at, ok, warn, fail from health_runs order by id desc limit 1;
select e->>'name' name, e->>'status' status, e->>'detail' detail
  from health_runs h, jsonb_array_elements(h.items) e
 where h.id = (select max(id) from health_runs) and e->>'status' in ('fail','warn');
```
(Don't call desk_health() just to look — the hourly run is enough; if the last run is over 2 h old, say so.)

## 5. Errors in the last 24 hours
- Engine replies: `select status_code, count(*) from net._http_response where created > now() - interval '24 hours' group by 1;`
  and the latest non-200 bodies (`left(content, 200)`).
- Cron failures: `select j.jobname, d.status, left(d.return_message, 150), d.start_time from cron.job j join cron.job_run_details d on d.jobid = j.jobid where d.runid > (select max(runid) from cron.job_run_details) - 80000 and d.start_time > now() - interval '24 hours' and d.status <> 'succeeded' order by d.start_time desc limit 20;`
- Strategy errors: `select name, last_error from algo_strategies where active and not archived and not is_master and last_error is not null;`
- Edge function logs: Supabase MCP `get_logs` (service "edge-function") if available — count errors, show the top 3.

## 6. Report
One short message:
- **Green / amber / red** overall, then a line per area (engine tests, build, website tests, live health, errors).
- Every red item: what failed, the likely cause, and the fix proposed — don't fix production without Papa's go.
- Separate "the system ran correctly" from "the strategies make money" (no P&L judgement here).

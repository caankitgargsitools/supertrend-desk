---
name: deploy-engine
description: Release the AnkGenie engine (Supabase edge function "engine") safely — tests, build check, push, deploy the one-line wrapper pinned to the exact commit, then confirm the engine answers. Use whenever engine code under supabase/functions/engine changed and should go live.
---

# Deploy the engine

The deployed function is a one-line wrapper importing this repo's raw `index.ts` at a pinned commit (CLAUDE.md,
"Backend"). Never deploy an unpushed commit, and never a commit whose tests fail.

1. **Tests** — every engine test must pass:
   ```bash
   cd tests/sim && node build.mjs >/dev/null && node build_all.mjs >/dev/null
   for f in *.test.mjs; do timeout 300 node "$f" >/dev/null 2>&1 || echo "FAIL $f"; done
   ```
   Any FAIL → stop and fix (or report to Papa); don't deploy.
2. **Build check**:
   ```bash
   cd supabase/functions/engine && npx esbuild index.ts --bundle --format=esm --platform=neutral "--external:npm:*" --outfile=/dev/null
   ```
3. **Database first**: if the change needs new columns / functions, apply the migration (Supabase MCP
   `apply_migration`) and add its note file in `supabase/migrations/` *before* deploying code that uses it.
4. **Commit and push** (commit message ends with the attribution lines CLAUDE.md asks for) to the working branch and
   to `main` (fast-forward only: `git fetch origin main && git merge-base --is-ancestor origin/main HEAD`).
   Note the full SHA: `git rev-parse HEAD`.
5. **Deploy** with the Supabase MCP `deploy_edge_function`: project `umryzxusbdttbcshkajt`, name `engine`,
   entrypoint `index.ts`, **verify_jwt false**, one file `index.ts` containing exactly:
   ```ts
   import "https://raw.githubusercontent.com/caankitgargsitools/supertrend-desk/<FULL SHA>/supabase/functions/engine/index.ts";
   ```
6. **Confirm it answers**: `select public.engine_call('combos', null);` then read
   `select status_code, left(content, 200) from net._http_response where id = <returned id>;` — expect 200 and a JSON
   body (a 503 "SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED" is Supabase's side: try once more after a minute).
   For a change to the minute tick or prices, also check the next tick's replies within 2 minutes during market hours.
7. **Tell Papa** the version number the deploy returned, the commit, and what changed — in plain words.

Rollback: deploy the wrapper again with the previous good SHA (find it with `git log` or the last deploy note).

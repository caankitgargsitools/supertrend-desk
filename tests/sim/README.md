# Engine tests (Node, no network, no real database)

    cd tests/sim && npm install
    node build.mjs && node sim.test.mjs      # orders, stops, Delta, live test, per-second stops
    node build_all.mjs
    node q.test.mjs && node rules.test.mjs && node audit.test.mjs && node dhan.test.mjs

`fakesb.mjs` is an in-memory stand-in for supabase-js; `sim.test.mjs` also simulates Dhan's order API.
Never test against the real database with test rows.

UI checks (`tests/ui/*.mjs`) use Playwright with mocked Supabase responses: serve the repo root with
`python3 -m http.server 8765` and run `node tests/ui/ui_audit.mjs`.

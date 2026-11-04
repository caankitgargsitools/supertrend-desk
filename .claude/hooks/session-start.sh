#!/bin/bash
# Cloud sessions (Papa's go, 4 Nov 2026, pending item 9): get the test tools ready so engine and website tests run.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
# Engine tests: esbuild (tests/sim/package.json; npm install is safe to repeat and uses the cache).
(cd tests/sim && npm install --no-audit --no-fund --silent)
# Website tests: the pre-installed Playwright, linked once.
if [ ! -e tests/ui/node_modules ]; then ln -s "$(npm root -g)" tests/ui/node_modules; fi

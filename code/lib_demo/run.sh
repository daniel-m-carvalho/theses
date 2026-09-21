#!/usr/bin/env bash
#
# One-command launcher for the phylogenetic tree viewer demo.
#
#   ./run.sh          install (if needed) and start the dev server
#   ./run.sh test     run the test suite and the type checker instead
#
# Everything it does can also be done by hand — see RUNNING.md. This only adds
# the checks that turn a confusing failure into a clear message.

set -euo pipefail

# Run from the npm WORKSPACE ROOT (code/), regardless of where the script was
# invoked from. Installing from the demo directory alone would not link the
# sibling library package, so this must be the parent of lib_demo.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# --- 1. Node ---------------------------------------------------------------
# Vite 8 requires ^20.19 || >=22.12, and Node 21.x / 22.0-22.11 are NOT
# supported. Checking here turns an obscure syntax error deep in a dependency
# into an actionable message.
if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed."
  echo "Install Node 22 LTS or newer from https://nodejs.org (or: brew install node)."
  exit 1
fi

node_version=$(node -v)            # e.g. v22.14.0
version_number=${node_version#v}
major=${version_number%%.*}
rest=${version_number#*.}
minor=${rest%%.*}

node_ok=false
if   [ "$major" -ge 23 ]; then node_ok=true
elif [ "$major" -eq 22 ] && [ "$minor" -ge 12 ]; then node_ok=true
elif [ "$major" -eq 20 ] && [ "$minor" -ge 19 ]; then node_ok=true
fi

if [ "$node_ok" != true ]; then
  red "Node $node_version is too old (or an unsupported line) for Vite 8."
  echo "Required: 20.19+, or 22.12+, or 23 and newer. Node 21.x is not supported."
  echo "Install Node 22 LTS or newer from https://nodejs.org"
  exit 1
fi

# --- 2. Dependencies -------------------------------------------------------
if [ ! -d node_modules ]; then
  bold "Installing dependencies for both workspace packages (one-off, ~30s)…"
  # A cache directory owned by root — usually left behind by an earlier
  # `sudo npm install` — makes npm fail with EEXIST/EACCES. Retrying against a
  # scratch cache sidesteps it without needing a password.
  if ! npm install; then
    red "npm install failed. Retrying with a temporary cache directory…"
    npm install --cache "$(mktemp -d)"
  fi
fi

# --- 3. Run -----------------------------------------------------------------
if [ "${1:-}" = "test" ]; then
  bold "Type-checking and running the test suite…"
  exec npm run check
fi

bold "Starting the dev server — open the URL below in a browser (Ctrl+C to stop)."
echo "If port 5173 is busy, Vite will pick the next free one; use whatever it prints."
echo
exec npm start

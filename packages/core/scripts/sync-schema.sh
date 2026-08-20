#!/usr/bin/env bash
# Copies openbindings.schema.json from the local spec checkout into this SDK
# for embedding via JSON import. Run before tagging a release that supports
# a new spec version.
#
# Usage: ./scripts/sync-schema.sh [path-to-spec-repo]
#
# Defaults to ../../../spec relative to this package's root.
set -euo pipefail

cd "$(dirname "$0")/.."

SPEC_DIR="${1:-../../../spec}"
SRC="$SPEC_DIR/openbindings.schema.json"

if [[ ! -f "$SRC" ]]; then
  echo "error: schema not found at $SRC" >&2
  echo "pass the spec repo path as the first argument, e.g.:" >&2
  echo "  $0 /path/to/openbindings/spec" >&2
  exit 1
fi

cp "$SRC" src/openbindings.schema.json
echo "synced src/openbindings.schema.json from $SRC"

#!/bin/sh
set -eu

BUNDLED_ROOT="/app/bundled-skills/jphr/outputs/japan-frontend-jobs"
RUNTIME_ROOT="${SKILL_OUTPUT_ROOT:-/app/runtime-skills/jphr/outputs/japan-frontend-jobs}"

mkdir -p "$RUNTIME_ROOT"

if [ -d "$BUNDLED_ROOT" ] && [ -z "$(find "$RUNTIME_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null)" ]; then
  cp -R "$BUNDLED_ROOT"/. "$RUNTIME_ROOT"/
fi

export SKILL_OUTPUT_ROOT="$RUNTIME_ROOT"

exec "$@"

#!/usr/bin/env bash
# Thin wrapper kept for old habits: everything lives in kit.mjs.   ./run-all.sh [kit.mjs verify flags]
cd "$(dirname "$0")" && exec node kit.mjs verify --all --human "$@"

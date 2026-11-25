#!/bin/sh
set -eu
case "${1:-}" in
  build) exec node scripts/package-tizen.mjs ;;
  install)
    : "${TV_HOST:?Set TV_HOST}"
    command -v apps2samsung-cli >/dev/null || { echo "apps2samsung-cli is required" >&2; exit 1; }
    apps2samsung-cli sign tizen/HouseholdFrame.unsigned.wgt -o tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
    exec apps2samsung-cli install tizen/HouseholdFrame.wgt --tv "$TV_HOST" --samsung-cert
    ;;
  *) echo "usage: sh scripts/tizen.sh build|install" >&2; exit 1 ;;
esac

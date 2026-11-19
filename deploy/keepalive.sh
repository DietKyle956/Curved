#!/usr/bin/env bash
# Keep the Always Free Curved instance out of Oracle's idle classification.
#
# Oracle reclaims Always Free instances whose CPU 95th percentile stays below
# 20% over a rolling window, measured against the instance's full core count.
# This script burns one core of the two for ten minutes every hour: that is
# roughly 8% of the machine on average, but the burst lifts the 95th
# percentile well above the threshold, so the classifier never sees the host
# as idle and no sustained average is paid for.
#
# Environment:
#   CURVED_KEEPALIVE_SECONDS  Burst length in seconds (default 600).
#   CURVED_KEEPALIVE_CPUS     CPU list for taskset (default 0).
#
# Pinning happens only when taskset is available. The run is deliberately
# nice'd and idle-IO so the request path keeps priority, and timeout's exit
# codes (124 timeout, 143 SIGTERM) count as success.
set -euo pipefail

DURATION=${CURVED_KEEPALIVE_SECONDS:-600}
CPUS=${CURVED_KEEPALIVE_CPUS:-0}

runner=(nice -n 19)
if command -v taskset >/dev/null 2>&1; then
  runner+=(taskset -c "$CPUS")
fi
runner+=(timeout "$DURATION" bash -c 'while :; do :; done')

status=0
"${runner[@]}" || status=$?

case $status in
  0|124|143)
    exit 0
    ;;
  *)
    exit "$status"
    ;;
esac

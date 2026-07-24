#!/bin/sh
# GPUStatusCheck on-host agent: run by a systemd timer every 60s, samples the
# same telemetry as the SSH probe plus new kernel/GPU log events, and appends
# one base64 line per sample to a bounded local spool. The server drains the
# spool over SSH during its normal poll (scripts/agent-drain.sh).
#
# This is the single deliberate exception to the probe's no-disk-write rule,
# so it is paranoid about disk: it skips sampling entirely when free space is
# low, caps the spool by age and total size, and never touches anything
# outside its own directory. Monitoring must never break tenant workloads.
set -u

BASE=${GPUCHECK_AGENT_DIR:-/var/lib/gpucheck-agent}
SPOOL="$BASE/spool"
PROBE=${GPUCHECK_AGENT_PROBE:-/usr/local/bin/gpucheck-probe.sh}
CURSOR="$BASE/kernel.cursor"
MIN_FREE_KB=${GPUCHECK_AGENT_MIN_FREE_KB:-1048576}   # skip sampling below 1 GiB free
MAX_SPOOL_KB=${GPUCHECK_AGENT_MAX_SPOOL_KB:-204800}  # 200 MiB total spool budget
MAX_AGE_DAYS=${GPUCHECK_AGENT_MAX_AGE_DAYS:-7}

mkdir -p "$SPOOL" 2>/dev/null || exit 0

avail_kb=$(df -kP "$BASE" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$avail_kb" ] && [ "$avail_kb" -lt "$MIN_FREE_KB" ] 2>/dev/null; then
    exit 0
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sample=$(sh "$PROBE" "$(hostname 2>/dev/null || echo unknown)" local 0 2>/dev/null)
[ -n "$sample" ] || exit 0

# Kernel/GPU events since the previous sample, with exact event timestamps.
# The cursor file makes each run pick up where the last one stopped; the very
# first run is bounded by tail so an old journal cannot flood the spool.
kernel_events=""
if command -v journalctl >/dev/null 2>&1; then
    kernel_events=$(journalctl -k --cursor-file="$CURSOR" -o short-iso-precise --utc 2>/dev/null \
        | grep -Ei 'Xid|NVRM|fallen off the bus|bus-off|Out of memory|oom-kill' 2>/dev/null \
        | tail -n 200) || true
fi

record=$(printf '%s\nAGENT_KERNEL_EVENTS<<__GPUCHECK_EOF__\n%s\n__GPUCHECK_EOF__\n' "$sample" "$kernel_events")
line=$(printf '%s' "$record" | base64 2>/dev/null | tr -d '\n')
[ -n "$line" ] || exit 0
printf '%s %s\n' "$ts" "$line" >> "$SPOOL/samples-$(date -u +%Y%m%d).log"

find "$SPOOL" -name 'samples-*.log' -mtime +"$MAX_AGE_DAYS" -delete 2>/dev/null || true

total_kb=$(du -sk "$SPOOL" 2>/dev/null | awk '{print $1}')
today="$SPOOL/samples-$(date -u +%Y%m%d).log"
while [ -n "$total_kb" ] && [ "$total_kb" -gt "$MAX_SPOOL_KB" ] 2>/dev/null; do
    oldest=$(ls "$SPOOL"/samples-*.log 2>/dev/null | head -n 1)
    [ -n "$oldest" ] || break
    [ "$oldest" = "$today" ] && break
    rm -f "$oldest"
    total_kb=$(du -sk "$SPOOL" 2>/dev/null | awk '{print $1}')
done

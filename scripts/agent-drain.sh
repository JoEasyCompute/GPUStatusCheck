#!/bin/sh
# GPUStatusCheck spool drain, piped over SSH by the server after a successful
# probe: `ssh <host> sh -s -- <watermark-iso-or-empty> <max-lines>`.
# Prints spool lines strictly newer than the watermark, framed by BEGIN/END
# markers so the server can detect truncated output (a missing END discards
# the batch without advancing the watermark). Read-only on the host: spool
# pruning belongs to the agent, not the drain.
set -u

wm=${1:-}
max=${2:-600}
BASE=${GPUCHECK_AGENT_DIR:-/var/lib/gpucheck-agent}

echo "AGENT_DRAIN=1"
echo "HOST_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ ! -d "$BASE/spool" ]; then
    echo "AGENT_SPOOL=absent"
    exit 0
fi
echo "AGENT_SPOOL=present"
echo "AGENT_VERSION=$(cat "$BASE/VERSION" 2>/dev/null)"
echo "AGENT_LINES_BEGIN"
# ISO-8601 UTC timestamps compare correctly as strings; day files are already
# in filename (= chronological) order.
cat "$BASE"/spool/samples-*.log 2>/dev/null \
    | awk -v wm="$wm" 'wm == "" || $1 > wm' \
    | head -n "$max"
echo "AGENT_LINES_END"

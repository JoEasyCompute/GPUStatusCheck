#!/bin/sh
# Remote GPU probe script, shared by gpu_status_check.py and the Node
# dashboard server (src/server/probe.ts). Both pipe this file to
# `ssh <host> sh -s -- <name> <ip> <check_logs>`.
set -u

machine_name=${1:-unknown}
machine_ip=${2:-unknown}
check_logs=${3:-1}
remote_host=$(hostname 2>/dev/null || echo unknown)
uptime_pretty=$(uptime -p 2>/dev/null || uptime 2>/dev/null || echo unknown)

tmp_out=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_out.%s' "$$")
tmp_err=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_err.%s' "$$")
tmp_log=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_log.%s' "$$")
tmp_pmon=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_pmon.%s' "$$")
tmp_telemetry=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_telemetry.%s' "$$")
tmp_ps=$(mktemp 2>/dev/null || printf '/tmp/gpucheck_ps.%s' "$$")
trap 'rm -f "$tmp_out" "$tmp_err" "$tmp_log" "$tmp_pmon" "$tmp_telemetry" "$tmp_ps"' EXIT INT TERM

nvidia_rc=127
if command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi -L >"$tmp_out" 2>"$tmp_err"; then
        nvidia_rc=0
    else
        nvidia_rc=$?
    fi
else
    printf '%s\n' "nvidia-smi not found" >"$tmp_err"
fi

gpu_count=0
if [ -s "$tmp_out" ]; then
    gpu_count=$(grep -c '^GPU ' "$tmp_out" 2>/dev/null || printf '0')
fi

gpu_type=""
if [ -s "$tmp_out" ]; then
    gpu_type=$(awk '
        /^GPU / {
            line = $0
            sub(/^GPU [0-9]+: /, "", line)
            sub(/ \(UUID:.*/, "", line)
            print line
            exit
        }
    ' "$tmp_out")
fi

gpu_jobs=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi pmon -c 1 >"$tmp_pmon" 2>/dev/null || true
    gpu_jobs=$(awk -v count="$gpu_count" '
        BEGIN { for (idx = 0; idx < count; idx++) busy[idx] = 0 }
        $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { busy[$1] = 1 }
        END { for (idx = 0; idx < count; idx++) printf "%s", busy[idx] ? "D" : "x" }
    ' "$tmp_pmon")
    pids=$(awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $2}' "$tmp_pmon" | sort -u | paste -sd, -)
    if [ -n "$pids" ] && command -v ps >/dev/null 2>&1; then
        ps -p "$pids" -o pid=,user=,etime=,comm=,args= >"$tmp_ps" 2>/dev/null || true
    fi
fi

gpu_power_w=""
gpu_avg_temp_c=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    if nvidia-smi --query-gpu=index,pci.bus_id,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.graphics,clocks.current.memory --format=csv,noheader,nounits >"$tmp_telemetry" 2>/dev/null; then
        telemetry=$(awk -F',' '
            function trim(value) { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); return value }
            {
                power = trim($6); temp = trim($5)
                if (power ~ /^[0-9]+([.][0-9]+)?$/) { power_total += power; power_seen = 1 }
                if (temp ~ /^[0-9]+([.][0-9]+)?$/) { temp_total += temp; temp_count += 1 }
            }
            END {
                if (power_seen) printf "%.1f", power_total
                printf "|"
                if (temp_count > 0) printf "%.1f", temp_total / temp_count
            }
        ' "$tmp_telemetry")
        gpu_power_w=${telemetry%%|*}
        gpu_avg_temp_c=${telemetry#*|}
    fi
fi

if [ "$check_logs" = "1" ]; then
    if command -v journalctl >/dev/null 2>&1; then
        journalctl -k -b --no-pager -n 500 >"$tmp_log" 2>/dev/null || true
    elif command -v dmesg >/dev/null 2>&1; then
        dmesg >"$tmp_log" 2>/dev/null || true
    else
        : >"$tmp_log"
    fi
else
    : >"$tmp_log"
fi

kernel_hits=$(grep -Ei 'fallen off the bus|Xid.*79|NVRM: Xid|NVRM.*fallen off the bus|GPU has fallen off the bus' "$tmp_log" 2>/dev/null || true)

echo "MACHINE_NAME=$machine_name"
echo "MACHINE_IP=$machine_ip"
echo "REMOTE_HOST=$remote_host"
echo "UPTIME_PRETTY=$uptime_pretty"
echo "NVIDIA_SMI_RC=$nvidia_rc"
echo "GPU_COUNT=$gpu_count"
echo "GPU_TYPE=$gpu_type"
echo "GPU_JOBS=$gpu_jobs"
echo "GPU_POWER_W=$gpu_power_w"
echo "GPU_AVG_TEMP_C=$gpu_avg_temp_c"
if [ -n "$kernel_hits" ]; then echo "BUS_OFF=1"; else echo "BUS_OFF=0"; fi

printf 'NVIDIA_SMI_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_out" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'NVIDIA_SMI_ERROR<<__GPUCHECK_EOF__\n'
cat "$tmp_err" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'KERNEL_HITS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$kernel_hits" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'GPU_METRICS<<__GPUCHECK_EOF__\n'
cat "$tmp_telemetry" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'PMON_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_pmon" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'
printf 'PS_OUTPUT<<__GPUCHECK_EOF__\n'
cat "$tmp_ps" 2>/dev/null || true
printf '\n__GPUCHECK_EOF__\n'

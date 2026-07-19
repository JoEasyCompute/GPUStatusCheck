#!/bin/sh
# Remote GPU probe script, shared by gpu_status_check.py and the Node
# dashboard server (src/server/probe.ts). Both pipe this file to
# `ssh <host> sh -s -- <name> <ip> <check_logs>`.
#
# All command output is captured in shell variables rather than temp files:
# on a host with a full disk, temp-file writes fail silently and the probe
# would misreport healthy GPUs as missing.
set -u

machine_name=${1:-unknown}
machine_ip=${2:-unknown}
check_logs=${3:-1}
remote_host=$(hostname 2>/dev/null || echo unknown)
uptime_pretty=$(uptime -p 2>/dev/null || uptime 2>/dev/null || echo unknown)

nvidia_rc=127
smi_out=""
smi_err=""
if command -v nvidia-smi >/dev/null 2>&1; then
    smi_out=$(nvidia-smi -L 2>/dev/null)
    nvidia_rc=$?
    if [ "$nvidia_rc" -ne 0 ]; then
        smi_err=$(nvidia-smi -L 2>&1 1>/dev/null) || true
    fi
else
    smi_err="nvidia-smi not found"
fi

gpu_count=0
if [ -n "$smi_out" ]; then
    gpu_count=$(printf '%s\n' "$smi_out" | grep -c '^GPU ' 2>/dev/null || printf '0')
fi

gpu_type=""
if [ -n "$smi_out" ]; then
    gpu_type=$(printf '%s\n' "$smi_out" | awk '
        /^GPU / {
            line = $0
            sub(/^GPU [0-9]+: /, "", line)
            sub(/ \(UUID:.*/, "", line)
            print line
            exit
        }
    ')
fi

gpu_jobs=""
pmon_out=""
ps_out=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    pmon_out=$(nvidia-smi pmon -c 1 2>/dev/null) || true
    gpu_jobs=$(printf '%s\n' "$pmon_out" | awk -v count="$gpu_count" '
        BEGIN { for (idx = 0; idx < count; idx++) busy[idx] = 0 }
        $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { busy[$1] = 1 }
        END { for (idx = 0; idx < count; idx++) printf "%s", busy[idx] ? "D" : "x" }
    ')
    pids=$(printf '%s\n' "$pmon_out" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $2}' | sort -u | paste -sd, -)
    if [ -n "$pids" ] && command -v ps >/dev/null 2>&1; then
        ps_out=$(ps -p "$pids" -o pid=,user=,etime=,comm=,args= 2>/dev/null) || true
    fi
fi

gpu_power_w=""
gpu_avg_temp_c=""
telemetry_out=""
if [ "$gpu_count" -gt 0 ] 2>/dev/null && command -v nvidia-smi >/dev/null 2>&1; then
    if telemetry_out=$(nvidia-smi --query-gpu=index,pci.bus_id,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.graphics,clocks.current.memory --format=csv,noheader,nounits 2>/dev/null); then
        telemetry=$(printf '%s\n' "$telemetry_out" | awk -F',' '
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
        ')
        gpu_power_w=${telemetry%%|*}
        gpu_avg_temp_c=${telemetry#*|}
    else
        telemetry_out=""
    fi
fi

# Network throughput: two /proc/net/dev samples one second apart, summing
# physical interfaces (en*/eth*/ib*/wl*) so loopback, docker bridges, veth
# pairs, and bond masters do not double-count traffic.
net_rx_bps=""
net_tx_bps=""
if [ -r /proc/net/dev ]; then
    net_sample1=$(cat /proc/net/dev 2>/dev/null)
    sleep 1
    net_sample2=$(cat /proc/net/dev 2>/dev/null)
    net_rates=$(printf '%s\n=====SPLIT=====\n%s\n' "$net_sample1" "$net_sample2" | awk '
        /^=====SPLIT=====$/ { second = 1; next }
        {
            ci = index($0, ":")
            if (ci == 0) next
            name = substr($0, 1, ci - 1)
            gsub(/[ \t]/, "", name)
            if (name !~ /^(en|eth|ib|wl)/) next
            split(substr($0, ci + 1), f, " ")
            if (second) { rx2 += f[1]; tx2 += f[9]; seen2 = 1 } else { rx1 += f[1]; tx1 += f[9]; seen1 = 1 }
        }
        END {
            if (seen1 && seen2 && rx2 >= rx1) printf "%.0f", rx2 - rx1
            printf "|"
            if (seen1 && seen2 && tx2 >= tx1) printf "%.0f", tx2 - tx1
        }')
    net_rx_bps=${net_rates%%|*}
    net_tx_bps=${net_rates#*|}
fi

kernel_log=""
if [ "$check_logs" = "1" ]; then
    if command -v journalctl >/dev/null 2>&1; then
        kernel_log=$(journalctl -k -b --no-pager -n 500 2>/dev/null) || true
    elif command -v dmesg >/dev/null 2>&1; then
        kernel_log=$(dmesg 2>/dev/null | tail -n 500) || true
    fi
fi

kernel_hits=""
if [ -n "$kernel_log" ]; then
    kernel_hits=$(printf '%s\n' "$kernel_log" | grep -Ei 'fallen off the bus|Xid.*79|NVRM: Xid|NVRM.*fallen off the bus|GPU has fallen off the bus' 2>/dev/null || true)
fi

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
echo "NET_RX_BPS=$net_rx_bps"
echo "NET_TX_BPS=$net_tx_bps"
if [ -n "$kernel_hits" ]; then echo "BUS_OFF=1"; else echo "BUS_OFF=0"; fi

printf 'NVIDIA_SMI_OUTPUT<<__GPUCHECK_EOF__\n'
printf '%s\n' "$smi_out"
printf '\n__GPUCHECK_EOF__\n'
printf 'NVIDIA_SMI_ERROR<<__GPUCHECK_EOF__\n'
printf '%s\n' "$smi_err"
printf '\n__GPUCHECK_EOF__\n'
printf 'KERNEL_HITS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$kernel_hits"
printf '\n__GPUCHECK_EOF__\n'
printf 'GPU_METRICS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$telemetry_out"
printf '\n__GPUCHECK_EOF__\n'
printf 'PMON_OUTPUT<<__GPUCHECK_EOF__\n'
printf '%s\n' "$pmon_out"
printf '\n__GPUCHECK_EOF__\n'
printf 'PS_OUTPUT<<__GPUCHECK_EOF__\n'
printf '%s\n' "$ps_out"
printf '\n__GPUCHECK_EOF__\n'

#!/bin/sh
# Remote GPU probe script, shared by gpu_status_check.py and the Node
# dashboard server (src/server/probe.ts). Both pipe this file to
# `ssh <host> sh -s -- <name> <ip> <check_logs> <node_readings>`.
#
# All command output is captured in shell variables rather than temp files:
# on a host with a full disk, temp-file writes fail silently and the probe
# would misreport healthy GPUs as missing.
set -u

machine_name=${1:-unknown}
machine_ip=${2:-unknown}
check_logs=${3:-1}
node_readings=${4:-0}
remote_host=$(hostname 2>/dev/null || echo unknown)

# Read-only presence check for the optional on-host agent; hosts without it
# behave exactly as before. The agent (scripts/agent/) is the one deliberate,
# guarded exception to this script's no-disk-write rule.
agent_version=""
[ -r /var/lib/gpucheck-agent/VERSION ] && agent_version=$(cat /var/lib/gpucheck-agent/VERSION 2>/dev/null)
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
    if telemetry_out=$(nvidia-smi --query-gpu=index,pci.bus_id,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,uuid --format=csv,noheader,nounits 2>/dev/null); then
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

# Linux uses at least four domain digits in its PCI sysfs names. NVIDIA may
# print additional leading zeroes. Reuse the GPU IDs from the telemetry query.
pcie_links=""
if [ "$node_readings" = "1" ] && [ -n "$telemetry_out" ]; then
    pcie_devices=$(printf '%s\n' "$telemetry_out" | awk -F, '
        {
            gsub(/[[:space:]]/, "", $1)
            gsub(/[[:space:]]/, "", $2)
            split(tolower($2), bdf, ":")
            domain = bdf[1]
            while (length(domain) > 4 && substr(domain, 1, 1) == "0") domain = substr(domain, 2)
            if ($1 ~ /^[0-9]+$/ && domain ~ /^[0-9a-f]+$/ &&
                bdf[2] ~ /^[0-9a-f][0-9a-f]$/ && bdf[3] ~ /^[0-9a-f][0-9a-f]\.[0-7]$/)
                print $1, domain ":" bdf[2] ":" bdf[3]
        }')
    pcie_links=$(while read -r gpu_index pci_device; do
        [ -n "$pci_device" ] || continue
        pci_path=/sys/bus/pci/devices/$pci_device
        current_speed=$(cat "$pci_path/current_link_speed" 2>/dev/null) || current_speed=""
        max_speed=$(cat "$pci_path/max_link_speed" 2>/dev/null) || max_speed=""
        current_width=$(cat "$pci_path/current_link_width" 2>/dev/null) || current_width=""
        max_width=$(cat "$pci_path/max_link_width" 2>/dev/null) || max_width=""
        printf '%s|%s|%s|%s|%s\n' "$gpu_index" "$current_speed" "$max_speed" "$current_width" "$max_width"
    done <<EOF
$pcie_devices
EOF
    )
fi

# Network throughput and CPU utilization share one 1-second sampling window:
# /proc/net/dev and /proc/stat are both read before and after the same sleep.
# Physical interfaces only (en*/eth*/ib*/wl*) so loopback, docker bridges,
# veth pairs, and bond masters do not double-count traffic.
net_rx_bps=""
net_tx_bps=""
cpu_util_pct=""
net_sample1=""
net_sample2=""
cpu_sample1=""
cpu_sample2=""
[ -r /proc/net/dev ] && net_sample1=$(cat /proc/net/dev 2>/dev/null)
[ -r /proc/stat ] && cpu_sample1=$(grep '^cpu ' /proc/stat 2>/dev/null)
if [ -n "$net_sample1" ] || [ -n "$cpu_sample1" ]; then
    sleep 1
    [ -n "$net_sample1" ] && net_sample2=$(cat /proc/net/dev 2>/dev/null)
    [ -n "$cpu_sample1" ] && cpu_sample2=$(grep '^cpu ' /proc/stat 2>/dev/null)
fi
if [ -n "$net_sample1" ] && [ -n "$net_sample2" ]; then
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

# CPU busy% from the /proc/stat "cpu" aggregate line deltas
# (idle = idle + iowait, columns 5 and 6 after the "cpu" label).
if [ -n "$cpu_sample1" ] && [ -n "$cpu_sample2" ]; then
    cpu_util_pct=$(printf '%s\n%s\n' "$cpu_sample1" "$cpu_sample2" | awk '
        NR == 1 { for (i = 2; i <= NF; i++) total1 += $i; idle1 = $5 + $6 }
        NR == 2 { for (i = 2; i <= NF; i++) total2 += $i; idle2 = $5 + $6 }
        END {
            dt = total2 - total1
            if (dt > 0) {
                busy = (dt - (idle2 - idle1)) / dt * 100
                if (busy < 0) busy = 0
                if (busy > 100) busy = 100
                printf "%.1f", busy
            }
        }')
fi

# Interface identity follows the same interface-name filter used for the
# aggregate network rates above, so each row explains which links contribute.
network_interfaces=""
egress_deadline=0
if [ "$node_readings" = "1" ] && command -v curl >/dev/null 2>&1; then
    egress_start=$(date +%s)
    if [ -n "$egress_start" ]; then egress_deadline=$((egress_start + 8)); fi
fi
for iface_path in /sys/class/net/*; do
    [ -d "$iface_path" ] || continue
    iface=${iface_path##*/}
    case "$iface" in en*|eth*|ib*|wl*) ;; *) continue ;; esac
    mac_address=$(cat "$iface_path/address" 2>/dev/null) || mac_address=""
    [ -n "$mac_address" ] || continue
    iface_state=$(cat "$iface_path/operstate" 2>/dev/null) || iface_state="unknown"
    iface_addresses=""
    if command -v ip >/dev/null 2>&1; then
        iface_addresses=$(ip -o addr show dev "$iface" 2>/dev/null | awk '{
            if ($4 != "") {
                if (addresses != "") addresses = addresses ","
                addresses = addresses $4
            }
        } END { print addresses }') || iface_addresses=""
    fi
    public_ipv4=""
    # Limit lookups to interfaces with an IPv4 address and bound both each
    # request and the time spent on nodes with many interfaces.
    case "$iface_addresses" in
        *.*.*.*/*)
            if [ "$egress_deadline" -gt 0 ] && [ "$(date +%s)" -lt "$egress_deadline" ]; then
                egress_response=$(curl -q -4fsS --noproxy '*' --max-time 2 --max-filesize 64 \
                    --interface "if!$iface" https://ifconfig.me/ip 2>/dev/null) || egress_response=""
                public_ipv4=$(printf '%s\n' "$egress_response" | awk '
                    NR == 1 && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { address = $0 }
                    END { if (NR == 1) print address }')
            fi ;;
    esac
    interface_row="$iface|$mac_address|$iface_addresses|$iface_state|$public_ipv4"
    for metric in speed statistics/rx_errors statistics/tx_errors statistics/rx_dropped statistics/tx_dropped; do
        metric_value=""
        if [ -r "$iface_path/$metric" ]; then
            IFS= read -r metric_value 2>/dev/null < "$iface_path/$metric" || metric_value=""
        fi
        interface_row="$interface_row|$metric_value"
    done
    if [ -n "$network_interfaces" ]; then network_interfaces="$network_interfaces
$interface_row"; else network_interfaces=$interface_row; fi
done

# Best-effort in-band read of the BMC's first configured IPMI LAN channel.
# Many SSH poll users cannot access /dev/ipmi0, so try the same read-only
# query through non-interactive sudo. The agent runs as root. Failure or
# missing tooling must not affect the host probe.
bmc_ip_address=""
extract_bmc_ip() {
    printf '%s\n' "$1" | awk -F: '
        /^[[:space:]]*IP Address[[:space:]]*:/ {
            value = $2
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
            print value
            exit
        }'
}

if command -v ipmitool >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
    bmc_output=""
    bmc_output=$(timeout 3 ipmitool -I open lan print 2>/dev/null) || bmc_output=""
    bmc_ip_address=$(extract_bmc_ip "$bmc_output")
    if [ -z "$bmc_ip_address" ] && command -v sudo >/dev/null 2>&1; then
        bmc_output=$(timeout 3 sudo -n ipmitool -I open lan print 2>/dev/null) || bmc_output=""
        bmc_ip_address=$(extract_bmc_ip "$bmc_output")
    fi
    case "$bmc_ip_address" in
        0.0.0.0|255.255.255.255) bmc_ip_address="" ;;
    esac
fi

iommu_status=""
ipmi_power_w=""
bmc_sensors=""
if [ "$node_readings" = "1" ]; then
    iommu_status="unknown"
    if [ -r /sys/kernel/iommu_groups ] && [ -x /sys/kernel/iommu_groups ]; then
        iommu_status="inactive"
        for iommu_group in /sys/kernel/iommu_groups/*; do
            [ -d "$iommu_group" ] || continue
            iommu_status="enabled"
            break
        done
    fi
    if command -v ipmitool >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
        power_output=$(LC_ALL=C timeout 3 ipmitool -I open dcmi power reading 2>/dev/null) || power_output=""
        if [ -z "$power_output" ] && command -v sudo >/dev/null 2>&1; then
            power_output=$(LC_ALL=C timeout 3 sudo -n ipmitool -I open dcmi power reading 2>/dev/null) || power_output=""
        fi
        ipmi_power_w=$(printf '%s\n' "$power_output" | awk '
            /^[[:space:]]*Instantaneous power reading[[:space:]]*:/ {
                sub(/^[^:]*:[[:space:]]*/, "")
                if ($1 ~ /^[0-9]+([.][0-9]+)?$/ && $2 == "Watts") watts = $1
            }
            /Power Measurement[[:space:]]*:/ && !/:[[:space:]]*Active[[:space:]]*$/ { inactive = 1 }
            END { if (!inactive) print watts }')
        bmc_sensors=$(LC_ALL=C timeout 5 ipmitool -I open sdr elist 2>/dev/null)
        sensor_status=$?
        # A timeout can still produce usable complete rows. Only retry on
        # immediate command failure without readings (e.g. device permissions).
        if [ -z "$bmc_sensors" ] && [ "$sensor_status" -ne 0 ] && [ "$sensor_status" -ne 124 ] && command -v sudo >/dev/null 2>&1; then
            bmc_sensors=$(LC_ALL=C timeout 5 sudo -n ipmitool -I open sdr elist 2>/dev/null) || true
        fi
    fi
fi

cpu_model=""
cpu_cores=""
if [ -r /proc/cpuinfo ]; then
    cpu_model=$(awk -F': ' '/^model name/ { print $2; exit }' /proc/cpuinfo 2>/dev/null)
    cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null) || cpu_cores=""
fi
if [ -z "$cpu_model" ] && command -v lscpu >/dev/null 2>&1; then
    cpu_model=$(lscpu 2>/dev/null | awk -F': *' '/^Model name/ { print $2; exit }')
fi
if [ -z "$cpu_cores" ] && command -v nproc >/dev/null 2>&1; then
    cpu_cores=$(nproc 2>/dev/null) || cpu_cores=""
fi

mem_total_kb=""
mem_used_pct=""
if [ -r /proc/meminfo ]; then
    mem_stats=$(awk '
        /^MemTotal:/ { total = $2 }
        /^MemAvailable:/ { avail = $2; seen_avail = 1 }
        END {
            if (total > 0) {
                printf "%s|", total
                if (seen_avail) printf "%.1f", (total - avail) / total * 100
            } else printf "|"
        }' /proc/meminfo 2>/dev/null)
    mem_total_kb=${mem_stats%%|*}
    mem_used_pct=${mem_stats#*|}
fi

disk_total_kb=""
disk_used_pct=""
if command -v df >/dev/null 2>&1; then
    disk_stats=$(df -kP / 2>/dev/null | awk 'NR == 2 { pct = $5; sub(/%/, "", pct); printf "%s|%s", $2, pct }')
    disk_total_kb=${disk_stats%%|*}
    disk_used_pct=${disk_stats#*|}
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
echo "CPU_MODEL=$cpu_model"
echo "CPU_CORES=$cpu_cores"
echo "CPU_UTIL_PCT=$cpu_util_pct"
echo "MEM_TOTAL_KB=$mem_total_kb"
echo "MEM_USED_PCT=$mem_used_pct"
echo "DISK_TOTAL_KB=$disk_total_kb"
echo "DISK_USED_PCT=$disk_used_pct"
echo "AGENT_VERSION=$agent_version"
echo "BMC_IP_ADDRESS=$bmc_ip_address"
echo "IOMMU_STATUS=$iommu_status"
echo "IPMI_POWER_W=$ipmi_power_w"
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
printf 'GPU_PCIE_LINKS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$pcie_links"
printf '\n__GPUCHECK_EOF__\n'
printf 'PMON_OUTPUT<<__GPUCHECK_EOF__\n'
printf '%s\n' "$pmon_out"
printf '\n__GPUCHECK_EOF__\n'
printf 'PS_OUTPUT<<__GPUCHECK_EOF__\n'
printf '%s\n' "$ps_out"
printf '\n__GPUCHECK_EOF__\n'
printf 'BMC_SENSORS<<__GPUCHECK_EOF__\n'
printf '%s\n' "$bmc_sensors"
printf '__GPUCHECK_EOF__\n'

printf 'NETWORK_INTERFACES<<__GPUCHECK_EOF__\n'
printf '%s\n' "$network_interfaces"
printf '\n__GPUCHECK_EOF__\n'

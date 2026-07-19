#!/usr/bin/env python3
"""Probe a list of machines over SSH and summarize GPU health.

Expected input format:
    machines.csv with a headered inventory such as:
        name,ip,platform,owner,commission_date

Config can be provided via .env in the repo root or environment variables.

Supported config keys:
    GPUCHECK_USER=ezc
    GPUCHECK_KEY=~/.ssh/EZC-HydraHost
    GPUCHECK_TIMEOUT=10
    GPUCHECK_JOBS=8

The probe checks:
    1) SSH connectivity/authentication
    2) Whether nvidia-smi can talk to the driver
    3) Which GPUs currently have active process rows
    4) Total GPU power consumption and average GPU temperature at check time
    5) Whether the remote logs mention GPU "fallen off the bus" patterns
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, TextIO, Tuple


DEFAULT_USER = "ezc"
DEFAULT_KEY = "~/.ssh/EZC-HydraHost"
DEFAULT_TIMEOUT = 10
DEFAULT_PROBE_TIMEOUT = 60
DEFAULT_JOBS = 8
DEFAULT_STATE_FILE = ".omx/gpucheck-state.json"

BUS_OFF_PATTERNS = [
    r"fallen off the bus",
    r"\bXid\b.*\b79\b",
    r"NVRM:\s*Xid",
    r"NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver",
    r"NVML:\s*Unknown Error",
    r"No devices were found",
]


@dataclass
class Machine:
    name: str
    ip: str
    platform: str = ""
    owner: str = ""
    commission_date: str = ""
    location: str = ""
    uptime: str = ""


@dataclass
class ProbeResult:
    name: str
    ip: str
    platform: str = ""
    owner: str = ""
    commission_date: str = ""
    location: str = ""
    uptime: str = ""
    ssh_ok: bool = False
    ssh_error: str = ""
    ssh_user: str = ""
    remote_host: str = ""
    nvidia_smi_rc: Optional[int] = None
    gpu_count: Optional[int] = None
    gpu_jobs: str = ""
    gpu_power_w: str = ""
    gpu_avg_temp_c: str = ""
    net_rx_bps: str = ""
    net_tx_bps: str = ""
    bus_off_suspected: bool = False
    bus_off_reason: str = ""
    nvidia_smi_output: str = ""
    nvidia_smi_error: str = ""
    kernel_hits: str = ""
    status: str = "unknown"


@dataclass
class AlertState:
    machines: Dict[str, str]
    updated_at: str


def iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if (
            len(value) >= 2
            and value[0] == value[-1]
            and value[0] in {"'", '"'}
        ):
            value = value[1:-1]
        values[key] = value
    return values


def resolve_setting(
    name: str,
    env_file: Dict[str, str],
    cli_value: Optional[str],
    default: str,
) -> str:
    if cli_value is not None:
        return cli_value
    if name in os.environ and os.environ[name]:
        return os.environ[name]
    if name in env_file and env_file[name]:
        return env_file[name]
    return default


def load_json_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return {}


def write_json_file(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def load_alert_state(path: Path) -> AlertState:
    raw = load_json_file(path)
    machines = raw.get("machines") if isinstance(raw.get("machines"), dict) else {}
    machines = {str(k): str(v) for k, v in machines.items()}
    updated_at = str(raw.get("updated_at") or "")
    return AlertState(machines=machines, updated_at=updated_at)


def save_alert_state(path: Path, state: AlertState) -> None:
    write_json_file(
        path,
        {
            "machines": state.machines,
            "updated_at": state.updated_at,
        },
    )


def _normalize_header_name(name: str) -> str:
    return re.sub(r"[\s-]+", "_", name.strip().casefold())


def _first_header_value(
    row: List[str],
    header_map: Dict[str, int],
    *candidates: str,
) -> str:
    for candidate in candidates:
        idx = header_map.get(_normalize_header_name(candidate))
        if idx is not None and idx < len(row):
            return row[idx].strip()
    return ""


def read_machines(csv_path: Path) -> List[Machine]:
    machines: List[Machine] = []
    with csv_path.open(newline="") as fh:
        reader = csv.reader(fh)
        rows = []
        for raw_row in reader:
            if not raw_row:
                continue
            row = [cell.strip() for cell in raw_row]
            if len(row) == 1 and row[0].startswith("#"):
                continue
            if row and row[0].startswith("#"):
                continue
            rows.append(row)

    if not rows:
        return machines

    header_map = {_normalize_header_name(col): idx for idx, col in enumerate(rows[0])}
    has_header = any(
        key in header_map for key in {"name", "hostname", "host"}
    ) and "ip" in header_map

    if has_header:
        for idx, row in enumerate(rows[1:], start=2):
            name = _first_header_value(row, header_map, "name", "hostname", "host")
            ip = _first_header_value(row, header_map, "ip")
            platform = _first_header_value(row, header_map, "platform")
            owner = _first_header_value(row, header_map, "owner")
            commission_date = _first_header_value(
                row,
                header_map,
                "commission_date",
                "commissioned_date",
                "commissioned",
            )
            location = _first_header_value(row, header_map, "location")
            uptime = _first_header_value(row, header_map, "uptime")
            if not name and not ip:
                continue
            if not name or not ip:
                raise ValueError(
                    f"{csv_path}:{idx}: expected name/ip columns in headered CSV, got {row!r}"
                )
            machines.append(
                Machine(
                    name=name,
                    ip=ip,
                    platform=platform,
                    owner=owner,
                    commission_date=commission_date,
                    location=location,
                    uptime=uptime,
                )
            )
        return machines

    for idx, row in enumerate(rows, start=1):
        if len(row) < 2:
            raise ValueError(
                f"{csv_path}:{idx}: expected at least 2 columns (name,ip), got {row!r}"
            )
        name = row[0]
        ip = row[1]
        if not name or not ip:
            continue
        if idx == 1 and name.lower() in {"hostname", "host", "name"} and ip.lower() == "ip":
            continue
        machines.append(Machine(name=name, ip=ip))
    return machines


def _extract_block(text: str, key: str) -> str:
    start = f"{key}<<__GPUCHECK_EOF__"
    end = "__GPUCHECK_EOF__"
    lines = text.splitlines()
    collecting = False
    out: List[str] = []
    for line in lines:
        if collecting:
            if line == end:
                break
            out.append(line)
            continue
        if line == start:
            collecting = True
    return "\n".join(out).strip()


def _extract_scalar(text: str, key: str) -> Optional[str]:
    prefix = f"{key}="
    for line in text.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return None


def _normalize_gpu_jobs(
    gpu_jobs: str,
    gpu_count: Optional[int],
    bus_off_suspected: bool,
) -> str:
    if not bus_off_suspected:
        return gpu_jobs
    width = gpu_count if gpu_count and gpu_count > 0 else len(gpu_jobs)
    return "E" * max(1, width)


def parse_ssh_destination(ip: str) -> Tuple[str, int]:
    match = re.fullmatch(r"(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?", ip.strip())
    if not match:
        return ip, 22

    host = match.group(1)
    raw_port = match.group(2)
    if raw_port is None:
        return host, 22

    port = int(raw_port)
    if not 1 <= port <= 65535:
        raise ValueError(f"invalid SSH port in ip field {ip!r}: {port}")
    return host, port


def send_telegram_message(bot_token: str, chat_id: str, message: str) -> None:
    endpoint = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": message,
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")
    req = urllib.request.Request(endpoint, data=payload, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.URLError as exc:  # noqa: BLE001
        raise RuntimeError(f"telegram send failed: {exc}") from exc


def split_message(message: str, limit: int = 3800) -> List[str]:
    if len(message) <= limit:
        return [message]

    chunks: List[str] = []
    current: List[str] = []
    size = 0
    for line in message.splitlines():
        # A single line longer than the limit (e.g. a huge ssh_error) must be
        # hard-split, or the chunk would exceed Telegram's message size cap.
        parts = [line[i : i + limit] for i in range(0, len(line), limit)] or [""]
        for part in parts:
            addition = len(part) + 1
            if current and size + addition > limit:
                chunks.append("\n".join(current))
                current = [part]
                size = addition
            else:
                current.append(part)
                size += addition
    if current:
        chunks.append("\n".join(current))
    return chunks


def format_progress(done: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return f"[{'-' * width}] 0/0 0%"

    clamped_done = max(0, min(done, total))
    filled = round(width * clamped_done / total)
    percent = round(100 * clamped_done / total)
    return (
        f"[{'#' * filled}{'-' * (width - filled)}] "
        f"{clamped_done}/{total} {percent}%"
    )


def emit_progress(
    done: int,
    total: int,
    machine_name: str,
    status: str,
    stream: TextIO = sys.stderr,
    final: bool = False,
) -> None:
    line = f"{format_progress(done, total)} {machine_name}: {status}"
    if stream.isatty():
        stream.write(f"\r{line}")
        if final:
            stream.write("\n")
    else:
        stream.write(f"{line}\n")
    stream.flush()


def compact_line(result: ProbeResult) -> str:
    reason = result.bus_off_reason or result.ssh_error or "unknown issue"
    if result.status == "ssh_failed":
        return f"• {result.name} ({result.ip}) SSH FAILED: {reason}"
    return f"• {result.name} ({result.ip}) DEGRADED: {reason}"


def compact_recovery_line(result: ProbeResult, previous: str) -> str:
    return f"• {result.name} ({result.ip}) RECOVERED: {previous} → ok"


def summarize_results(results: List[ProbeResult]) -> Tuple[int, int, int]:
    ok = sum(1 for r in results if r.status == "ok")
    degraded = sum(1 for r in results if r.status == "degraded")
    failed = sum(1 for r in results if r.status == "ssh_failed")
    return ok, degraded, failed


def build_alerts(
    results: List[ProbeResult],
    prev_state: AlertState,
    notify_recovery: bool,
) -> Tuple[List[str], AlertState]:
    current_state = AlertState(
        machines={r.name: r.status for r in results},
        updated_at=iso_now(),
    )
    alerts: List[str] = []

    for result in results:
        previous = prev_state.machines.get(result.name)
        if result.status == "ok":
            if notify_recovery and previous in {"degraded", "ssh_failed"}:
                alerts.append(compact_recovery_line(result, previous))
            continue

        if previous != result.status:
            alerts.append(compact_line(result))

    return alerts, current_state


def format_telegram_message(
    alerts: List[str],
    ok: int,
    degraded: int,
    failed: int,
) -> str:
    lines = [
        "GPU status alert",
        f"Summary: ok={ok} degraded={degraded} ssh_failed={failed}",
        "",
    ]
    lines.extend(alerts)
    lines.append("")
    lines.append("Triggered by the latest scheduled check.")
    return "\n".join(lines)


REMOTE_SCRIPT_PATH = Path(__file__).resolve().parent / "scripts" / "remote-probe.sh"
# Shared with the Node dashboard server (src/server/probe.ts); edit the .sh
# file, not an embedded copy.
REMOTE_SCRIPT = REMOTE_SCRIPT_PATH.read_text()


AUTH_FAILURE_RE = re.compile(
    r"permission denied|authentication|publickey|no supported authentication methods",
    re.IGNORECASE,
)


def run_ssh_probe(
    machine: Machine,
    user: str,
    key_path: str,
    timeout: int,
    probe_timeout: int = DEFAULT_PROBE_TIMEOUT,
    check_logs: bool = True,
    fallback_user: str = "",
) -> ProbeResult:
    """Probe as `user`; on an auth-shaped SSH failure retry as `fallback_user`."""
    primary = _run_ssh_probe_as(machine, user, key_path, timeout, probe_timeout, check_logs)
    if primary.status != "ssh_failed":
        return primary
    fallback = fallback_user.strip()
    if not fallback or fallback == user or not AUTH_FAILURE_RE.search(primary.ssh_error):
        return primary
    retried = _run_ssh_probe_as(machine, fallback, key_path, timeout, probe_timeout, check_logs)
    return primary if retried.status == "ssh_failed" else retried


def _run_ssh_probe_as(
    machine: Machine,
    user: str,
    key_path: str,
    timeout: int,
    probe_timeout: int,
    check_logs: bool,
) -> ProbeResult:
    result = ProbeResult(
        name=machine.name,
        ip=machine.ip,
        platform=machine.platform,
        owner=machine.owner,
        commission_date=machine.commission_date,
        location=machine.location,
        uptime=machine.uptime,
        ssh_ok=False,
    )

    expanded_key = str(Path(key_path).expanduser())
    ssh_host, ssh_port = parse_ssh_destination(machine.ip)
    ssh_target = f"{user}@{ssh_host}"
    cmd = [
        "ssh",
        "-i",
        expanded_key,
        "-p",
        str(ssh_port),
        "-o",
        "BatchMode=yes",
        "-o",
        f"ConnectTimeout={timeout}",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        "-o",
        "StrictHostKeyChecking=accept-new",
        ssh_target,
        "sh -s --",
        machine.name,
        machine.ip,
        "1" if check_logs else "0",
    ]

    try:
        proc = subprocess.run(
            cmd,
            input=REMOTE_SCRIPT,
            text=True,
            capture_output=True,
            timeout=probe_timeout,
        )
    except subprocess.TimeoutExpired:
        result.ssh_error = f"probe timed out after {probe_timeout}s"
        result.status = "ssh_failed"
        return result

    if proc.returncode != 0:
        result.ssh_error = (proc.stderr or proc.stdout or "").strip()
        result.status = "ssh_failed"
        return result

    result.ssh_ok = True
    result.ssh_user = user
    stdout = proc.stdout or ""

    result.remote_host = _extract_scalar(stdout, "REMOTE_HOST") or ""
    result.uptime = _extract_scalar(stdout, "UPTIME_PRETTY") or result.uptime
    nvidia_rc = _extract_scalar(stdout, "NVIDIA_SMI_RC")
    gpu_count = _extract_scalar(stdout, "GPU_COUNT")
    gpu_jobs = _extract_scalar(stdout, "GPU_JOBS")
    gpu_power_w = _extract_scalar(stdout, "GPU_POWER_W")
    gpu_avg_temp_c = _extract_scalar(stdout, "GPU_AVG_TEMP_C")
    bus_off = _extract_scalar(stdout, "BUS_OFF")

    result.nvidia_smi_rc = int(nvidia_rc) if nvidia_rc and nvidia_rc.isdigit() else None
    result.gpu_count = int(gpu_count) if gpu_count and gpu_count.isdigit() else None
    result.gpu_jobs = gpu_jobs or ""
    result.gpu_power_w = gpu_power_w or ""
    result.gpu_avg_temp_c = gpu_avg_temp_c or ""
    result.net_rx_bps = _extract_scalar(stdout, "NET_RX_BPS") or ""
    result.net_tx_bps = _extract_scalar(stdout, "NET_TX_BPS") or ""
    result.nvidia_smi_output = _extract_block(stdout, "NVIDIA_SMI_OUTPUT")
    result.nvidia_smi_error = _extract_block(stdout, "NVIDIA_SMI_ERROR")
    result.kernel_hits = _extract_block(stdout, "KERNEL_HITS")
    result.bus_off_suspected = bus_off == "1" or bool(result.kernel_hits)
    result.gpu_jobs = _normalize_gpu_jobs(
        result.gpu_jobs,
        result.gpu_count,
        result.bus_off_suspected,
    )

    reasons: List[str] = []
    if result.bus_off_suspected:
        reasons.append("kernel/log indicators")

    if result.nvidia_smi_rc not in (0, None):
        reasons.append(f"nvidia-smi rc={result.nvidia_smi_rc}")

    err_text = "\n".join(
        x for x in [result.nvidia_smi_error, result.nvidia_smi_output] if x
    )
    if re.search("|".join(BUS_OFF_PATTERNS), err_text, re.IGNORECASE):
        reasons.append("nvidia-smi output matches bus-off patterns")

    if result.nvidia_smi_rc == 0 and (result.gpu_count is not None and result.gpu_count < 1):
        reasons.append("nvidia-smi reported zero GPUs")

    if result.bus_off_suspected or reasons:
        result.status = "degraded"
        result.bus_off_reason = "; ".join(dict.fromkeys(reasons))
    else:
        result.status = "ok"

    return result


def format_table(rows: List[ProbeResult]) -> str:
    headers = [
        "machine",
        "ip",
        "platform",
        "owner",
        "commissioned",
        "uptime",
        "status",
        "gpus",
        "jobs",
        "power_w",
        "temp_c",
        "remote_host",
        "notes",
    ]

    def truncate(value: str, limit: Optional[int]) -> str:
        if limit is None:
            return value
        if len(value) <= limit:
            return value
        return value[: max(0, limit - 1)] + "…"

    caps: Dict[str, Optional[int]] = {
        "machine": 18,
        "ip": None,
        "platform": 12,
        "owner": 14,
        "commissioned": 12,
        "uptime": 24,
        "status": 10,
        "gpus": 4,
        "jobs": 32,
        "power_w": 8,
        "temp_c": 6,
        "remote_host": 18,
        "notes": 60,
    }

    data: List[List[str]] = []
    for row in rows:
        notes = row.bus_off_reason or row.ssh_error
        data.append(
            [
                truncate(row.name or "-", caps["machine"]),
                truncate(row.ip or "-", caps["ip"]),
                truncate(row.platform or "-", caps["platform"]),
                truncate(row.owner or "-", caps["owner"]),
                truncate(row.commission_date or "-", caps["commissioned"]),
                truncate(row.uptime or "-", caps["uptime"]),
                truncate(row.status or "-", caps["status"]),
                truncate("" if row.gpu_count is None else str(row.gpu_count), caps["gpus"]),
                truncate(row.gpu_jobs or "-", caps["jobs"]),
                truncate(row.gpu_power_w or "-", caps["power_w"]),
                truncate(row.gpu_avg_temp_c or "-", caps["temp_c"]),
                truncate(row.remote_host or "-", caps["remote_host"]),
                truncate(notes or "-", caps["notes"]),
            ]
        )

    widths = [len(h) for h in headers]
    for row in data:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], len(cell))

    def fmt_row(cols: Iterable[str]) -> str:
        return "  ".join(col.ljust(widths[idx]) for idx, col in enumerate(cols))

    lines = [fmt_row(headers), fmt_row(["-" * w for w in widths])]
    lines.extend(fmt_row(row) for row in data)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe GPU health over SSH.")
    parser.add_argument("--machines", default="machines.csv", help="CSV file with name,ip rows")
    parser.add_argument("--user", help="SSH username")
    parser.add_argument("--fallback-user", help="Username to retry with on SSH auth failure (default ubuntu; empty disables)")
    parser.add_argument("--key", help="SSH private key path")
    parser.add_argument("--timeout", type=int, help="SSH connect timeout in seconds")
    parser.add_argument(
        "--probe-timeout",
        type=int,
        help="Hard per-host probe timeout in seconds",
    )
    parser.add_argument("--jobs", type=int, help="Maximum concurrent SSH probes")
    parser.add_argument("--json-out", help="Write detailed results to a JSON file")
    parser.add_argument("--telegram-bot-token", help="Telegram bot token")
    parser.add_argument("--telegram-chat-id", help="Telegram chat ID or channel ID")
    parser.add_argument(
        "--state-file",
        help="Path to persisted alert state used to suppress duplicate alerts",
    )
    parser.add_argument(
        "--notify-recovery",
        action="store_true",
        help="Send Telegram messages when a machine recovers",
    )
    parser.add_argument(
        "--skip-logs",
        action="store_true",
        help="Skip kernel log checks for faster live telemetry scans",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Keep running forever with --interval between checks",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=300,
        help="Seconds to sleep between checks in watch mode",
    )
    args = parser.parse_args()

    env_file = load_env_file(Path(".env"))
    user = resolve_setting("GPUCHECK_USER", env_file, args.user, DEFAULT_USER)
    fallback_user = resolve_setting("GPUCHECK_FALLBACK_USER", env_file, args.fallback_user, "ubuntu")
    key = resolve_setting("GPUCHECK_KEY", env_file, args.key, DEFAULT_KEY)
    timeout = int(resolve_setting("GPUCHECK_TIMEOUT", env_file, str(args.timeout) if args.timeout is not None else None, str(DEFAULT_TIMEOUT)))
    probe_timeout = int(resolve_setting("GPUCHECK_PROBE_TIMEOUT", env_file, str(args.probe_timeout) if args.probe_timeout is not None else None, str(DEFAULT_PROBE_TIMEOUT)))
    jobs = int(resolve_setting("GPUCHECK_JOBS", env_file, str(args.jobs) if args.jobs is not None else None, str(DEFAULT_JOBS)))
    telegram_token = resolve_setting(
        "TELEGRAM_BOT_TOKEN",
        env_file,
        args.telegram_bot_token,
        "",
    )
    telegram_chat_id = resolve_setting(
        "TELEGRAM_CHAT_ID",
        env_file,
        args.telegram_chat_id,
        "",
    )
    state_file = Path(
        resolve_setting(
            "GPUCHECK_STATE_FILE",
            env_file,
            args.state_file,
            DEFAULT_STATE_FILE,
        )
    )
    notify_recovery_env = resolve_setting(
        "GPUCHECK_NOTIFY_RECOVERY",
        env_file,
        None,
        "0",
    ).lower()
    notify_recovery = args.notify_recovery or notify_recovery_env in {"1", "true", "yes", "on"}
    skip_logs_env = resolve_setting(
        "GPUCHECK_SKIP_LOGS",
        env_file,
        None,
        "0",
    ).lower()
    check_logs = not (
        args.skip_logs or skip_logs_env in {"1", "true", "yes", "on"}
    )

    machines_path = Path(args.machines)
    if not machines_path.exists():
        print(f"error: missing machines file: {machines_path}", file=sys.stderr)
        return 2

    try:
        machines = read_machines(machines_path)
    except Exception as exc:  # noqa: BLE001
        print(f"error reading {machines_path}: {exc}", file=sys.stderr)
        return 2

    if not machines:
        print(f"error: no machines found in {machines_path}", file=sys.stderr)
        return 2

    def run_cycle() -> Tuple[int, int, int]:
        previous_state = load_alert_state(state_file)
        print(
            f"Probing {len(machines)} machines as {user} using {Path(key).expanduser()}"
        )

        results: List[ProbeResult] = []
        with cf.ThreadPoolExecutor(max_workers=max(1, jobs)) as executor:
            future_map = {
                executor.submit(
                    run_ssh_probe,
                    machine,
                    user,
                    key,
                    timeout,
                    probe_timeout,
                    check_logs,
                    fallback_user,
                ): machine
                for machine in machines
            }
            total = len(future_map)
            completed = 0
            for future in cf.as_completed(future_map):
                machine = future_map[future]
                try:
                    result = future.result()
                except Exception as exc:  # noqa: BLE001
                    result = ProbeResult(
                        name=machine.name,
                        ip=machine.ip,
                        ssh_ok=False,
                        ssh_error=str(exc),
                        status="ssh_failed",
                    )
                results.append(result)
                completed += 1
                emit_progress(
                    completed,
                    total,
                    result.name,
                    result.status,
                    final=completed == total,
                )

        results.sort(key=lambda r: r.name)

        ok, degraded, failed = summarize_results(results)

        print()
        print(format_table(results))
        print()
        print(f"Summary: ok={ok} degraded={degraded} ssh_failed={failed}")

        if args.json_out:
            out_path = Path(args.json_out)
            out_path.write_text(json.dumps([asdict(r) for r in results], indent=2))
            print(f"Wrote JSON report to {out_path}")

        alerts, current_state = build_alerts(results, previous_state, notify_recovery)

        delivery_failed = False
        if telegram_token and telegram_chat_id and alerts:
            message = format_telegram_message(alerts, ok, degraded, failed)
            try:
                for chunk in split_message(message):
                    send_telegram_message(telegram_token, telegram_chat_id, chunk)
                print(f"Sent Telegram alert to {telegram_chat_id}")
            except Exception as exc:  # noqa: BLE001
                delivery_failed = True
                print(
                    f"warning: {exc}; keeping previous alert state so the alert retries",
                    file=sys.stderr,
                )

        # Only advance the dedup state once alerts were delivered (or none were
        # needed); otherwise a transient Telegram failure would swallow the alert
        # forever, since the next cycle would see no state transition.
        if not delivery_failed:
            save_alert_state(state_file, current_state)

        return ok, degraded, failed

    if args.watch:
        try:
            while True:
                _, degraded, failed = run_cycle()
                if degraded == 0 and failed == 0:
                    print(f"sleeping {args.interval}s before next check")
                time.sleep(max(1, args.interval))
        except KeyboardInterrupt:
            print("stopped")
            return 0
    else:
        ok, degraded, failed = run_cycle()
        return 0 if failed == 0 and degraded == 0 else 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

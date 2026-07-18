from __future__ import annotations

import subprocess
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from gpu_status_check import (
    AlertState,
    Machine,
    ProbeResult,
    build_alerts,
    emit_progress,
    load_alert_state,
    format_table,
    format_progress,
    parse_ssh_destination,
    read_machines,
    run_ssh_probe,
    save_alert_state,
    split_message,
)


class subprocess_completed:
    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class progress_stream:
    def __init__(self, tty: bool) -> None:
        self.tty = tty
        self.parts: list[str] = []
        self.flush_count = 0

    def write(self, text: str) -> int:
        self.parts.append(text)
        return len(text)

    def flush(self) -> None:
        self.flush_count += 1

    def isatty(self) -> bool:
        return self.tty


class GPUStatusCheckTests(unittest.TestCase):
    def test_read_machines_skips_header(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "machines.csv"
            path.write_text(
                "name,ip,platform,owner,commission_date,uptime\n"
                "alpha,10.0.0.1,gc,ops,2024-01-02,up 3 days\n"
                "beta,10.0.0.2,n7,,,up 5 hours\n"
            )

            machines = read_machines(path)

            self.assertEqual([m.name for m in machines], ["alpha", "beta"])
            self.assertEqual([m.ip for m in machines], ["10.0.0.1", "10.0.0.2"])
            self.assertEqual([m.platform for m in machines], ["gc", "n7"])
            self.assertEqual([m.owner for m in machines], ["ops", ""])
            self.assertEqual(
                [m.commission_date for m in machines], ["2024-01-02", ""]
            )
            self.assertEqual([m.uptime for m in machines], ["up 3 days", "up 5 hours"])

    def test_read_machines_still_supports_legacy_two_column_format(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "machines.csv"
            path.write_text("alpha,10.0.0.1\nbeta,10.0.0.2\n")

            machines = read_machines(path)

            self.assertEqual([m.name for m in machines], ["alpha", "beta"])
            self.assertEqual([m.ip for m in machines], ["10.0.0.1", "10.0.0.2"])
            self.assertTrue(all(m.platform == "" for m in machines))
            self.assertTrue(all(m.owner == "" for m in machines))
            self.assertTrue(all(m.commission_date == "" for m in machines))
            self.assertTrue(all(m.uptime == "" for m in machines))

    def test_parse_ssh_destination_supports_optional_port(self) -> None:
        self.assertEqual(parse_ssh_destination("10.0.0.5"), ("10.0.0.5", 22))
        self.assertEqual(parse_ssh_destination("10.0.0.5:2222"), ("10.0.0.5", 2222))

    def test_run_ssh_probe_passes_custom_port_to_ssh(self) -> None:
        completed = subprocess_completed(
            returncode=0,
            stdout=(
                "REMOTE_HOST=alpha\n"
                "UPTIME_PRETTY=up 1 hour\n"
                "NVIDIA_SMI_RC=0\n"
                "GPU_COUNT=1\n"
                "GPU_JOBS=D\n"
                "GPU_POWER_W=512.4\n"
                "GPU_AVG_TEMP_C=62.0\n"
                "BUS_OFF=0\n"
            ),
            stderr="",
        )

        with patch("gpu_status_check.subprocess.run", return_value=completed) as run:
            result = run_ssh_probe(
                Machine(name="alpha", ip="10.0.0.5:2222"),
                user="ezc",
                key_path="~/.ssh/test-key",
                timeout=10,
                probe_timeout=45,
            )

        cmd = run.call_args.args[0]
        self.assertEqual(result.status, "ok")
        self.assertIn("-p", cmd)
        self.assertEqual(cmd[cmd.index("-p") + 1], "2222")
        self.assertIn("ezc@10.0.0.5", cmd)
        self.assertNotIn("ezc@10.0.0.5:2222", cmd)
        self.assertEqual(result.gpu_jobs, "D")
        self.assertEqual(result.gpu_power_w, "512.4")
        self.assertEqual(result.gpu_avg_temp_c, "62.0")
        self.assertIn("nvidia-smi pmon -c 1", run.call_args.kwargs["input"])
        self.assertIn("--query-gpu=", run.call_args.kwargs["input"])
        self.assertIn("power.draw", run.call_args.kwargs["input"])
        self.assertIn("temperature.gpu", run.call_args.kwargs["input"])
        self.assertEqual(run.call_args.kwargs["timeout"], 45)
        self.assertEqual(cmd[-1], "1")

    def test_run_ssh_probe_reports_probe_timeout(self) -> None:
        with patch(
            "gpu_status_check.subprocess.run",
            side_effect=subprocess.TimeoutExpired(cmd=["ssh"], timeout=3),
        ):
            result = run_ssh_probe(
                Machine(name="alpha", ip="10.0.0.5"),
                user="ezc",
                key_path="~/.ssh/test-key",
                timeout=10,
                probe_timeout=3,
            )

        self.assertEqual(result.status, "ssh_failed")
        self.assertIn("timed out after 3s", result.ssh_error)

    def test_run_ssh_probe_can_skip_kernel_log_check(self) -> None:
        completed = subprocess_completed(
            returncode=0,
            stdout=(
                "REMOTE_HOST=alpha\n"
                "NVIDIA_SMI_RC=0\n"
                "GPU_COUNT=1\n"
                "BUS_OFF=0\n"
            ),
            stderr="",
        )

        with patch("gpu_status_check.subprocess.run", return_value=completed) as run:
            result = run_ssh_probe(
                Machine(name="alpha", ip="10.0.0.5"),
                user="ezc",
                key_path="~/.ssh/test-key",
                timeout=10,
                check_logs=False,
            )

        self.assertEqual(result.status, "ok")
        self.assertEqual(run.call_args.args[0][-1], "0")

    def test_run_ssh_probe_marks_jobs_as_error_on_bus_off(self) -> None:
        completed = subprocess_completed(
            returncode=0,
            stdout=(
                "REMOTE_HOST=alpha\n"
                "NVIDIA_SMI_RC=0\n"
                "GPU_COUNT=4\n"
                "GPU_JOBS=Dxxx\n"
                "BUS_OFF=1\n"
            ),
            stderr="",
        )

        with patch("gpu_status_check.subprocess.run", return_value=completed):
            result = run_ssh_probe(
                Machine(name="alpha", ip="10.0.0.5"),
                user="ezc",
                key_path="~/.ssh/test-key",
                timeout=10,
            )

        self.assertEqual(result.status, "degraded")
        self.assertTrue(result.bus_off_suspected)
        self.assertEqual(result.gpu_jobs, "EEEE")

    def test_format_progress_shows_completion_bar(self) -> None:
        self.assertEqual(format_progress(done=2, total=4, width=10), "[#####-----] 2/4 50%")
        self.assertEqual(format_progress(done=0, total=0, width=10), "[----------] 0/0 0%")

    def test_emit_progress_overwrites_tty_and_finishes_with_newline(self) -> None:
        stream = progress_stream(tty=True)

        emit_progress(1, 2, "alpha", "ok", stream)
        emit_progress(2, 2, "beta", "ssh_failed", stream, final=True)

        output = "".join(stream.parts)
        self.assertIn("\r[############------------] 1/2 50% alpha: ok", output)
        self.assertTrue(
            output.endswith("\r[########################] 2/2 100% beta: ssh_failed\n")
        )
        self.assertEqual(stream.flush_count, 2)

    def test_build_alerts_emits_on_transition_only(self) -> None:
        prev = AlertState(machines={"alpha": "ok"}, updated_at="2026-01-01T00:00:00Z")
        results = [
            ProbeResult(
                name="alpha",
                ip="10.0.0.1",
                ssh_ok=True,
                status="degraded",
                bus_off_reason="kernel/log indicators",
            )
        ]

        alerts, current = build_alerts(results, prev, notify_recovery=False)

        self.assertEqual(len(alerts), 1)
        self.assertIn("DEGRADED", alerts[0])
        self.assertEqual(current.machines["alpha"], "degraded")

    def test_build_alerts_suppresses_repeat_degraded(self) -> None:
        prev = AlertState(
            machines={"alpha": "degraded"}, updated_at="2026-01-01T00:00:00Z"
        )
        results = [
            ProbeResult(
                name="alpha",
                ip="10.0.0.1",
                ssh_ok=True,
                status="degraded",
                bus_off_reason="kernel/log indicators",
            )
        ]

        alerts, _ = build_alerts(results, prev, notify_recovery=False)

        self.assertEqual(alerts, [])

    def test_build_alerts_can_emit_recovery(self) -> None:
        prev = AlertState(
            machines={"alpha": "degraded"}, updated_at="2026-01-01T00:00:00Z"
        )
        results = [ProbeResult(name="alpha", ip="10.0.0.1", ssh_ok=True, status="ok")]

        alerts, _ = build_alerts(results, prev, notify_recovery=True)

        self.assertEqual(len(alerts), 1)
        self.assertIn("RECOVERED", alerts[0])

    def test_split_message_chunks_long_messages(self) -> None:
        message = "\n".join(f"line {i}" for i in range(500))
        chunks = split_message(message, limit=200)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(chunk) <= 200 for chunk in chunks))

    def test_split_message_hard_splits_oversized_single_line(self) -> None:
        message = "short line\n" + ("x" * 950)
        chunks = split_message(message, limit=200)

        self.assertTrue(all(len(chunk) <= 200 for chunk in chunks))
        self.assertEqual("".join(chunks).replace("\n", ""), message.replace("\n", ""))

    def test_alert_state_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "state.json"
            original = AlertState(
                machines={"alpha": "ok", "beta": "degraded"},
                updated_at="2026-06-25T10:00:00Z",
            )

            save_alert_state(path, original)
            loaded = load_alert_state(path)

            self.assertEqual(loaded, original)

    def test_format_table_includes_inventory_fields(self) -> None:
        table = format_table(
            [
                ProbeResult(
                    name="alpha-node",
                    ip="10.0.0.1",
                    platform="gc",
                    owner="ops",
                    commission_date="2024-01-02",
                    uptime="up 3 days",
                    ssh_ok=True,
                    status="ok",
                    gpu_count=10,
                    remote_host="alpha-node",
                )
            ]
        )

        self.assertIn("platform", table)
        self.assertIn("owner", table)
        self.assertIn("commissioned", table)
        self.assertIn("uptime", table)
        self.assertIn("alpha-node", table)
        self.assertIn("2024-01-02", table)
        self.assertIn("up 3 days", table)

    def test_format_table_includes_gpu_job_bitmap(self) -> None:
        table = format_table(
            [
                ProbeResult(
                    name="alpha-node",
                    ip="10.0.0.1",
                    ssh_ok=True,
                    status="ok",
                    gpu_count=8,
                    gpu_jobs="DDDDxxxx",
                )
            ]
        )

        self.assertIn("jobs", table)
        self.assertIn("DDDDxxxx", table)

    def test_format_table_includes_total_gpu_power(self) -> None:
        table = format_table(
            [
                ProbeResult(
                    name="alpha-node",
                    ip="10.0.0.1",
                    ssh_ok=True,
                    status="ok",
                    gpu_count=8,
                    gpu_power_w="1234.6",
                )
            ]
        )

        self.assertIn("power_w", table)
        self.assertIn("1234.6", table)

    def test_format_table_includes_average_gpu_temperature(self) -> None:
        table = format_table(
            [
                ProbeResult(
                    name="alpha-node",
                    ip="10.0.0.1",
                    ssh_ok=True,
                    status="ok",
                    gpu_count=8,
                    gpu_avg_temp_c="67.5",
                )
            ]
        )

        self.assertIn("temp_c", table)
        self.assertIn("67.5", table)

    def test_json_output_includes_gpu_telemetry_fields(self) -> None:
        result = ProbeResult(
            name="alpha-node",
            ip="10.0.0.1",
            gpu_jobs="DDDDxxxx",
            gpu_power_w="1234.6",
            gpu_avg_temp_c="67.5",
        )

        payload = asdict(result)

        self.assertEqual(payload["gpu_jobs"], "DDDDxxxx")
        self.assertEqual(payload["gpu_power_w"], "1234.6")
        self.assertEqual(payload["gpu_avg_temp_c"], "67.5")

    def test_format_table_does_not_truncate_ip_column(self) -> None:
        ip = "217.138.104.127:2222"
        table = format_table(
            [
                ProbeResult(
                    name="alpha-node",
                    ip=ip,
                    ssh_ok=True,
                    status="ok",
                )
            ]
        )

        self.assertIn(ip, table)
        self.assertNotIn("217.138.104.1…", table)


if __name__ == "__main__":
    unittest.main()

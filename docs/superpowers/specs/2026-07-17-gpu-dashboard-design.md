# GPU Dashboard Design

## Goal

Build a local web dashboard that polls a predefined CSV inventory of GPU hosts over SSH, stores current and historical GPU health in a SQLite database, and presents fleet-level and per-machine drill-down views.

The app replaces the one-shot CLI report as the main operator surface while preserving the current probe behavior and CSV inventory workflow.

## Approved Stack

- Runtime: Node.js with TypeScript.
- Web/API server: Fastify.
- Frontend: React with Vite.
- Database: SQLite file database.
- SQLite access: better-sqlite3.
- Schema/migrations: Drizzle.
- Probe execution: OpenSSH subprocess from the Node backend, using a generated remote shell script derived from the current Python probe.

This stack keeps deployment simple: one Node app, one SQLite file, one CSV inventory, and no agent installed on remote GPU hosts.

## Data Sources

### Inventory

The app reads the same CSV schema as the CLI:

```csv
name,ip,platform,owner,commission_date,uptime
example-gc-01,192.0.2.10,gc,ops,2026-01-15,
example-gc-02,198.51.100.20:2222,n07,research,2026-01-20,
```

CSV rows are imported into a `machines` table. Re-reading the CSV updates machine metadata and marks missing rows inactive rather than deleting historical data.

### Probe

Each poll connects over SSH and collects:

- SSH success or failure.
- Remote hostname and uptime.
- `nvidia-smi -L` status and GPU count.
- Per-GPU job bitmap, such as `DDDDxxxx`.
- Total GPU power draw in watts.
- Average GPU temperature in Celsius.
- Optional kernel log hits for GPU bus-off indicators.
- Per-GPU process details from `nvidia-smi pmon`.

## Per-GPU Process Capture

Process capture is included in v1.

The primary source is `nvidia-smi pmon -c 1`, because it maps PIDs to GPU indices. The app stores one process row per GPU process observed during each poll.

For each process row, store fields that `pmon` exposes reliably:

- GPU index.
- PID.
- Process type, when present.
- SM utilization, when present.
- Memory utilization, when present.
- Encoder utilization, when present.
- Decoder utilization, when present.
- Command or process name, when present.

Because GPU workloads often appear as `python` in `pmon`, v1 also enriches the PIDs seen in `pmon` with bounded `ps` metadata:

```sh
ps -p <pid list> -o pid=,user=,etime=,comm=,args=
```

The poller stores both the short command and the full command line so the machine detail view can distinguish `python train.py`, PyTorch launchers, notebooks, and other script-driven GPU jobs.

Guardrails:

- Only query `ps` for PIDs already observed in `pmon`.
- Truncate full command lines before storage, default 512 characters.
- Store command-line text as local operational telemetry; do not include it in alerts or exports by default.
- If `ps` enrichment fails, keep the `pmon` row and leave enrichment fields blank.

## Database Schema

### `machines`

- `id`
- `name`
- `ip`
- `ssh_host`
- `ssh_port`
- `platform`
- `owner`
- `commission_date`
- `active`
- `created_at`
- `updated_at`

### `poll_runs`

- `id`
- `started_at`
- `finished_at`
- `status`
- `machine_count`
- `ok_count`
- `degraded_count`
- `ssh_failed_count`
- `duration_ms`
- `error`

### `probe_results`

- `id`
- `poll_run_id`
- `machine_id`
- `checked_at`
- `status`
- `ssh_ok`
- `ssh_error`
- `remote_host`
- `uptime`
- `nvidia_smi_rc`
- `gpu_count`
- `gpu_jobs`
- `gpu_power_w`
- `gpu_avg_temp_c`
- `bus_off_suspected`
- `bus_off_reason`
- `kernel_hits`
- `nvidia_smi_output`
- `nvidia_smi_error`
- `duration_ms`

### `gpu_processes`

- `id`
- `probe_result_id`
- `machine_id`
- `poll_run_id`
- `checked_at`
- `gpu_index`
- `pid`
- `process_type`
- `sm_util`
- `mem_util`
- `enc_util`
- `dec_util`
- `command`
- `user`
- `elapsed`
- `process_name`
- `command_line`

Indexes:

- `probe_results(machine_id, checked_at)`
- `probe_results(status, checked_at)`
- `gpu_processes(machine_id, checked_at)`
- `gpu_processes(probe_result_id)`
- `poll_runs(started_at)`

## Scheduler

The backend runs an in-process scheduler.

Configuration:

- `GPUCHECK_POLL_INTERVAL_SECONDS`, default 300.
- `GPUCHECK_JOBS`, default 8.
- `GPUCHECK_TIMEOUT`, default 10.
- `GPUCHECK_PROBE_TIMEOUT`, default 60.
- `GPUCHECK_SKIP_LOGS`, default false.
- `GPUCHECK_MACHINES`, default `machines.csv`.
- `GPUCHECK_DB`, default `data/gpu-status.sqlite`.
- `GPUCHECK_PROCESS_ARGS_MAX_CHARS`, default 512.

Scheduler behavior:

- Poll immediately on startup unless disabled.
- Do not overlap poll runs. If a poll is still running when the next interval arrives, skip that interval and record the skip in logs.
- Support manual poll trigger from the dashboard.
- Persist partial results even when some hosts fail.

## API

Initial endpoints:

- `GET /api/health`
- `GET /api/machines`
- `GET /api/machines/:id`
- `GET /api/machines/:id/history?from=&to=&limit=`
- `GET /api/machines/:id/processes?from=&to=&limit=`
- `GET /api/poll-runs?limit=`
- `POST /api/poll-runs`
- `GET /api/summary`

## Dashboard UX

The dashboard is an operational tool, not a marketing page.

Main view:

- Fleet summary counters: OK, degraded, SSH failed, total power, average temperature.
- Dense machine table with status, IP, platform, owner, uptime, GPU count, jobs bitmap, power, temp, remote host, and last checked time.
- Filters for status, owner, platform, and search by name/IP.
- Poll status indicator and manual poll button.

Machine detail view:

- Current status and metadata.
- Recent power and temperature history.
- Jobs bitmap history.
- Current and recent GPU processes grouped by GPU index, showing full command line when available.
- Raw probe errors and kernel hits when relevant.

## Migration From CLI

The Python CLI can remain during the transition.

The Node app should reuse the behavior, data naming, and remote shell probe semantics from the CLI, but it does not need to import Python code. The first app implementation should keep the Python script intact and add the Node app beside it.

## Testing

Backend:

- Unit tests for CSV parsing, IP/port parsing, probe output parsing, and pmon process parsing.
- Database tests against a temporary SQLite file.
- API tests with Fastify injection.
- Scheduler tests with fake timers or short intervals.

Frontend:

- Component tests for machine table rendering and status badges.
- API fixture tests for detail pages.

End-to-end smoke:

- Start the app with a sample CSV.
- Seed or mock probe results.
- Verify the dashboard loads and API endpoints return expected data.

## V1 Non-Goals

- User authentication.
- Multi-user roles.
- Remote agent installation.
- WebSocket streaming.
- Alert configuration UI.
- Replacing the Python CLI.

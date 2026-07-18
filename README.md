# GPUStatusCheck

Probe the servers listed in `machines.csv` over SSH and report whether GPU state
looks healthy or if there are signs of a GPU "fallen off the bus" condition.

## What it does

For each machine, the script:

1. SSHes in with a configurable username and private key
2. Runs `nvidia-smi -L`
3. Checks which GPUs have active `nvidia-smi pmon` process rows
4. Sums current GPU power draw in watts
5. Averages current GPU temperature in Celsius
6. Checks recent kernel logs for common GPU bus-off patterns
7. Prints a summary table and optionally JSON

It can also run in a watch loop and send Telegram alerts when a machine
changes from healthy to degraded or SSH-failed. Duplicate alerts are suppressed
with a small persisted state file.

## Files

- `machines.csv` — headered machine inventory rows
- `machines.sample.csv` — commit-safe example inventory to copy from
- `gpu_status_check.py` — the probe script
- `.env.example` — sample configuration

## Configuration

Create a `.env` file in the repo root:

```bash
cp .env.example .env
```

You can override:

```bash
GPUCHECK_USER=ezc
GPUCHECK_KEY=~/.ssh/EZC-HydraHost
GPUCHECK_TIMEOUT=10
GPUCHECK_PROBE_TIMEOUT=60
GPUCHECK_JOBS=8
GPUCHECK_STATE_FILE=.omx/gpucheck-state.json
GPUCHECK_NOTIFY_RECOVERY=0
GPUCHECK_SKIP_LOGS=0
TELEGRAM_BOT_TOKEN=123456789:AAExampleToken
TELEGRAM_CHAT_ID=-1001234567890
```

## Machine inventory schema

The preferred `machines.csv` format is headered and backward compatible:

```csv
name,ip,platform,owner,commission_date
ezc-gc-05e,217.138.104.127,gc,ezc,2024-05-12
```

Start from the sample file:

```bash
cp machines.sample.csv machines.csv
```

- `name` — machine label
- `ip` — SSH target; use `a.b.c.d:x` to connect to SSH port `x` instead of 22
- `platform` — e.g. `gc`, `n07`, `edge`
- `owner` — responsible owner/team
- `commission_date` — `YYYY-MM-DD`
- `uptime` — collected at probe time and shown in the report

Older two-column files with just `name,ip` still work.

### Telegram setup

- Create a bot with `@BotFather`
- Add the bot to the target channel or group
- Use the bot token as `TELEGRAM_BOT_TOKEN`
- Use the channel/group ID as `TELEGRAM_CHAT_ID`

## Run

```bash
python3 gpu_status_check.py --machines machines.csv
```

The script scans hosts in parallel. Use `--jobs N` or `GPUCHECK_JOBS=N` to tune
concurrency; the default is 8. Progress is printed as hosts complete.
`--probe-timeout N` or `GPUCHECK_PROBE_TIMEOUT=N` sets a hard per-host timeout
for the whole SSH probe. `--skip-logs` or `GPUCHECK_SKIP_LOGS=1` skips kernel
log checks for faster live telemetry scans.

The report includes a `jobs` column with one character per GPU index. `D` means
that GPU has at least one active process row, `x` means it is idle, and `E`
means the probe saw GPU fallen-off-bus evidence. For example, `DDDDxxxx` means
GPUs 0-3 are busy and GPUs 4-7 are idle.
The `power_w` column shows total GPU power draw in watts at the check moment.
The `temp_c` column shows average GPU temperature in Celsius at the check moment.
JSON reports include the same telemetry fields, including `gpu_jobs`,
`gpu_power_w`, and `gpu_avg_temp_c`.

Optional JSON report:

```bash
python3 gpu_status_check.py --machines machines.csv --json-out report.json
```

Watch mode:

```bash
python3 gpu_status_check.py --machines machines.csv --watch --interval 300
```

Faster live telemetry scan:

```bash
python3 gpu_status_check.py --machines machines.csv --jobs 16 --skip-logs
```

## Web dashboard

The Node.js dashboard polls the same CSV inventory over SSH, stores history in
SQLite, and serves a local React dashboard.

Install dependencies:

```bash
npm install
```

Run the API server:

```bash
npm run dev
```

In another terminal, run the React dev server:

```bash
npm run dev:client
```

Open the dev dashboard:

```text
http://127.0.0.1:5173
```

Build and run the combined production-style server:

```bash
npm run build
npm start
```

Open the built dashboard:

```text
http://127.0.0.1:4100
```

Run tests:

```bash
npm test
```

Dashboard-specific settings:

```bash
GPUCHECK_POLL_INTERVAL_SECONDS=300
GPUCHECK_MACHINES=machines.csv
GPUCHECK_DB=data/gpu-status.sqlite
GPUCHECK_PROCESS_ARGS_MAX_CHARS=512
GPUCHECK_DISABLE_STARTUP_POLL=0
PORT=4100
```

The dashboard reads `.env` at startup, with shell environment variables taking
precedence. The Config panel in the dashboard writes `GPUCHECK_MACHINES` and
`GPUCHECK_POLL_INTERVAL_SECONDS` back to `.env` and applies those two changes to
the running scheduler immediately. Set `GPUCHECK_ENV_FILE=/path/to/.env` before
starting the API server to use a different environment file.

The dashboard stores per-poll history in SQLite tables for machines, poll runs,
probe results, and GPU processes. GPU process rows include `nvidia-smi pmon`
fields plus bounded `ps` command-line enrichment so Python/PyTorch jobs show
their script or launcher command where available.

### Recommended scheduling

The cleanest approach is usually:

- keep the script as a one-shot checker
- run it from `cron`, `launchd`, or `systemd` every N minutes
- let the script handle alert deduplication and Telegram delivery

That avoids a fragile always-on process while still giving you "autopilot"
behavior.

## Notes

- The script uses `ssh -o BatchMode=yes`, so it will not prompt for passwords.
- It uses `StrictHostKeyChecking=accept-new` to avoid first-run host-key prompts.
  If you prefer stricter host-key handling, change that option in the script.
- "degraded" means either kernel/log evidence suggests a bus-off issue, or
  `nvidia-smi` returned a driver/GPU error, or zero GPUs were reported.
- `--skip-logs` disables kernel/log evidence, so degradation then comes from
  live `nvidia-smi` checks only.
- Telegram alerts are only sent when there is a state transition into a problem
  state unless `GPUCHECK_NOTIFY_RECOVERY=1` is set, in which case recovery
  notices are also sent.
- The report JSON now includes the machine metadata fields alongside probe
  results.
- The live probe also captures machine uptime, so the report can show how long
  each host has been up at the time of the check.

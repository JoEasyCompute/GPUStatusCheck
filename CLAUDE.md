# GPUStatusCheck

GPU fleet monitoring: a Python CLI (`gpu_status_check.py`) and a Node/Fastify +
React/Vite dashboard (`src/`) that both probe GPU hosts over SSH using the
shared remote script `scripts/remote-probe.sh`.

## Commands

```bash
npm run check                   # TS/Python tests, typecheck, build, shell syntax
npm test                        # vitest (tests/) only
npm run build                   # tsc --noEmit + vite build -> dist/client
npm start                       # production server (serves dist/client + API)
npm run dev:client              # vite dev server on :5173 (proxies /api to :4100)
python3 test_gpu_status_check.py  # Python CLI tests
```

Locally the operator runs the server detached:
`nohup npm start > .omx/dashboard-server.log 2>&1 &` on port 4100.
Production runs on a remote host as the systemd service `gpustatuscheck`
(template: `deploy/gpustatuscheck.service`; deploy there with `git pull`,
`npm ci`, `npm run check`, `npm run build`,
`sudo systemctl restart gpustatuscheck` for server changes; logs via
`journalctl -u gpustatuscheck`).
Server-side changes need a server restart to take effect; client-only changes
just need `npm run build` (static files are served from disk per request).
Node 22.12 or newer is required. Record the pre-deploy commit for rollback and
verify `http://127.0.0.1:4100/api/health` after every restart.

The current public deployment intentionally leaves read and mutating endpoints
unauthenticated. Do not mistake reachability for authorization: any reachable
client can trigger polls, toggle maintenance, and update exposed settings.

## Database safety

- Keep `GPUCHECK_RETENTION_DAYS=30` unless a capacity review approves another
  value. `GPUCHECK_MIN_FREE_DISK_BYTES=5368709120` makes health return 503 below
  5 GiB free.
- Before retention or database maintenance, use SQLite `.backup` to a separate
  filesystem, require `PRAGMA integrity_check` to return `ok`, record a SHA-256
  checksum, and copy the verified backup off-host.
- Never run in-place `VACUUM` when free space is tight. Compaction requires a
  separately approved maintenance window and `VACUUM INTO` a destination with
  verified capacity.
- Stop `gpustatuscheck` only for the final database swap. Keep the verified
  original database off the root filesystem until the replacement passes local
  health plus representative machine, history, and GPU API checks.
- Roll back by stopping the service, restoring the verified original database,
  restarting, and checking `/api/health` before reopening normal operations.

## Architecture

- `scripts/remote-probe.sh` — THE single source of truth for what runs on
  remote hosts; both the CLI and `src/server/probe.ts` pipe it over
  `ssh <host> sh -s --`. It must never write to the target host's disk
  (a full-disk host once silently reported 0 GPUs via failed temp-file
  writes); capture command output in shell variables only. The optional
  on-host agent (`scripts/agent/`) is the single deliberate exception to
  that rule: it appends to a bounded spool guarded by a free-space check,
  age cap, and total-size cap.
- `src/server/` — Fastify app (`app.ts`), poll scheduler with Telegram
  alerting (`scheduler.ts`, `alerts.ts`), per-card GPU drop detection and
  Slack announcements (`gpuDrops.ts`, `slack.ts`), SQLite via better-sqlite3
  (`db.ts`, schema created in `migrate()`, columns added with `ensureColumn`),
  config from `.env` (`config.ts`, `GPUCHECK_*` variables).
- `src/client/` — React. `LineChart.tsx` is the shared zoom/pan chart
  (window math in `timeWindow.ts` + `useTimeWindow.ts`); design tokens and
  light/dark theme live in `styles.css` (colors come from a CVD-validated
  palette; series colors are `--series-1..8` in fixed order — never shuffle).
- `src/shared/` — `types.ts` (types shared by server and client) plus small
  helpers used by both, e.g. `gpuUuid.ts`, `ssh.ts`.

## GPU identity

GPUs are tracked by nvidia UUID, so a card's history follows it between
machines: `gpus` (identity, high-water type/machine/slot/owner),
`gpu_sightings` (one row per continuous machine+slot+owner stretch),
`gpu_metrics.uuid` (telemetry), and `gpu_daily_stats` (daily rollups, folded
in by `rollupGpuDailyStats()` before pruning so long-term per-card stats
outlive `GPUCHECK_RETENTION_DAYS`). A machine's expected roster is every card
whose *latest* sighting points at it (`listMachineRoster`) — moving a card
updates its own sighting, so it leaves the old roster automatically.

## On-host agent (optional per host)

An installable agent (`scripts/agent/`, systemd timer, 60s oneshot samples)
buffers probe-format records plus kernel/GPU log events in a bounded spool at
`/var/lib/gpucheck-agent/`; the server drains it over SSH after each
successful probe (`scripts/agent-drain.sh`, `src/server/agent.ts`) when
`GPUCHECK_AGENT_DRAIN=1`. Invariants:

- **The agent is optional per host and the SSH poll is never replaced.**
  Detection is the presence of `/var/lib/gpucheck-agent/VERSION` (probe
  scalar `AGENT_VERSION`); hosts without it follow the pre-agent workflow
  exactly. A mixed fleet is the intended steady state.
- Ingested samples become `probe_results` rows with `source='agent'` and
  their real historical `checked_at`, anchored to synthetic
  `status='agent'` poll_runs. They feed charts and per-GPU views only:
  ingest never touches `gpus`/`gpu_sightings`/`gpu_down_events`/drop
  incidents, and never drives alerting — the live poll owns state.
  `listMachines`/summary/poll-run lists filter agent rows/runs out.
- Re-drains are idempotent (partial unique index on
  `(machine_id, checked_at) WHERE source='agent'`); a drain missing its
  `AGENT_LINES_END` frame is discarded whole and the per-machine watermark
  (`agent_state.last_ingested_at`) does not advance.
- Backfill below the daily-rollup watermark triggers a targeted
  `recomputeGpuDailyStats` for the touched (uuid, day)s.
- `pruneHistory` keep-latest selects by `checked_at` among `source='probe'`
  rows only, and agent rows age out on `GPUCHECK_AGENT_RETENTION_DAYS`
  (shorter than the main retention; rollups carry the long-term signal).

## Behavior invariants

- Alert dedup state (`alert_states` table) only advances after successful
  Telegram delivery, so failed sends retry next poll. Machines in maintenance
  are muted but their state is still tracked (no stale alerts on unmute).
- Each machine's most recent probe row survives retention pruning so
  long-unreachable machines keep their last known state.
- `expected_gpu_count` is the highest healthy count seen; fewer visible GPUs
  on a healthy probe marks the machine degraded ("only N/M GPUs visible").
  That is a count-level signal only — which *card* vanished comes from the
  UUID roster diff (`detectGpuDrops`), not from this.
- GPU drop detection only runs on probes where SSH succeeded: an unreachable
  host says nothing about its cards, so an outage must never fire N false
  drop alerts. Incidents are recorded even when the owner has no Slack
  channel or the machine is muted, so unmuting never replays old drops.
- Slack announcement timestamps (`announced_at`, `recovery_announced_at`)
  advance only after Slack confirms — same retry-safety rule as
  `alert_states`. Slack returns HTTP 200 with `{ok:false}` on application
  errors, so `postSlack` checks the body, not just the status.
- `gpu_drop_incidents` / `gpu_drop_members` and the GPU identity tables are
  never touched by `pruneHistory`.
- SSH probes retry once as `GPUCHECK_FALLBACK_USER` (default `ubuntu`) only on
  auth-shaped failures, never on network failures/timeouts; the working user
  is stored per probe (`probe_results.ssh_user`).
- FK enforcement is on in SQLite here: don't delete `poll_runs` rows still
  referenced by kept probe results.

## Conventions

- Real inventory CSVs (`machines.csv`, `iota*.csv`, …), `.env`, and
  `slack-channels.json` are gitignored; only `machines.sample.csv` is
  committed. Never commit real IPs, channel IDs, or tokens.
- `vitest` is scoped to this checkout in `vite.config.ts`; Claude task
  worktrees under `.claude/worktrees` contain a copy of `tests/` that would
  otherwise be collected twice.
- Config test literals in `tests/api.test.ts` / `tests/alerts.test.ts` must be
  updated whenever `AppConfig` gains a required field.
- Update README.md when adding env vars or user-facing features.

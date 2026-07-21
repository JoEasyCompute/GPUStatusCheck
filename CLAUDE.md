# GPUStatusCheck

GPU fleet monitoring: a Python CLI (`gpu_status_check.py`) and a Node/Fastify +
React/Vite dashboard (`src/`) that both probe GPU hosts over SSH using the
shared remote script `scripts/remote-probe.sh`.

## Commands

```bash
npm test                        # vitest (tests/)
npm run build                   # tsc --noEmit + vite build -> dist/client
npm start                       # production server (serves dist/client + API)
npm run dev:client              # vite dev server on :5173 (proxies /api to :4100)
python3 test_gpu_status_check.py  # Python CLI tests
```

The operator usually runs the server detached:
`nohup npm start > .omx/dashboard-server.log 2>&1 &` on port 4100.
Server-side changes need a server restart to take effect; client-only changes
just need `npm run build` (static files are served from disk per request).

## Architecture

- `scripts/remote-probe.sh` — THE single source of truth for what runs on
  remote hosts; both the CLI and `src/server/probe.ts` pipe it over
  `ssh <host> sh -s --`. It must never write to the target host's disk
  (a full-disk host once silently reported 0 GPUs via failed temp-file
  writes); capture command output in shell variables only.
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

# GPUStatusCheck Reliability and Operations Hardening Design

## Goal

Correct the confirmed polling, API atomicity, and client error-handling defects; make the production runtime and validation workflow reproducible; and prevent the deployed SQLite database from exhausting its host filesystem.

The existing public, unauthenticated dashboard and mutating controls remain unchanged by explicit operator decision. This accepted risk must stay documented.

## Current Production Context

The deployed service runs from `/home/ezc/gpustatuscheck` through systemd as user `ezc`, with `NODE_ENV=production` and `npm start`. Node 22.22.2 is installed. The application binds to `0.0.0.0:4100`, while the public dashboard is exposed at `http://46.37.58.172:34100/`.

The production SQLite database is approximately 11 GB. The root filesystem is approximately 97% used with about 3.2 GB free. `GPUCHECK_RETENTION_DAYS` is set to 90. SQLite reports no freelist pages, so the present database size represents live allocated pages rather than immediately reclaimable free pages. A conventional in-place `VACUUM` is unsafe with the current free-space margin.

## Scope

### Included

- Correct manual-poll failure reporting across scheduler, API, and browser UI.
- Preserve the no-overlap polling guarantee until every concurrent worker has settled.
- Make combined machine-setting updates validate and commit atomically.
- Centralize browser JSON request handling and reject non-success responses and malformed collection payloads.
- Surface recoverable dashboard and chart loading errors without replacing valid state with error objects.
- Declare and validate the production Node/runtime contract.
- Add a checked-in systemd service template and deployment/rollback documentation.
- Add a single local validation command and continuous integration for TypeScript, Python, build, and shell checks.
- Add low-disk/database-size health telemetry and a configurable unhealthy threshold.
- Document and execute a safe retention-first production storage recovery process after the code release is verified and deployment is separately approved.

### Excluded

- Authentication or authorization for page views or mutating endpoints.
- A reverse proxy, TLS termination, VPN, or firewall redesign.
- Replacing SQLite, Fastify, React, SSH probing, or the current polling architecture.
- Schema-wide ORM adoption or a rewrite of `src/server/db.ts`.
- Automatic production database compaction.
- Destructive production database work without a verified backup and a separately approved maintenance window.

## Design

### 1. Poll completion and failure semantics

`PollScheduler.pollOnce()` remains the single owner of a poll's lifecycle. The concurrency helper will wait until every worker has either completed or failed before returning. It will retain the first worker error for reporting while allowing already-started sibling workers to finish. The scheduler must not clear its `running` flag until that barrier has completed.

When any worker or post-collection operation makes the poll fail, the scheduler will:

1. record the error on the existing poll run;
2. leave `lastError` populated;
3. finish all active workers before releasing the polling lock; and
4. throw a typed poll failure containing the poll-run ID and safe error message.

Scheduled and startup callers already catch and log rejected polls. The manual `POST /api/poll-runs` route will convert the typed failure into an HTTP 500 JSON response containing `error` and `runId`. Successful and skipped responses retain their existing shape.

The browser will display the returned error. It will only show `Poll #N complete` after a successful response.

### 2. Atomic machine settings

The machine PATCH route will parse and validate the complete request before performing any write. Unknown or absent supported fields remain a no-op as today; an invalid `expectedGpuCount` produces HTTP 400 without changing `maintenance`.

The database facade will expose one transactional machine-settings operation that applies the provided supported fields together. This preserves atomicity if a database error occurs between individual updates.

### 3. Browser API boundary

A focused `src/client/api.ts` module will own JSON response handling:

- `fetchJson<T>()` checks `response.ok`, extracts a server-provided error when available, and otherwise reports the HTTP status.
- `fetchJsonArray<T>()` additionally rejects non-array payloads.
- Error normalization produces a stable user-facing message.

`App`, fleet charts, group charts, GPU detail, and kernel-event loading will use these helpers. Top-level failures use the existing dashboard error banner. Self-contained chart/detail components retain their last valid data and render a small local error state instead of silently swallowing failures or installing error objects into array state.

This change does not introduce a client state-management dependency.

### 4. Runtime and deployment contract

The package will declare Node `>=22.12.0`, matching the installed production major and Vite's supported runtime. The package manager version will be recorded. Because the production service intentionally starts TypeScript through `tsx`, `tsx` will be a production dependency rather than a dev-only dependency.

A checked-in `deploy/gpustatuscheck.service` will capture the current service contract: service user/group, working directory, `NODE_ENV=production`, restart policy, and `npm start`. README deployment instructions will cover installation, build, validation, restart, health verification, and rollback.

Production deployment remains a separate state-changing step. Local implementation does not restart or modify the live server.

### 5. Validation and continuous integration

Package scripts will provide independently callable checks and one aggregate command:

- TypeScript unit tests;
- Python unit tests;
- strict TypeScript type checking;
- the production client build; and
- `bash -n` syntax checks for checked-in shell scripts.

A GitHub Actions workflow will run the same checks on pushes and pull requests using the declared Node version. No linter or formatter dependency is introduced in this hardening release.

### 6. Storage health and recovery

The health endpoint will report the SQLite file size and filesystem free space. A configurable `GPUCHECK_MIN_FREE_DISK_BYTES` threshold will default to 5 GiB. Falling below the threshold makes health return HTTP 503 with a specific storage reason while preserving existing poll-staleness information. Missing or in-memory database paths will degrade gracefully without crashing health checks.

The sample environment and README will document the threshold and retention implications. Daily GPU rollups remain the long-term record; detailed probe rows remain bounded by retention.

The production recovery sequence is deliberately staged:

1. create and verify an off-host SQLite backup using SQLite's online backup mechanism;
2. deploy and verify the hardening release;
3. change detailed retention from 90 days to the agreed operational value of 30 days;
4. run one poll or a dedicated safe prune command and verify row/date boundaries and application health;
5. measure SQLite page and freelist counts after pruning;
6. schedule a maintenance window for physical compaction only if it will materially recover disk;
7. compact into a separate destination with sufficient capacity, verify the replacement database, stop the service, swap files atomically, restart, and verify health.

Compaction must not use the nearly full root filesystem as scratch space. `/dev/shm` is not assumed safe merely because it appears large; its use requires an explicit memory-capacity check and maintenance approval. Until compaction, SQLite may reuse freed pages even though the filesystem-visible file size does not shrink.

## Error Handling and Observability

- Poll failures retain a run ID and a persisted failed run for diagnosis.
- The polling lock reflects actual active work, including sibling workers finishing after another worker fails.
- API error bodies use stable JSON with an `error` field.
- Client components distinguish transport/server errors from valid empty datasets.
- Health distinguishes stale polling from low disk and reports both measurements.
- Storage commands and rollout documentation include pre- and post-change measurements.

## Testing Strategy

All behavioral corrections use red-green TDD.

- Scheduler regression: a worker throws while a sibling remains blocked; a second poll must remain skipped until the sibling settles, and the failed run must retain its error.
- API regression: a failed manual poll returns HTTP 500 with its run ID and never produces a successful completion payload.
- API regression: a combined invalid PATCH leaves maintenance unchanged.
- Database regression: valid combined machine settings update together.
- Client helper tests: successful JSON, server error JSON, non-JSON error response, and malformed array payload.
- Component-level pure-state or rendered tests cover visible error behavior where practical without introducing a broad UI framework solely for this release.
- Health tests cover healthy disk, threshold breach, and unavailable filesystem metrics through injected filesystem-stat behavior.
- Full verification runs the aggregate repository check and confirms a clean production build.

## Rollout and Rollback

Code rollout and database maintenance are separate operations.

For code rollout, record the current commit, install from the lockfile, run the full validation command, build, restart systemd, and verify the local and public health endpoints plus representative dashboard reads. Roll back by returning to the recorded commit, reinstalling from its lockfile, rebuilding, and restarting.

For database maintenance, keep the original database untouched until the compacted copy passes integrity checks and representative application queries. Stop the service only for the final file swap. Roll back by restoring the original database file and restarting the service.

## Success Criteria

- Failed manual polls produce a visible failure and HTTP 500 rather than a false completion message.
- No second poll starts while any worker from the previous poll is still active.
- Invalid combined machine updates make no database change.
- Non-success or malformed browser responses cannot become application array state.
- `npm ci --omit=dev` still leaves the configured production start command available.
- One documented validation command passes locally and in CI.
- The checked-in service template matches the production execution model.
- Health reports database size and free disk and becomes unhealthy below the configured threshold.
- Production detailed retention is reduced safely, with an off-host backup verified before any destructive maintenance.
- Public unauthenticated access remains unchanged and explicitly documented as an accepted risk.

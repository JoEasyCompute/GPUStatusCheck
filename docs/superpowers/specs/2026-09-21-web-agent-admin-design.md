# Web Agent Administration Design

## Goal

Add an API-key-protected administration mode to the existing public dashboard and use it to manage the optional on-host GPU agent from the Web UI. Administrators must be able to select multiple active inventory machines, install or upgrade the agent, uninstall it, and follow durable per-machine progress without exposing arbitrary remote execution.

The public monitoring experience remains available without authentication. All state-changing actions become admin-only.

## Current Context

The dashboard is intentionally public and currently served over plain HTTP. Existing state-changing controls can trigger polls, rewrite the inventory path and polling interval, toggle maintenance, and reset expected GPU counts. The existing CLI installer in `scripts/install-agent.ts` already supports fleet-wide or single-machine install/upgrade and uninstall through SSH with passwordless `sudo`.

The new admin API key will initially travel over plain HTTP by explicit operator decision. It is therefore interceptable on an untrusted network. The UI and documentation must display this limitation clearly until nginx provides HTTPS termination.

## Scope

### Included

- Add `GPUCHECK_ADMIN_API_KEY` as the server-side switch and credential for administration mode.
- Protect every existing and new mutating API route with bearer-key authentication.
- Add a tab-scoped admin unlock/lock experience using `sessionStorage`.
- Refactor the existing agent installer into a reusable server service while preserving its CLI.
- Support bulk install/upgrade and uninstall for active inventory machines.
- Persist operation and per-machine state for progress, history, auditability, and restart recovery.
- Bound SSH concurrency, batch size, retained history, and stored diagnostic output.
- Reject arbitrary hosts, SSH commands, usernames, key paths, and installer payloads.
- Add Web UI machine selection, confirmation, live progress, recent history, and retry construction.
- Document plain-HTTP risk, key rotation, deployment, and recovery behavior.

### Excluded

- TLS termination or nginx configuration.
- User accounts, roles, sessions, cookies, OAuth, or per-user audit identity.
- Arbitrary remote command execution.
- Editing the SSH key, SSH user, installer payload, service unit, or agent scripts from the browser.
- Cancelling an in-progress SSH installation.
- Managing machines absent from the currently active inventory.
- Automatically selecting every filtered machine without explicit administrator action.

## Configuration

New settings:

- `GPUCHECK_ADMIN_API_KEY` — enables administration mode. When absent or empty, every mutating route returns HTTP 503 and the browser exposes no usable admin controls.
- `GPUCHECK_AGENT_INSTALL_JOBS` — maximum concurrent install/uninstall SSH jobs; default `4`.
- `GPUCHECK_AGENT_MAX_BATCH` — maximum machines in one operation; default `100`.
- `GPUCHECK_AGENT_OPERATION_RETENTION_DAYS` — completed operation history retention; default `30`.
- `GPUCHECK_AGENT_OUTPUT_MAX_CHARS` — maximum sanitized stdout/stderr characters stored per machine; default `4000`.

The API key should be generated from at least 32 random bytes. A shorter configured key produces a startup warning without printing the key. Key changes take effect after server restart.

## Authentication Boundary

### Request contract

Authenticated requests send:

```text
Authorization: Bearer <GPUCHECK_ADMIN_API_KEY>
```

The server hashes the configured and presented values to equal-length SHA-256 digests and compares them with `timingSafeEqual`. The raw key must never appear in logs, SQLite, API responses, URLs, or persistent browser storage.

Authentication failures use stable responses:

- HTTP 401 `{ "error": "admin authentication required" }` when admin mode is enabled but the credential is missing or wrong.
- HTTP 503 `{ "error": "admin mode is disabled" }` when no server key is configured.

### Protected routes

The following existing routes become admin-only:

- `POST /api/poll-runs`
- `PUT /api/config`
- `PATCH /api/machines/:id`, including maintenance and expected-GPU-count changes

Every new agent-operation route is admin-only. Read-only monitoring, history, GPU, configuration-display, poll-status, and health routes remain public.

### Admin status

`GET /api/admin/status` returns only:

```json
{
  "enabled": true,
  "authenticated": false
}
```

`authenticated` reflects the bearer key on that request. The browser derives the insecure-transport warning from `window.location.protocol`, so the warning automatically clears when users access the same application through nginx HTTPS without trusting client-supplied forwarded headers.

`POST /api/admin/verify` requires a valid bearer key and returns `{ "authenticated": true }`. The browser calls it before enabling admin controls.

## Browser Credential Lifecycle

- The dashboard starts locked.
- Unlock opens a masked API-key dialog.
- Successful verification stores the key in `sessionStorage` under one namespaced key and in the current React state.
- Reloading the same tab restores and re-verifies the key.
- Closing the tab removes the browser session and key.
- Lock immediately deletes the stored key and clears admin-only selection and dialogs.
- Any 401 from an admin request clears the stored key, returns the UI to locked state, and explains that the key may have rotated.
- The UI never places the key in query parameters, DOM text, error output, analytics, or clipboard automatically.
- While unlocked over HTTP, a persistent warning states that the key can be intercepted until HTTPS is enabled.

## Agent Installer Boundary

### Reusable installer service

Extract the reusable parts of `scripts/install-agent.ts` into a server module with a narrow interface:

```ts
type AgentAction = "install" | "uninstall";

type AgentInstallTarget = {
  machineId: number;
  name: string;
  sshHost: string;
  sshPort: number;
};

type AgentInstallResult = {
  outcome: "succeeded" | "skipped" | "failed";
  summary: string;
  output: string;
};

runAgentAction(target: AgentInstallTarget, action: AgentAction, config: InstallerConfig): Promise<AgentInstallResult>
```

The service owns the fixed repository-provided probe script, agent script, systemd units, and version. The existing CLI becomes a thin argument/inventory adapter over the same service, preserving its current install, `--only`, and `--uninstall` behavior.

The Web API supplies only an action and database machine IDs. The server resolves those IDs through the current active inventory and server configuration.

### Safety rules

- Only active machines returned by the current inventory/database join are eligible.
- Duplicate IDs are rejected before creating an operation.
- Empty batches and batches above `GPUCHECK_AGENT_MAX_BATCH` are rejected.
- An install action is idempotent install/upgrade using the repository's current agent version.
- Uninstall requires the same explicit confirmation as install and uses the fixed existing uninstall path.
- Operations targeting a machine already queued or running are rejected with a conflict response naming those machine IDs.
- SSH commands use argument arrays and the existing shared SSH builder; request values never become shell fragments.
- The API cannot override SSH user, key path, timeouts, scripts, unit contents, or destination paths.

## Durable Operation Model

Add two SQLite tables.

`agent_operations`:

- `id`
- `action` (`install` or `uninstall`)
- `status` (`queued`, `running`, `complete`, `failed`, `interrupted`)
- `machine_count`
- `queued_at`, `started_at`, `finished_at`
- aggregate succeeded/skipped/failed/interrupted counts

`agent_operation_items`:

- `id`, `operation_id`, `machine_id`, and immutable machine name snapshot
- `status` (`queued`, `running`, `succeeded`, `skipped`, `failed`, `interrupted`)
- `started_at`, `finished_at`
- sanitized `summary` and bounded `output`
- uniqueness for one machine within an operation

Operation creation is transactional: the parent and all validated items are inserted together, or none are inserted.

On server startup, any operation/item left `queued` or `running` is marked `interrupted`. It is not automatically resumed because the remote-side result may be ambiguous. Administrators can construct a new retry operation from interrupted, failed, or skipped items.

Completed operations and items older than `GPUCHECK_AGENT_OPERATION_RETENTION_DAYS` are pruned after operation completion and during normal history pruning. Active operations are never pruned.

## Runner and Concurrency

The server owns one in-process agent-operation runner.

- Items run concurrently up to `GPUCHECK_AGENT_INSTALL_JOBS`.
- A machine lock exists from queued creation through terminal item status.
- Locks are released in `finally` for success, skip, timeout, installer failure, and unexpected exception.
- One machine failure never stops unrelated items.
- Operation aggregates are recomputed after each terminal item and finalized after all items settle.
- Creating an operation starts it asynchronously and returns immediately.
- Closing the browser does not affect execution.
- The scheduler's live probe concurrency and the agent-operation concurrency are independent, preventing one queue from consuming every SSH slot.

Output is normalized, stripped of control characters, redacted for configured secret values and key paths, and truncated to `GPUCHECK_AGENT_OUTPUT_MAX_CHARS`. User-facing summaries remain concise; full unbounded child-process output is never persisted or returned.

## API

### Create operation

`POST /api/agent-operations`

```json
{
  "action": "install",
  "machineIds": [12, 18, 24]
}
```

Returns HTTP 202 with the created operation and item summaries. Validation is completed before any job starts.

### List recent operations

`GET /api/agent-operations?limit=20`

Returns recent operations newest first. The limit is capped. This route is admin-only because diagnostic output and operational actions are not public monitoring data.

### Get operation

`GET /api/agent-operations/:id`

Returns the operation and ordered per-machine items, including sanitized diagnostic excerpts. Unknown IDs return 404.

No cancellation or arbitrary retry endpoint is added. Retry is a new create request assembled by the UI from eligible terminal items, keeping operation history immutable.

## Web UI

### Admin shell

The header displays one of:

- `Admin locked` with an Unlock button
- `Admin unlocked` with a Lock button and, on HTTP, a persistent insecure-transport warning
- `Admin disabled` when the server has no configured key

Locked users retain the full read-only dashboard. Manual Poll, editable configuration, maintenance/expected-count mutations, machine selection, and agent controls are hidden or disabled.

### Machine selection

- Table and card views gain admin-only checkboxes.
- Selection is always explicit and keyed by machine ID.
- A Select visible action selects the currently filtered visible machines only after an explicit click.
- Changing search, filters, grouping, or view mode does not silently add machines.
- Inactive or unresolved machines cannot be selected.
- Switching to the GPU inventory view preserves machine selection but shows no GPU selection controls.
- Locking admin mode clears selection.

### Agent-management dialog

The Manage agents button displays the selected count and opens a confirmation dialog containing:

- Install/Upgrade and Uninstall actions
- exact target machine list
- current concurrency and batch count
- warning that remote passwordless `sudo` is required
- uninstall impact warning
- final action-specific confirmation button

The dialog cannot submit if selection becomes invalid, the key expires, or any target acquires an overlapping operation.

### Progress and history

After HTTP 202, the UI opens an operation drawer and polls its detail endpoint while non-terminal. It displays aggregate counts and one row per machine with status, elapsed time, summary, and expandable sanitized output.

The drawer can close without cancelling work. Recent operations are accessible from an admin-only history control after reload. Failed, skipped, and interrupted rows can be explicitly selected to construct a new operation with the same action. Successful rows are excluded from retry by default.

Current agent presence continues to come from live probe `agentVersion` data:

- version present: installed
- successful reachable probe without a version: no agent detected
- unreachable/no current result: unknown

Operation success does not override probe truth; the next live poll confirms installed presence.

## Error Handling

- Authentication errors lock the browser session on 401.
- Disabled admin mode produces a distinct 503 message and no credential retry loop.
- Inventory changes between dialog opening and submission cause server validation failure rather than targeting stale hosts.
- Per-machine SSH timeouts and installer failures become terminal failed items with sanitized diagnostics.
- Missing passwordless `sudo` remains a skipped outcome, matching the existing CLI semantics.
- Database operation-creation failure queues no work.
- Server shutdown/restart marks unfinished work interrupted on the next startup.
- Progress endpoint failures retain the last valid view and show a recoverable loading error.

## Testing Strategy

All behavioral changes use red-green TDD.

### Authentication

- admin disabled, missing key, wrong key, correct key, and rotated key
- equal-length digest comparison and no raw key in logs/responses
- every existing mutation rejects unauthenticated requests
- public read endpoints continue to work without a key
- browser key persists across reload in one tab, clears on lock/401, and is never placed in local storage

### Installer and runner

- existing CLI install, `--only`, and uninstall behavior remains intact after refactor
- fixed payloads and argument arrays; no request-controlled command construction
- bounded concurrency under slow operations
- partial failure continues remaining machines
- per-machine overlap rejection and lock release on every terminal path
- output sanitation, redaction, and truncation
- restart recovery marks queued/running rows interrupted
- install/upgrade and uninstall outcomes
- history pruning excludes active operations

### API and UI

- transactional operation creation and validation failures
- only active current-inventory machines can be targeted
- maximum batch and duplicate validation
- progress/history response shapes and 404 handling
- explicit filtered selection, confirmation contents, bulk progress, unlock/lock states, retry construction, and visible transport warning
- admin 401 during an action clears session state and returns the interface to locked mode

The aggregate `npm run check` remains the release gate.

## Rollout

1. Generate a high-entropy key outside the repository.
2. Add `GPUCHECK_ADMIN_API_KEY` and optional operation settings to the production `.env` without logging or committing the key.
3. Deploy the release and run `npm run check`.
4. Restart `gpustatuscheck` and verify public monitoring while locked.
5. Verify every protected mutation returns 401 without a key and succeeds with the key.
6. Pilot install/upgrade on one non-critical reachable machine.
7. Confirm the next live poll reports the expected agent version.
8. Pilot uninstall on that same machine and confirm the live probe no longer reports an agent version.
9. Run a small bulk operation before using the configured maximum batch.
10. Add nginx HTTPS as the next security hardening step; rotate the API key after HTTPS is enabled.

Rollback removes the new release, restores the prior commit and lockfile, rebuilds, and restarts. Database additions are backward-compatible tables and may remain unused; rollback does not delete operation history.

## Success Criteria

- Public monitoring remains functional without credentials.
- Every mutation is unavailable when admin mode is disabled and requires the configured bearer key when enabled.
- The browser retains the key only for the current tab session and locks on 401.
- Administrators can explicitly select multiple active machines and confirm install/upgrade or uninstall.
- Bulk work runs asynchronously with bounded concurrency and durable per-machine progress.
- Overlapping operations on one machine are rejected.
- Server restarts leave no operation permanently running; ambiguous work becomes interrupted.
- Agent presence remains probe-derived rather than optimistically rewritten by operation results.
- No API accepts arbitrary hosts, commands, credentials, scripts, or unit contents.
- Raw keys and unbounded installer output never enter logs, API responses, SQLite, URLs, or persistent browser storage.
- The UI and documentation clearly warn that the key is exposed on plain HTTP until nginx HTTPS is added.

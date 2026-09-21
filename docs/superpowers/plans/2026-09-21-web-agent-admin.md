# Web Agent Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tab-scoped API-key administration and durable bulk install/upgrade/uninstall of the fixed GPUStatusCheck agent from the Web UI while leaving public monitoring read-only.

**Architecture:** Introduce a pure bearer-key verifier at the Fastify boundary, refactor the existing installer into an injected reusable service, persist operation/item state in SQLite, and execute work through a bounded in-process runner. The React client keeps the key only in `sessionStorage`, explicitly selects active machines, and polls protected operation details for progress.

**Tech Stack:** TypeScript 5.7, Node.js 22, Fastify 5, React 19, better-sqlite3, Vitest 4, SSH/systemd, existing Vite build.

**Spec:** `docs/superpowers/specs/2026-09-21-web-agent-admin-design.md`

## Global Constraints

- Public read-only monitoring remains accessible without credentials.
- Every existing and new mutation is unavailable when `GPUCHECK_ADMIN_API_KEY` is empty and requires its bearer value when enabled.
- The raw admin key never enters logs, SQLite, URLs, API responses, DOM text, clipboard, or persistent `localStorage`.
- The first release explicitly supports plain HTTP and must show an insecure-transport warning until users access it through HTTPS.
- Agent operations accept only database machine IDs from the active inventory and the actions `install` or `uninstall`.
- No request may override hosts, SSH users, key paths, timeouts, scripts, service units, remote paths, or shell commands.
- Bulk execution is asynchronous, durable, bounded by `GPUCHECK_AGENT_INSTALL_JOBS`, and overlap-safe per machine.
- Unfinished operations become `interrupted` after restart and are never resumed automatically.
- Agent presence remains derived from live probe `agentVersion`, never from installer optimism.
- No client state-management dependency or authentication framework is added.
- Production deployment, key generation, and real host agent changes remain separate approval-gated operations.

## Review Focus

- A malformed Authorization header, Unicode key, or different-length key must not throw or reveal comparison timing; Task 1 tests digest-based verification for these inputs.
- Two near-simultaneous operation creations targeting the same machine must not both succeed; Task 4 tests the partial unique index and transactional conflict path.
- A runner exception after marking an item running must still terminalize the item and release its machine lock; Task 5 tests this exact failure path.
- An inventory row that becomes inactive between UI confirmation and POST must be rejected before any operation rows are inserted; Task 6 tests the server-side revalidation.
- A restored session key that receives 401 during progress polling must clear session storage and lock the UI without discarding the last valid operation view; Tasks 7 and 8 test the state transition and data preservation.

---

### Task 1: Admin authentication primitives and configuration

**Files:**
- Create: `src/server/adminAuth.ts`
- Create: `tests/adminAuth.test.ts`
- Modify: `src/server/config.ts`
- Modify: `src/server/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `.env.example`
- Modify: every `AppConfig` fixture in `tests/*.test.ts`

**Interfaces:**
- Produces: `AdminAuthState = "disabled" | "unauthorized" | "authenticated"`.
- Produces: `verifyAdminAuthorization(configuredKey: string, authorization?: string): AdminAuthState`.
- Produces: `AdminStatus = { enabled: boolean; authenticated: boolean }`.
- Produces: `adminKeyWarning(configuredKey: string): string | undefined` without returning key material.
- Extends `AppConfig` with `adminApiKey`, `agentInstallJobs`, `agentMaxBatch`, `agentOperationRetentionDays`, and `agentOutputMaxChars`.
- Extends public `RuntimeConfig` with `agentInstallJobs` and `agentMaxBatch` so the confirmation UI can display server-enforced limits without exposing secrets.

- [ ] **Step 1: Write the failing pure authentication tests**

Create `tests/adminAuth.test.ts` with literal cases:

```ts
expect(verifyAdminAuthorization("", undefined)).toBe("disabled");
expect(verifyAdminAuthorization("secret", undefined)).toBe("unauthorized");
expect(verifyAdminAuthorization("secret", "Basic secret")).toBe("unauthorized");
expect(verifyAdminAuthorization("secret", "Bearer wrong")).toBe("unauthorized");
expect(verifyAdminAuthorization("secret", "Bearer secret")).toBe("authenticated");
expect(verifyAdminAuthorization("🔐-secret", "Bearer 🔐-secret")).toBe("authenticated");
expect(() => verifyAdminAuthorization("short", "Bearer a-much-longer-value")).not.toThrow();
expect(adminKeyWarning("")).toBeUndefined();
expect(adminKeyWarning("short")).toContain("at least 32 bytes");
expect(adminKeyWarning("x".repeat(32))).toBeUndefined();
```

Name each test for the production break it catches: disabled bypass, scheme parsing, wrong key acceptance, Unicode digest handling, and length leakage.

- [ ] **Step 2: Run Task 1 tests and verify RED**

Run: `npx vitest run tests/adminAuth.test.ts`

Expected: FAIL because `src/server/adminAuth.ts` does not exist.

- [ ] **Step 3: Implement digest-based verification**

In `src/server/adminAuth.ts`, parse exactly one `Bearer ` prefix, hash configured and presented strings with SHA-256, and compare the equal-length digests with `timingSafeEqual`. Do not log either input.

```ts
export type AdminAuthState = "disabled" | "unauthorized" | "authenticated";

export function verifyAdminAuthorization(configuredKey: string, authorization?: string): AdminAuthState {
  if (!configuredKey) return "disabled";
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!presented) return "unauthorized";
  return timingSafeEqual(digest(configuredKey), digest(presented)) ? "authenticated" : "unauthorized";
}
```

- [ ] **Step 4: Extend configuration and shared types**

Add the exact defaults from the spec:

```ts
adminApiKey: value("GPUCHECK_ADMIN_API_KEY") || "",
agentInstallJobs: numberEnv(value("GPUCHECK_AGENT_INSTALL_JOBS"), 4),
agentMaxBatch: numberEnv(value("GPUCHECK_AGENT_MAX_BATCH"), 100),
agentOperationRetentionDays: numberEnv(value("GPUCHECK_AGENT_OPERATION_RETENTION_DAYS"), 30),
agentOutputMaxChars: numberEnv(value("GPUCHECK_AGENT_OUTPUT_MAX_CHARS"), 4000),
```

Add `AdminStatus` plus the two safe operation-limit fields to `RuntimeConfig`, add sample values to `.env.example`, and update every required `AppConfig` test literal. In `src/server/index.ts`, log `adminKeyWarning(config.adminApiKey)` once at startup when it returns a message; never interpolate the configured key.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/adminAuth.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck`

Expected: all tests and typecheck PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/server/adminAuth.ts src/server/config.ts src/server/index.ts src/shared/types.ts .env.example tests
git diff --cached --check
git commit -m "feat: add admin API key verification"
```

### Task 2: Protect existing mutations and expose admin status

**Files:**
- Modify: `src/server/app.ts`
- Modify: `tests/api.test.ts`
- Modify: `src/client/api.ts`
- Modify: `tests/clientApi.test.ts`

**Interfaces:**
- Consumes: `verifyAdminAuthorization` and `AppConfig.adminApiKey` from Task 1.
- Produces: `GET /api/admin/status` and protected `POST /api/admin/verify`.
- Produces: `ApiError` with `status: number` and `fetchAdminJson<T>(key, input, init?)`.

- [ ] **Step 1: Write failing route-boundary tests**

Extend `tests/api.test.ts` with an app configured with `adminApiKey: "test-admin-key"`. Assert:

```ts
expect((await app.inject({ method: "GET", url: "/api/summary" })).statusCode).toBe(200);
expect((await app.inject({ method: "GET", url: "/api/admin/status" })).json()).toEqual({ enabled: true, authenticated: false });
expect((await app.inject({ method: "POST", url: "/api/poll-runs" })).statusCode).toBe(401);
expect((await app.inject({ method: "PUT", url: "/api/config", payload: validConfig })).statusCode).toBe(401);
expect((await app.inject({ method: "PATCH", url: "/api/machines/1", payload: { maintenance: true } })).statusCode).toBe(401);
```

Repeat each mutation with `authorization: "Bearer test-admin-key"` and assert it reaches its existing behavior. Build another app with an empty key and assert mutation/verify return 503 rather than executing.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npx vitest run tests/api.test.ts -t "protects mutations|reports admin status|disables mutations"`

Expected: FAIL because the status/verify routes and protection do not exist.

- [ ] **Step 3: Implement one Fastify authentication guard**

In `buildApp`, create a local guard that returns false after sending the stable 401/503 response and call it at the start of each mutation handler. Do not protect public reads.

```ts
const requireAdmin = (authorization: string | undefined, reply: FastifyReply): boolean => {
  const state = verifyAdminAuthorization(options.config.adminApiKey, authorization);
  if (state === "authenticated") return true;
  reply.code(state === "disabled" ? 503 : 401).send({ error: state === "disabled" ? "admin mode is disabled" : "admin authentication required" });
  return false;
};
```

Register `/api/admin/status` and `/api/admin/verify`, then guard `PUT /api/config`, `PATCH /api/machines/:id`, and `POST /api/poll-runs`.

- [ ] **Step 4: Write failing client error/auth tests**

Extend `tests/clientApi.test.ts` so a 401 produces an `ApiError` whose `status` is 401 and `fetchAdminJson` adds exactly one bearer header while preserving an existing content-type header.

- [ ] **Step 5: Run client tests and verify RED**

Run: `npx vitest run tests/clientApi.test.ts`

Expected: FAIL because `ApiError` and `fetchAdminJson` do not exist.

- [ ] **Step 6: Implement the client boundary**

Make `fetchJson` throw `ApiError(message, response.status)` and implement `fetchAdminJson` by constructing `Headers` from the supplied init and setting `Authorization` without mutating the caller's object.

- [ ] **Step 7: Run targeted and full tests**

Run: `npx vitest run tests/api.test.ts tests/clientApi.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/server/app.ts src/client/api.ts tests/api.test.ts tests/clientApi.test.ts
git diff --cached --check
git commit -m "feat: protect dashboard mutations"
```

### Task 3: Refactor the SSH agent installer into a reusable service

**Files:**
- Create: `src/server/agentInstaller.ts`
- Create: `tests/agentInstaller.test.ts`
- Modify: `scripts/install-agent.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Produces shared `AgentAction = "install" | "uninstall"` in `src/shared/types.ts`.
- Produces: `AgentInstallTarget`, `AgentInstallResult`, `InstallerConfig`, and `RunInstallerCommand`.
- Produces: `runAgentAction(target, action, config, runCommand?)`.
- Preserves: current CLI `--csv`, `--only`, `--uninstall`, and `--force` behavior.

- [ ] **Step 1: Write failing installer-service tests**

Use an injected `RunInstallerCommand` fake that records command, argv, stdin, and timeout. Cover:

- install with no existing version returns `succeeded` and the fixed bundled version;
- equal version returns `skipped` unless `force` is true;
- missing passwordless sudo returns `skipped`;
- uninstall invokes only the fixed uninstall payload;
- SSH/nonzero install results return `failed` with bounded output;
- target host/port come from `AgentInstallTarget`, while user/key/timeouts come only from `InstallerConfig`.
- pure CLI argument parsing maps `--uninstall`, `--force`, `--only`, and `--csv`, rejects missing flag values, and treats `--help` as a no-SSH usage path.

Assert literal safe command arrays rather than asserting that the fake was merely called.

- [ ] **Step 2: Run installer tests and verify RED**

Run: `npx vitest run tests/agentInstaller.test.ts`

Expected: FAIL because the reusable service does not exist.

- [ ] **Step 3: Extract the service without changing payloads**

Move `AGENT_VERSION`, install/uninstall payload construction, sudo/version checks, and one-host processing into `src/server/agentInstaller.ts`. Resolve bundled assets from the repository `scripts/` directory. Keep SSH execution injectable and default it to `spawnWithInput` plus `buildSshArgs`.

Return structured results:

```ts
type AgentInstallResult = {
  outcome: "succeeded" | "skipped" | "failed";
  summary: string;
  output: string;
};
```

- [ ] **Step 4: Convert the CLI into a thin adapter**

Keep argument parsing and inventory selection in `scripts/install-agent.ts`; map `--uninstall` to `action: "uninstall"`, pass `force`, run workers as before, and format the structured outcome without duplicating SSH or payload logic.

- [ ] **Step 5: Verify service and existing CLI behavior**

Run: `npx vitest run tests/agentInstaller.test.ts tests/ssh.test.ts tests/probe.test.ts`

Expected: PASS.

Run: `npm run agent:install -- --help`

Expected: print usage, perform no SSH work, and exit zero. The pure argument-parser test written in Step 1 must fail before implementation and prove this path before this command is ever run.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/server/agentInstaller.ts src/shared/types.ts scripts/install-agent.ts tests/agentInstaller.test.ts
git diff --cached --check
git commit -m "refactor: share the agent installer"
```

### Task 4: Durable agent-operation database model

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/server/db.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Consumes: shared `AgentAction` from Task 3 without importing server code into shared types.
- Produces: `AgentOperationStatus`, `AgentOperationItemStatus`, `AgentOperation`, `AgentOperationItem`, and `AgentOperationDetail` in shared types.
- Produces database methods: `createAgentOperation`, `getAgentOperation`, `listAgentOperations`, `markAgentOperationRunning`, `markAgentOperationItemRunning`, `finishAgentOperationItem`, `finalizeAgentOperation`, `interruptAgentOperations`, and `pruneAgentOperations`.

- [ ] **Step 1: Write failing database lifecycle tests**

In `tests/db.test.ts`, use real in-memory/temporary SQLite and assert:

- transactional creation inserts one parent plus ordered machine snapshots;
- duplicate machine IDs fail without inserting a parent;
- a partial unique index rejects a second queued/running item for the same machine across operations;
- terminalizing the first item releases that machine for a later operation;
- aggregate counts/status match mixed succeeded/skipped/failed items;
- startup interruption changes queued/running items and parents to interrupted;
- pruning deletes old terminal operations but retains active and recent operations.

- [ ] **Step 2: Run database tests and verify RED**

Run: `npx vitest run tests/db.test.ts -t "agent operation"`

Expected: FAIL because operation tables and methods do not exist.

- [ ] **Step 3: Add schema and shared contracts**

Create `agent_operations` and `agent_operation_items` in `migrate()`. Add foreign keys and indexes, including:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_operation_active_machine
ON agent_operation_items(machine_id)
WHERE status IN ('queued', 'running');
```

Use immutable machine-name snapshots and store only bounded sanitized strings.

- [ ] **Step 4: Implement transactional lifecycle methods**

`createAgentOperation(action, targets, at)` validates unique IDs before starting a SQLite transaction, inserts the parent and all items, and returns `getAgentOperation(id)`. `finishAgentOperationItem` updates only non-terminal items. `finalizeAgentOperation` recomputes counts from item rows rather than trusting callers.

- [ ] **Step 5: Run targeted and full tests**

Run: `npx vitest run tests/db.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/shared/types.ts src/server/db.ts tests/db.test.ts
git diff --cached --check
git commit -m "feat: persist agent operations"
```

### Task 5: Bounded agent-operation runner

**Files:**
- Create: `src/server/agentOperations.ts`
- Create: `tests/agentOperations.test.ts`

**Interfaces:**
- Consumes: Task 3 `runAgentAction` contract and Task 4 database lifecycle methods.
- Produces: `AgentOperationRunner` with `start(operationId): void`, `recoverInterrupted(): number`, and `isMachineBusy(machineId): boolean`.
- Produces: injectable `RunAgentAction` for deterministic tests.

- [ ] **Step 1: Write failing runner tests**

Use real temporary SQLite plus deferred injected installer calls. Cover:

- no more than the configured concurrency runs simultaneously;
- one failure does not prevent remaining machines from completing;
- a thrown installer exception terminalizes that item as failed and releases the database partial-index lock;
- skipped/succeeded/failed summaries and bounded sanitized output persist correctly;
- `start()` returns immediately while work continues;
- `recoverInterrupted()` marks preexisting queued/running rows interrupted and starts no SSH work.

- [ ] **Step 2: Run runner tests and verify RED**

Run: `npx vitest run tests/agentOperations.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the runner**

Load the operation detail, mark the parent running, and process queued items with a shared-index worker pool sized by `agentInstallJobs`. Resolve each target from the immutable operation item plus current database machine record; terminalize missing/inactive targets as failed without SSH.

Normalize result output before persistence. The redaction list must include `config.adminApiKey` and `config.keyPath` when non-empty:

```ts
sanitizeAgentOutput(text, secrets, maxChars)
  .replace(controlCharacterPattern, "")
  .slice(0, maxChars);
```

Use `try/catch/finally` per item and call `finalizeAgentOperation` after `Promise.allSettled`.

- [ ] **Step 4: Run targeted and full tests**

Run: `npx vitest run tests/agentOperations.test.ts tests/db.test.ts tests/agentInstaller.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/server/agentOperations.ts tests/agentOperations.test.ts
git diff --cached --check
git commit -m "feat: run bounded agent operations"
```

### Task 6: Agent-operation API

**Files:**
- Modify: `src/server/app.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/db.ts`
- Modify: `tests/api.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 authentication, configuration, database, and runner contracts.
- Extends `BuildAppOptions` with optional injected `agentOperationRunner` for tests.
- Produces: protected `POST /api/agent-operations`, `GET /api/agent-operations`, and `GET /api/agent-operations/:id`.

- [ ] **Step 1: Write failing API validation tests**

Using Fastify injection with a valid bearer key, assert:

- install and uninstall create HTTP 202 operations for active machine IDs;
- unauthenticated list/detail/create return 401;
- empty arrays, duplicate IDs, invalid actions, batches above `agentMaxBatch`, missing IDs, and inactive IDs return 400 without inserting rows;
- a machine deactivated after the UI-equivalent confirmation setup is rejected at POST time;
- overlapping active machine IDs return HTTP 409 with a literal `machineIds` array;
- list limit is capped and detail 404s for unknown IDs;
- a request body containing host, command, user, key path, payload, or any other unknown top-level field is rejected before stored targets or installer calls are created.

- [ ] **Step 2: Run API tests and verify RED**

Run: `npx vitest run tests/api.test.ts -t "agent operation"`

Expected: FAIL because the routes do not exist.

- [ ] **Step 3: Implement server-side validation and routes**

Validate the complete body before creating rows, including rejecting unknown top-level fields. Resolve every requested ID through `db.listMachines()` and require `active !== false`. Create the operation transactionally, call `runner.start(operation.id)` only after commit, and return the detail with HTTP 202.

List/detail routes require admin authentication because item diagnostics are private operational data.

- [ ] **Step 4: Wire startup recovery and pruning**

Create the runner once in `buildApp`/`index.ts`, invoke `recoverInterrupted()` before accepting work, and call `pruneAgentOperations(config.agentOperationRetentionDays)` after completed operations and during existing history pruning without deleting active rows.

- [ ] **Step 5: Run targeted and full tests**

Run: `npx vitest run tests/api.test.ts tests/agentOperations.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/server/app.ts src/server/index.ts src/server/db.ts tests/api.test.ts
git diff --cached --check
git commit -m "feat: expose protected agent operations"
```

### Task 7: Tab-scoped admin session and locked mutation controls

**Files:**
- Create: `src/client/adminSession.ts`
- Create: `src/client/AdminAccess.tsx`
- Create: `tests/adminSession.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/MachineDetailModal.tsx`
- Modify: `src/client/api.ts`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: Task 2 `fetchAdminJson`, `ApiError`, `/api/admin/status`, and `/api/admin/verify`.
- Produces: `ADMIN_SESSION_KEY`, `loadAdminKey`, `saveAdminKey`, `clearAdminKey`, and an `AdminSessionState` reducer.
- Produces: `AdminAccess` unlock/lock UI.

- [ ] **Step 1: Write failing session lifecycle tests**

In `tests/adminSession.test.ts`, use a small injected `StorageLike` fake and reducer actions to prove:

- save/load uses session storage and never local storage;
- lock clears the key and selected machine IDs;
- restored key begins in verifying state;
- successful verification unlocks;
- 401 clears storage and locks while preserving `lastOperation` data;
- disabled status never loops verification;
- HTTPS warning derives from the provided location protocol literal.

- [ ] **Step 2: Run session tests and verify RED**

Run: `npx vitest run tests/adminSession.test.ts`

Expected: FAIL because the session module does not exist.

- [ ] **Step 3: Implement pure session utilities and reducer**

Use one namespaced `sessionStorage` key. Keep Web APIs behind injected interfaces in the pure module so Node tests do not require jsdom. The reducer owns locked/verifying/unlocked/disabled state, message, selected IDs, and last operation reference.

- [ ] **Step 4: Implement AdminAccess and mutation routing**

`AdminAccess` renders disabled, locked, verifying, and unlocked states; uses a password input; calls verify before saving; and renders a persistent insecure warning when `window.location.protocol !== "https:"`.

In `App`, route manual poll, config save, maintenance, and expected-count changes through `fetchAdminJson`. Hide or disable their controls unless unlocked. On `ApiError.status === 401`, clear the session through one shared handler.

- [ ] **Step 5: Verify static UI states without adding a DOM framework**

Use `react-dom/server` in `tests/adminSession.test.ts` to render `AdminAccess` locked, unlocked-HTTP, unlocked-HTTPS, and disabled states. Assert visible labels/warnings and that the raw key is absent from markup.

- [ ] **Step 6: Run targeted and full tests**

Run: `npx vitest run tests/adminSession.test.ts tests/clientApi.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/client/adminSession.ts src/client/AdminAccess.tsx src/client/App.tsx src/client/MachineDetailModal.tsx src/client/api.ts src/client/styles.css tests/adminSession.test.ts tests/clientApi.test.ts
git diff --cached --check
git commit -m "feat: add tab-scoped admin access"
```

### Task 8: Bulk selection, confirmation, progress, and retry UI

**Files:**
- Create: `src/client/agentAdmin.ts`
- Create: `src/client/AgentOperationDialog.tsx`
- Create: `src/client/AgentOperationDrawer.tsx`
- Create: `tests/agentAdmin.test.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/MachineTable.tsx`
- Modify: `src/client/MachineCards.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: shared agent-operation types from Task 4 and protected endpoints from Task 6.
- Produces pure helpers: `toggleMachineSelection`, `selectVisibleMachines`, `eligibleRetryMachineIds`, and `agentPresence`.
- Extends table/card props with `adminUnlocked`, `selectedMachineIds`, and `onToggleMachineSelection`.

- [ ] **Step 1: Write failing selection and retry tests**

In `tests/agentAdmin.test.tsx`, use literal machine/operation fixtures to assert:

- toggling affects only the requested ID;
- Select visible adds only currently passed filtered active IDs;
- changing the visible list does not silently mutate existing selection;
- retry includes failed/skipped/interrupted and excludes succeeded/running;
- agent presence distinguishes installed, absent after a successful probe, and unreachable/unknown;
- duplicate IDs are normalized before submission and an empty result cannot submit.

- [ ] **Step 2: Run helper tests and verify RED**

Run: `npx vitest run tests/agentAdmin.test.tsx`

Expected: FAIL because the admin selection helpers do not exist.

- [ ] **Step 3: Implement selection controls in table and cards**

Render checkboxes only when admin is unlocked. Checkbox clicks must stop row/card navigation propagation. Keep selection in `App` keyed by numeric machine ID, add explicit Select visible/Clear selection actions, preserve selection across table/card/GPU view switches, and clear it on Lock.

- [ ] **Step 4: Implement the confirmation dialog**

Render exact selected machine names, install/upgrade and uninstall choices, batch count, configured concurrency, passwordless-sudo warning, and uninstall warning. Require a final action-specific button. Revalidate selection against the latest machine list immediately before POST.

- [ ] **Step 5: Implement progress/history drawer**

After HTTP 202, store the returned operation ID, open the drawer, and poll protected detail while status is queued/running. Preserve last valid detail on request errors. Render aggregate counts, per-machine status/elapsed/summary, expandable bounded output, Close, recent-history loading, and explicit retry selection.

- [ ] **Step 6: Add bounded render tests**

Use `renderToStaticMarkup` for dialog install/uninstall confirmations and drawer mixed status output. Assert raw admin key absence, exact selected names, insecure action warnings, and eligible retry count. Keep interaction/state-transition behavior in the pure helper tests rather than adding a UI dependency.

- [ ] **Step 7: Run targeted and full verification**

Run: `npx vitest run tests/agentAdmin.test.tsx tests/adminSession.test.ts tests/clientApi.test.ts`

Expected: PASS.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/client/agentAdmin.ts src/client/AgentOperationDialog.tsx src/client/AgentOperationDrawer.tsx src/client/App.tsx src/client/MachineTable.tsx src/client/MachineCards.tsx src/client/styles.css tests/agentAdmin.test.tsx
git diff --cached --check
git commit -m "feat: manage agents from the dashboard"
```

### Task 9: Documentation, end-to-end validation, and review

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `.env.example`
- Review all files changed by Tasks 1–8.

**Interfaces:**
- Documents key generation, HTTP risk, key rotation, protected routes, bulk-operation limits, pilot install/uninstall, and rollback.
- Produces final verification and rollout evidence; does not deploy or run real agent changes.

- [ ] **Step 1: Document administration setup and HTTP risk**

Document a high-entropy key-generation command that does not echo into repository files, all new environment settings, tab-scoped unlock behavior, protected mutations, and the explicit statement that HTTP exposes the bearer key until nginx HTTPS is enabled.

- [ ] **Step 2: Document agent operation behavior**

Describe active-inventory-only targeting, install/upgrade idempotence, uninstall confirmation, bounded concurrency, passwordless-sudo skips, durable progress, restart interruption, output truncation, probe-derived presence, and retry construction.

- [ ] **Step 3: Document rollout and rollback**

Require adding `GPUCHECK_ADMIN_API_KEY` before deployment, `npm run check`, locked public smoke tests, 401/503/authorized API checks, one non-critical install/uninstall pilot, live probe confirmation, then a small bulk pilot. State that production execution requires separate approval and that the key must rotate after HTTPS is enabled.

- [ ] **Step 4: Commit the completed documentation before final review**

```bash
git add README.md CLAUDE.md .env.example
git diff --cached --check
git commit -m "docs: document web agent administration"
```

- [ ] **Step 5: Re-read spec success criteria and run a clean aggregate check**

Run: `npm ci && npm run check`

Expected: all TypeScript/Python tests, typecheck, build, and shell validation PASS.

- [ ] **Step 6: Run security-focused repository checks**

Run: `rg -n "GPUCHECK_ADMIN_API_KEY|Authorization|sessionStorage|agent-operations" src tests README.md CLAUDE.md .env.example`

Inspect every result to confirm no literal production key, URL credential, local-storage write, arbitrary command field, or raw-key log exists.

Run: `git diff --check 3e9eb39..HEAD && git status -sb`

Expected: no whitespace errors and no uncommitted implementation files before review.

- [ ] **Step 7: Request an independent whole-branch review**

Use `superpowers:requesting-code-review` with the spec, this plan, the full branch range, the Review Focus section, and any executor ledger rulings. Require explicit review of authentication bypasses, secret handling, arbitrary-command injection, operation overlap races, restart recovery, bulk-selection mistakes, and plain-HTTP documentation.

- [ ] **Step 8: Address Critical/Important review findings in one TDD pass**

For each behavioral finding, write the smallest failing regression, verify RED, implement the correction, verify GREEN, and rerun `npm run check`. Record Minor findings without expanding scope.

- [ ] **Step 9: Commit review corrections**

```bash
git add -u
git add src tests scripts README.md CLAUDE.md .env.example
git diff --cached --check
git commit -m "fix: address web agent administration review"
```

Skip this commit when review produces no code or documentation changes.

- [ ] **Step 10: Prepare the production rollout checklist without executing it**

Record the final commit, prior production commit, key-generation and `.env` steps, database backup requirement, service restart, auth smoke tests, single-machine pilot targets to be chosen by the operator, rollback commit, and commands requiring production approval.

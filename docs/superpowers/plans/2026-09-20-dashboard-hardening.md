# GPUStatusCheck Reliability and Operations Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct confirmed polling, API, and client reliability defects; make validation and deployment reproducible; and add storage health safeguards without changing the dashboard's public unauthenticated access model.

**Architecture:** Preserve the existing Fastify–scheduler–SQLite–React boundaries. Tighten their contracts with typed poll failures, a drain-before-release concurrency barrier, transactional machine settings, a shared browser JSON boundary, and an injectable storage-health probe. Operational changes remain repository artifacts until a separately approved production rollout.

**Tech Stack:** TypeScript 5.7, Node.js 22, Fastify 5, React 19, Vite 8, Vitest 4, better-sqlite3, Python unittest, Bash, systemd, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-dashboard-hardening-design.md`

## Global Constraints

- Keep public page views and all existing mutating endpoints unauthenticated.
- Do not replace SQLite, Fastify, React, SSH probing, or the current scheduler architecture.
- Do not add a client state-management library, linter, or formatter dependency.
- Use Node `>=22.12.0` and retain `npm start` as the production service entry point.
- Default `GPUCHECK_MIN_FREE_DISK_BYTES` to 5 GiB.
- Do not modify, restart, prune, compact, or replace the production database during local implementation.
- Production database maintenance requires a verified off-host backup and separately approved maintenance window.

## Review Focus

- A worker failure while another worker is still active must not release the scheduler lock; Task 1 tests this with a controlled probe gate.
- A poll failure after a poll-run row exists must return HTTP 500 with its run ID; Task 1 exercises this through Fastify injection.
- A combined PATCH with one invalid field must not mutate any valid field; Task 2 verifies database state after HTTP 400.
- A non-2xx or non-array browser response must not enter array state; Task 3 tests the shared response boundary and component error path.
- Missing database files or unavailable filesystem statistics must not crash health checks; Task 4 tests graceful unknown metrics.

---

### Task 1: Poll failure and concurrency semantics

**Files:**
- Modify: `tests/api.test.ts`
- Create: `tests/schedulerFailures.test.ts`
- Modify: `src/server/scheduler.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: `PollFailedError extends Error` with `runId: number`.
- Preserves: `PollScheduler.pollOnce(): Promise<{ runId: number; skipped: boolean }>` for successful/skipped polls; failed polls reject.
- Produces: `POST /api/poll-runs` HTTP 500 body `{ error: string, runId: number }` for typed poll failures.

- [ ] **Step 1: Write the failing concurrency regression test**

Create a two-machine scheduler test in `tests/schedulerFailures.test.ts`. Make the first injected probe throw only after the second probe has started, keep the second probe blocked on a promise, and assert that a concurrent `pollOnce()` still returns `{ runId: 0, skipped: true }` until the second probe is released.

```ts
it("keeps the polling lock until sibling workers settle after a failure", async () => {
  const secondStarted = deferred<void>();
  const releaseSecond = deferred<void>();
  const scheduler = makeScheduler(async (machine) => {
    if (machine.name === "alpha") {
      await secondStarted.promise;
      throw new Error("alpha insert failed");
    }
    secondStarted.resolve();
    await releaseSecond.promise;
    return okResult(machine);
  }, { jobs: 2 });

  const failedPoll = scheduler.pollOnce();
  await secondStarted.promise;
  await expect(scheduler.pollOnce()).resolves.toMatchObject({ skipped: true });
  releaseSecond.resolve();
  await expect(failedPoll).rejects.toMatchObject({ runId: expect.any(Number) });
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run: `npx vitest run tests/schedulerFailures.test.ts`

Expected: FAIL because the current `Promise.all` rejects early and `pollOnce()` resolves rather than throwing the failed run.

- [ ] **Step 3: Add the failing manual-poll API regression**

In `tests/api.test.ts`, inject a probe that throws, call `POST /api/poll-runs`, and assert status 500 plus a positive `runId` and the safe error text.

```ts
expect(response.statusCode).toBe(500);
expect(response.json()).toMatchObject({
  error: "probe exploded",
  runId: expect.any(Number),
});
```

- [ ] **Step 4: Run the API regression and verify RED**

Run: `npx vitest run tests/api.test.ts -t "returns a failed manual poll"`

Expected: FAIL because the current route returns HTTP 200 with `skipped: false`.

- [ ] **Step 5: Implement the drain-before-release concurrency barrier**

In `src/server/scheduler.ts`, export a typed error and replace the early-rejecting worker join with an all-settled barrier that records the first rejection only after every worker finishes.

```ts
export class PollFailedError extends Error {
  constructor(public readonly runId: number, message: string) {
    super(message);
    this.name = "PollFailedError";
  }
}

async function runConcurrent<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  // Workers retain the shared-index pattern, but all worker promises are settled
  // before the first rejection is rethrown.
}
```

After `finishPollRun(runId, error)` completes, throw `new PollFailedError(runId, this.lastError)`. Keep `running = false` exclusively in `finally`, after `runConcurrent` has drained.

- [ ] **Step 6: Map typed failures at the HTTP boundary**

In `src/server/app.ts`, catch `PollFailedError` around the manual route and return the stable JSON error contract. Re-throw unknown errors for Fastify's normal error handling.

- [ ] **Step 7: Run targeted and full TypeScript tests**

Run: `npx vitest run tests/schedulerFailures.test.ts tests/api.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all TypeScript tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/server/scheduler.ts src/server/app.ts tests/api.test.ts tests/schedulerFailures.test.ts
git commit -m "fix: report poll failures after workers settle"
```

### Task 2: Atomic machine settings

**Files:**
- Modify: `tests/api.test.ts`
- Modify: `tests/db.test.ts`
- Modify: `src/server/db.ts`
- Modify: `src/server/app.ts`

**Interfaces:**
- Produces: `DashboardDatabase.updateMachineSettings(machineId, updates)` where updates may contain `maintenance` and/or `expectedGpuCount`.
- Preserves: `PATCH /api/machines/:id` response shape.

- [ ] **Step 1: Write the failing invalid-combined-PATCH test**

Send `{ maintenance: true, expectedGpuCount: -3 }`, assert HTTP 400, then GET the machine and assert `maintenance` is still false.

- [ ] **Step 2: Run the API test and verify RED**

Run: `npx vitest run tests/api.test.ts -t "does not partially apply invalid machine settings"`

Expected: FAIL because maintenance is currently written before expected-count validation.

- [ ] **Step 3: Write the database transaction test**

In `tests/db.test.ts`, call the wished-for method with both valid fields and verify both values changed in one returned/read record.

```ts
db.updateMachineSettings(machine.id!, { maintenance: true, expectedGpuCount: 8 });
expect(db.getMachine(machine.id!)).toMatchObject({ maintenance: true, expectedGpuCount: 8 });
```

- [ ] **Step 4: Run the database test and verify RED**

Run: `npx vitest run tests/db.test.ts -t "updates machine settings transactionally"`

Expected: FAIL because `updateMachineSettings` does not exist.

- [ ] **Step 5: Implement one transactional database method**

Use a `better-sqlite3` transaction that builds only the requested assignments and performs one `UPDATE`. Retain the existing focused setters if other callers use them; route the HTTP operation through the new method.

- [ ] **Step 6: Validate the complete PATCH before writing**

Parse both supported fields, reject invalid expected counts, then call `updateMachineSettings` once. Do not write before every supplied field is valid.

- [ ] **Step 7: Run targeted and full tests**

Run: `npx vitest run tests/api.test.ts tests/db.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all TypeScript tests PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/server/app.ts src/server/db.ts tests/api.test.ts tests/db.test.ts
git commit -m "fix: apply machine settings atomically"
```

### Task 3: Shared client JSON boundary and visible loading errors

**Files:**
- Create: `src/client/api.ts`
- Create: `tests/clientApi.test.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/FleetCharts.tsx`
- Modify: `src/client/GroupCharts.tsx`
- Modify: `src/client/GpuDetailModal.tsx`
- Modify: `src/client/MachineDetailModal.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Produces: `fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T>`.
- Produces: `fetchJsonArray<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T[]>`.
- Produces: stable `Error.message` from `{ error }`, response status text, or malformed payload.

- [ ] **Step 1: Read the test quality rules before adding tests**

Read `superpowers/test-driven-development/writing-good-tests.md` in full and ensure each test names the production behavior that would make it fail.

- [ ] **Step 2: Write failing client-boundary tests**

In `tests/clientApi.test.ts`, stub `globalThis.fetch` with real `Response` objects and cover:

```ts
await expect(fetchJson("/ok")).resolves.toEqual({ value: 1 });
await expect(fetchJson("/bad")).rejects.toThrow("poll failed");
await expect(fetchJson("/plain-error")).rejects.toThrow("503 Service Unavailable");
await expect(fetchJsonArray("/object")).rejects.toThrow("Expected an array response");
```

- [ ] **Step 3: Run the helper tests and verify RED**

Run: `npx vitest run tests/clientApi.test.ts`

Expected: FAIL because `src/client/api.ts` does not exist.

- [ ] **Step 4: Implement the minimal response helpers**

Parse JSON once, reject non-2xx responses using a server `{ error }` string when present, and have the array helper call `Array.isArray` before returning.

- [ ] **Step 5: Run helper tests and verify GREEN**

Run: `npx vitest run tests/clientApi.test.ts`

Expected: PASS.

- [ ] **Step 6: Replace direct JSON fetch chains**

Use `fetchJson` or `fetchJsonArray` in `App`, fleet/group charts, GPU detail, and kernel events. The main refresh must not partially commit a mixture of successful and failed payloads. Preserve the previous valid component data when a refresh fails.

- [ ] **Step 7: Add local error presentation**

Add component-local error strings for independently loaded chart/detail sections and render them with the existing error visual language. Do not convert valid empty arrays into errors.

- [ ] **Step 8: Verify client behavior and full suite**

Run: `npx vitest run tests/clientApi.test.ts tests/api.test.ts`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npm test`

Expected: all TypeScript tests PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/client tests/clientApi.test.ts
git commit -m "fix: reject failed dashboard API responses"
```

### Task 4: Storage-aware health reporting

**Files:**
- Create: `src/server/storageHealth.ts`
- Create: `tests/storageHealth.test.ts`
- Modify: `src/server/config.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/server/app.ts`
- Modify: `tests/api.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `StorageHealth` with nullable `databaseBytes`, `freeDiskBytes`, configured `minimumFreeDiskBytes`, and optional `error`.
- Produces: `readStorageHealth(dbPath, minimumFreeDiskBytes): Promise<StorageHealth>` using `stat` and `statfs`.
- Extends: `AppConfig.minFreeDiskBytes`.
- Extends: `/api/health` with `storage` and `reasons: string[]` while preserving existing fields.

- [ ] **Step 1: Write failing storage-health unit tests**

Test a temporary database-sized file, an intentionally high threshold that marks storage unhealthy, `:memory:`, and a missing path. Inject filesystem operations into the helper if necessary to make unavailable-stat behavior deterministic.

- [ ] **Step 2: Run unit tests and verify RED**

Run: `npx vitest run tests/storageHealth.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement storage measurement**

Use `node:fs/promises` `stat` and `statfs`. Resolve the nearest existing parent for a missing database file so free-space measurement still works. Return unknown metrics plus an error string instead of throwing from the health endpoint.

- [ ] **Step 4: Write the failing health-route threshold test**

Inject a storage provider into `buildApp` that reports free space below the configured threshold. Assert HTTP 503, the storage measurements, and a `low_disk_space` reason while poll freshness remains healthy.

- [ ] **Step 5: Run the route test and verify RED**

Run: `npx vitest run tests/api.test.ts -t "reports low disk space"`

Expected: FAIL because health currently considers only poll staleness.

- [ ] **Step 6: Wire configuration and health response**

Parse `GPUCHECK_MIN_FREE_DISK_BYTES` with the existing numeric config helpers, defaulting to `5 * 1024 ** 3`. Add an optional injected storage provider to `BuildAppOptions` for deterministic tests. Health is `ok` only when polling is fresh and every known storage condition is healthy.

- [ ] **Step 7: Document the environment setting**

Add `GPUCHECK_MIN_FREE_DISK_BYTES=5368709120` to `.env.example` with a concise explanation.

- [ ] **Step 8: Run targeted and full tests**

Run: `npx vitest run tests/storageHealth.test.ts tests/api.test.ts`

Expected: PASS.

Run: `npm test && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

```bash
git add src/server/storageHealth.ts src/server/config.ts src/server/app.ts src/shared/types.ts tests/storageHealth.test.ts tests/api.test.ts .env.example
git commit -m "feat: report low disk space in health checks"
```

### Task 5: Reproducible runtime, validation, and CI

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/check-shell.sh`
- Create: `.github/workflows/ci.yml`
- Create: `deploy/gpustatuscheck.service`

**Interfaces:**
- Produces package scripts: `typecheck`, `test:python`, `check:shell`, and `check`.
- Declares Node `>=22.12.0` and the repository npm package manager version.
- Keeps `npm start` operational after `npm ci --omit=dev`.

- [ ] **Step 1: Update the runtime manifest**

Move `tsx` from `devDependencies` to `dependencies`; add `engines.node` and `packageManager`; add scripts that run the existing tests, Python suite, typecheck, production build, and shell syntax checks.

- [ ] **Step 2: Refresh the lockfile without broad dependency upgrades**

Run: `npm install --package-lock-only`

Expected: lockfile changes only reflect the root dependency classification and manifest metadata.

- [ ] **Step 3: Add deterministic shell validation**

Create `scripts/check-shell.sh` that discovers tracked `.sh` files with `git ls-files -z '*.sh'` and runs `bash -n` on each. Make it executable.

- [ ] **Step 4: Add CI using the same aggregate check**

Create `.github/workflows/ci.yml` using `actions/checkout`, `actions/setup-node` with Node 22 and npm cache, `npm ci`, and `npm run check` for pushes and pull requests.

- [ ] **Step 5: Check in the production service contract**

Create `deploy/gpustatuscheck.service` matching the observed service: user/group `ezc`, working directory `/home/ezc/gpustatuscheck`, production environment, `/usr/bin/npm start`, and restart-on-failure behavior.

- [ ] **Step 6: Verify the normal install and aggregate check**

Run: `npm ci`

Run: `npm run check`

Expected: TypeScript tests, Python tests, typecheck, client build, and shell syntax all PASS.

- [ ] **Step 7: Verify the production-only runtime contract in a temporary directory**

Use `mktemp -d`, copy `package.json` and `package-lock.json`, run `npm ci --omit=dev`, and assert `node_modules/.bin/tsx --version` succeeds. Do not alter the repository's installed modules for this probe.

- [ ] **Step 8: Commit Task 5**

```bash
git add package.json package-lock.json scripts/check-shell.sh .github/workflows/ci.yml deploy/gpustatuscheck.service
git commit -m "chore: make production validation reproducible"
```

### Task 6: Operations, backup, retention, and rollback documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Documents the exact code deployment and rollback sequence.
- Documents the SQLite online backup, retention-first pruning, measurement, integrity verification, and separately approved compaction sequence.
- Documents public unauthenticated access as an accepted risk.

- [ ] **Step 1: Document deployment prerequisites and validation**

Add Node version, `npm ci`, `npm run check`, build, service installation, restart, and local/public health checks. Make clear that the repository service file is a template and system-specific paths must be reviewed before installation.

- [ ] **Step 2: Document backup and safe retention reduction**

Provide commands based on SQLite's online `.backup` command, checksum/size verification, copying the backup off-host, setting `GPUCHECK_RETENTION_DAYS=30`, triggering one controlled poll, and measuring `page_count`/`freelist_count` afterward.

- [ ] **Step 3: Document compaction and rollback constraints**

State that in-place `VACUUM` is forbidden at the current free-space level. Require a separate destination with verified capacity, `PRAGMA integrity_check`, a stopped service for the final atomic swap, retention of the original database, and endpoint verification after restart.

- [ ] **Step 4: Document the accepted access risk**

Retain the existing warning and explicitly state that unauthenticated mutation access is an operator-approved current constraint, not an overlooked security feature.

- [ ] **Step 5: Validate documentation commands against repository scripts**

Run: `rg -n "npm run check|GPUCHECK_MIN_FREE_DISK_BYTES|GPUCHECK_RETENTION_DAYS=30|integrity_check|gpustatuscheck.service" README.md CLAUDE.md .env.example deploy/gpustatuscheck.service`

Expected: every operational concept is present and command/script names match the implementation.

- [ ] **Step 6: Commit Task 6**

```bash
git add README.md CLAUDE.md
git commit -m "docs: add safe dashboard operations runbook"
```

### Task 7: Whole-branch verification and review

**Files:**
- Review all files changed by Tasks 1–6.

**Interfaces:**
- Consumes the complete hardening release.
- Produces verification evidence only; no production deployment.

- [ ] **Step 1: Re-read the specification and map every success criterion**

Check each item in `docs/superpowers/specs/2026-09-20-dashboard-hardening-design.md` against a test, command result, or documentation section. Record any uncovered item before proceeding.

- [ ] **Step 2: Run the aggregate validation from a clean install state**

Run: `npm ci && npm run check`

Expected: all TypeScript and Python tests pass; typecheck, Vite production build, and shell syntax checks exit zero.

- [ ] **Step 3: Run repository hygiene checks**

Run: `git diff --check 508435f..HEAD`

Run: `git status -sb`

Expected: no whitespace errors and no uncommitted implementation files.

- [ ] **Step 4: Perform an independent whole-branch review**

Use the `superpowers:requesting-code-review` skill. Review specifically for scheduler race conditions, API error leakage, PATCH atomicity, stale client state, filesystem portability, health false positives, and unsafe production commands.

- [ ] **Step 5: Address review findings with TDD**

For every behavioral finding, add a failing test, verify RED, implement the minimal correction, rerun the targeted test, and rerun `npm run check`.

- [ ] **Step 6: Prepare—but do not execute—the production rollout checklist**

Capture the local commit SHA, expected service file differences, backup destination requirement, health checks, rollback SHA, and the exact state-changing commands that will require separate production approval.

- [ ] **Step 7: Commit any review-only corrections**

```bash
git add -u
git add tests src README.md CLAUDE.md package.json package-lock.json .env.example scripts deploy .github
git diff --cached --check
git commit -m "fix: address dashboard hardening review"
```

Skip this commit when review produces no code or documentation changes.

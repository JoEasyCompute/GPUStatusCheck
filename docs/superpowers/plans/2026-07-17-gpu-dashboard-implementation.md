# GPU Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node.js web dashboard that imports the GPU host CSV, polls hosts over SSH, stores historical telemetry in SQLite, and displays fleet and machine detail views.

**Architecture:** The Node backend owns configuration, CSV import, SSH probe execution, SQLite persistence, scheduling, and JSON APIs. The React frontend consumes those APIs and renders a dense operational dashboard. The existing Python CLI remains intact.

**Tech Stack:** Node.js, TypeScript, Fastify, React, Vite, SQLite, better-sqlite3, Drizzle schema definitions, Vitest.

## Global Constraints

- Runtime: Node.js with TypeScript.
- Web/API server: Fastify.
- Frontend: React with Vite.
- Database: SQLite file database.
- SQLite access: better-sqlite3.
- Schema/migrations: Drizzle.
- Probe execution: OpenSSH subprocess from the Node backend; no remote agent.
- Process enrichment: `nvidia-smi pmon -c 1` plus bounded `ps` enrichment for observed GPU PIDs.
- Existing Python CLI remains intact.

---

### Task 1: Project Scaffolding And Shared Types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/shared/types.ts`

**Interfaces:**
- Produces shared TypeScript types: `Machine`, `ProbeResult`, `GpuProcess`, `Summary`, `PollRun`.

- [ ] Create Node/Vite/TypeScript package scripts for `dev`, `build`, `test`, and `start`.
- [ ] Add shared types matching the dashboard database/API contract.
- [ ] Run `npm install` and `npm test` to verify the scaffold.

### Task 2: Inventory And Probe Parsing

**Files:**
- Create: `src/server/inventory.ts`
- Create: `src/server/probe.ts`
- Test: `tests/inventory.test.ts`
- Test: `tests/probe.test.ts`

**Interfaces:**
- Produces `readInventory(path): Machine[]`.
- Produces `parseSshDestination(ip): { host: string; port: number }`.
- Produces `parseProbeOutput(stdout): ParsedProbe`.
- Produces `parseGpuProcesses(pmonOutput, psOutput, maxArgsChars): GpuProcess[]`.

- [ ] Write failing tests for CSV import, IP port parsing, telemetry parsing, pmon parsing, and ps command-line enrichment.
- [ ] Implement parsers and remote script construction.
- [ ] Run `npm test`.

### Task 3: SQLite Persistence

**Files:**
- Create: `src/server/schema.ts`
- Create: `src/server/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces `createDatabase(dbPath): DashboardDatabase`.
- Produces methods for migration, machine upsert, poll run creation/update, probe result insert, process insert, latest machine view, history, and summary.

- [ ] Write failing database tests against a temporary SQLite file.
- [ ] Implement schema creation and repository methods.
- [ ] Run `npm test`.

### Task 4: Poll Scheduler And API

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/scheduler.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Produces `buildApp(options): FastifyInstance`.
- Produces API endpoints `/api/health`, `/api/summary`, `/api/machines`, `/api/machines/:id`, `/api/machines/:id/history`, `/api/machines/:id/processes`, `/api/poll-runs`, and `POST /api/poll-runs`.

- [ ] Write failing API tests with Fastify injection.
- [ ] Implement scheduler with no-overlap polling and manual trigger.
- [ ] Implement API routes backed by SQLite.
- [ ] Run `npm test`.

### Task 5: React Dashboard

**Files:**
- Create: `src/client/main.tsx`
- Create: `src/client/App.tsx`
- Create: `src/client/styles.css`

**Interfaces:**
- Consumes the API endpoints from Task 4.
- Produces a fleet dashboard and machine detail pane.

- [ ] Implement summary cards, machine table, filters, manual poll button, history list, and process table.
- [ ] Run `npm run build`.

### Task 6: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`
- Modify: `.env.example`

**Interfaces:**
- Documents local setup, web app env vars, and run commands.

- [ ] Document `npm install`, `npm run dev`, `npm run build`, and database location.
- [ ] Ignore SQLite runtime files and build output.
- [ ] Run `npm test`, `npm run build`, and existing Python tests.

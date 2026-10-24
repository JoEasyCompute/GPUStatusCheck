# Monitoring Reliability Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect last-contact snapshots, expose agent ingestion health, and remind about prolonged SSH failures.

**Architecture:** Keep SQLite live-probe and agent-sample source boundaries. Extend machine API results with persisted agent state, and extend the existing Telegram alert state with durable reminder timing.

**Tech Stack:** TypeScript, Fastify, SQLite/better-sqlite3, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-monitoring-reliability-enhancements-design.md`

## Global Constraints

- Live SSH probes remain authoritative for status and last contact.
- Agent samples remain historical and are drained only after successful SSH probes.
- SSH reminders default to every 6 hours; `GPUCHECK_SSH_FAILURE_REMINDER_HOURS=0` disables them.
- Reminder timestamps advance only after successful Telegram delivery.
- Maintenance machines remain muted.

## Review Focus

- A failed latest probe must not replace the last successful snapshot, including its process and GPU metric children.
- Retention must keep exactly the useful latest live rows without preserving arbitrary old history or agent samples.
- Agent drain errors and timestamps must be visible without treating agent telemetry as live contact.
- Reminder delivery failures must retry, and recovery, maintenance, and disabled cadence must suppress reminders.
- Existing status-transition and recovery alert behavior must remain intact.

### Task 1: Last-contact snapshot regression coverage

**Files:** `tests/db.test.ts`, `tests/api.test.ts`

- [x] Write tests for successful probe followed by failed probe; assert `latest` remains failed and `lastSuccessful` includes timestamp, status, CPU/disk, processes, and GPU metrics.
- [x] Write retention test with an old successful probe followed by an old failed probe; assert both survive and other old probes do not. Existing agent tests pin agent-source separation and retention.
- [x] Write an API assertion that `/api/machines` exposes the last-successful snapshot.
- [x] Run focused tests and confirm they fail before implementation where new behavior was absent.

### Task 2: Agent drain health visibility

**Files:** `src/shared/types.ts`, `src/server/db.ts`, `src/client/MachineDetailModal.tsx`, `tests/db.test.ts`, `tests/api.test.ts`

- [x] Add typed optional agent state to the machine response and assert persisted state is included.
- [x] Display agent version, last ingested sample, last drain, and last error in machine details; cover presence and missing-state cases.
- [x] Run focused tests and the client build.

### Task 3: Persistent SSH failure reminders

**Files:** `src/server/alerts.ts`, `src/server/db.ts`, `src/server/config.ts`, `.env.example`, `src/server/scheduler.ts`, `tests/alerts.test.ts`, `README.md`, `CLAUDE.md`

- [x] Test configured cadence, disabled cadence, first-failure transition, maintenance muting, recovery reset, and failed-send retry.
- [x] Add `GPUCHECK_SSH_FAILURE_REMINDER_HOURS` with default 6 and 0 as disabled.
- [x] Persist failure start and last successful notification timestamps, preserving status-transition behavior.
- [x] Run the full TypeScript test suite, Python tests, production build, and shell checks.

# Monitoring Reliability Enhancements

## Intent

Make stale machine state durable and visible, make optional-agent ingestion health observable, and remind operators about SSH failures that remain unresolved.

## Goals

- Preserve and expose the latest successful live-probe snapshot when a newer probe fails, including through retention pruning.
- Expose agent sample/drain timestamps and drain errors in machine details.
- Send periodic Telegram reminders for a continuously SSH-failed machine, with a six-hour default cadence and an environment setting to change or disable it.
- Keep live probes authoritative for machine status and keep agent samples historical.

## Non-goals

- Let the on-host agent independently change current machine status or last-contact time.
- Change Slack GPU incident behavior or send agent health notifications through Slack.
- Add a separate agent transport or push protocol.

## Approaches

- **Live-probe snapshot plus separate agent health (chosen):** keep `latest` as the newest live probe, expose `lastSuccessful` separately, and publish the persisted agent drain state in the machine detail view. This preserves the existing source boundary and needs no new agent protocol.
- **Agent sample as outage fallback:** choose an agent sample whenever it is newer than a live probe. This does not provide data collected during an outage because the server drains the spool only after SSH succeeds, and it risks implying contact that did not occur.

For SSH reminders, use the existing Telegram alert path with persisted per-machine failure/reminder timestamps. The interval is configurable with `GPUCHECK_SSH_FAILURE_REMINDER_HOURS`, defaults to 6, and `0` disables reminders. Reminder state advances only after successful Telegram delivery.

## Constraints and implementation calls

- Keep the current SSH failure as the visible current status.
- Retain both the newest live probe and newest successful live probe regardless of age; do not retain agent rows beyond their configured agent-retention window.
- Surface agent last-ingested time, last-drain time, and last error on machine details, without exposing agent internals as current status.
- Respect maintenance muting and Telegram configuration.
- Add regression tests for success-then-failure snapshots, retention, agent-source separation/health, and reminder cadence/retry behavior.

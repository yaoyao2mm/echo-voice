# Codex Remote Architecture Risk Tracker

This document tracks the three highest-priority design risks in the mobile Codex remote-control architecture and the current remediation status.

## 1. Model Capability Negotiation

**Status:** Partially fixed

**Problem:** The mobile UI can request a model such as `gpt-5.5`, but support was previously inferred from static defaults or `ECHO_CODEX_UNSUPPORTED_MODELS`. That makes the model switch feel more authoritative than it really is.

**Target design:** The desktop agent should be the source of truth for Codex runtime capability. It should report the models returned by the local Codex app-server when available, and the relay should reject or downgrade requests outside that capability set before they are leased to a desktop agent.

**Tracking:**

- [x] Desktop agent probes `model/list` from the local Codex app-server.
- [x] Relay stores and exposes supported model metadata from the active agent.
- [x] Relay normalizes requested session runtime against the active agent capability.
- [x] Mobile UI disables models that the desktop agent does not advertise.
- [ ] Improve multi-agent/project-specific capability display in the mobile UI.

## 2. Desktop-Owned Runtime Policy

**Status:** Partially fixed

**Problem:** The mobile client can submit `sandbox`, `approvalPolicy`, `profile`, model, and reasoning settings. That gives the phone too much authority over local execution policy.

**Target design:** The mobile client can request a runtime mode, but the relay should only accept known permission presets instead of arbitrary `sandbox` and `approvalPolicy` strings. Full access remains a first-class phone-side option and does not require an extra Echo desktop approval; selecting it maps directly to `danger-full-access` plus `never`.

**Tracking:**

- [x] Desktop agent reports allowed permission modes.
- [x] Relay sanitizes mobile runtime requests against desktop-reported policy.
- [x] Full access remains available from the phone without an extra desktop approval.
- [x] Mobile UI disables permission modes the desktop agent does not advertise.
- [ ] Add desktop settings UI for editing the allowed permission mode list.

## 3. Split State Ownership

**Status:** Open

**Problem:** The relay owns sessions, command leases, runtime metadata, and thread ids, while the local Codex app-server owns actual execution state. The system relies on polling, leases, heartbeats, and event replay to keep them consistent.

**Target design:** Keep the relay/desktop split, but make synchronization failures explicit and recoverable. The relay should understand when a thread was restarted, when an active turn cannot accept model/policy changes, and when a session must be recovered with a fresh thread.

**Tracking:**

- [ ] Document which state belongs to relay vs. desktop app-server.
- [ ] Surface "model changes apply on next turn" clearly in the UI.
- [ ] Add explicit recovery events for thread replacement and stale active turns.
- [ ] Add tests for runtime changes across resumed sessions and failed thread recovery.

## 4. Workflow and Status Flow Review - 2026-05-01

**Status:** Open

This section records the current review findings for the Codex turn, Git, deploy, worktree, and mobile status flows. These are deferred fixes, not completed remediation.

### High Priority

- [x] Keep desktop session heartbeats alive for the full Codex turn.
  - **Problem:** The desktop agent starts its heartbeat around `runtime.handleCommand()`, but `turn/start` returns once the app-server accepts the turn, not when the turn completes. A long quiet turn can stop renewing the session lease and be reclaimed as `active` even though Codex is still running.
  - **Impact:** The relay can clear `activeTurn`, show the phone as ready, and allow conflicting follow-up work while the local Codex process is still executing.
  - **Refs:** `src/desktop-agent.js`, `src/lib/codexInteractiveRunner.js`, `src/lib/codexStore.js`.
  - **Fix:** Desktop now keeps a per-session running heartbeat alive after a turn is accepted and stops it on `turn/completed`, compaction completion, interrupt, or execution failure.

- [ ] Separate command execution failure from result-reporting failure.
  - **Problem:** If Codex finishes successfully but posting `/commands/complete` fails, the desktop agent catch path can report the command as failed or leave the lease to expire.
  - **Impact:** Completed work can be marked failed or requeued, creating duplicate execution risk.
  - **Refs:** `src/desktop-agent.js`.
  - **Fix direction:** Persist the command result locally, retry reporting idempotently, and avoid converting report transport failures into execution failures.

- [ ] Make terminal event delivery durable.
  - **Problem:** `onEvents` posts session events fire-and-forget and swallows errors. Final deltas, `turn/completed`, and `git.summary` can be lost while command completion still succeeds.
  - **Impact:** Mobile state can show a completed session without the final summary, Git result, or terminal event trail.
  - **Refs:** `src/desktop-agent.js`, `src/lib/codexInteractiveRunner.js`.
  - **Fix direction:** Add retry/backoff or a small local event outbox for terminal events and generated summaries.

### Medium Priority

- [ ] Replace quick deploy prompt semantics with structured publish/deploy state.
  - **Problem:** The top-right action currently instructs Codex to commit, push, merge into the deploy branch, and trigger deployment, but the UI state only represents request queue/send completion.
  - **Impact:** The phone can say the action is done while Git merge or main-branch deployment is still pending or failed.
  - **Refs:** `public/app/codex.js`, `public/index.html`.
  - **Fix direction:** Have the desktop agent emit structured `git.publish.summary` and `deploy.summary` events with branch, commit, workflow run URL, and conclusion.

- [ ] Bound and redact raw session event storage.
  - **Problem:** Session event normalization can store raw app-server payloads without a strict size cap or redaction pass.
  - **Impact:** Large output, diffs, or sensitive values can accumulate in SQLite and be replayed to clients.
  - **Refs:** `src/lib/codexInteractiveRunner.js`, `src/lib/codexStore.js`.
  - **Fix direction:** Truncate raw payloads, redact known secret-shaped fields, and drop large fields such as aggregated output or full diffs from persisted raw event data.

- [ ] Move temporary attachments out of repository workspaces.
  - **Problem:** Attachments are materialized under `.echo-codex-attachments` inside the target repo. A crash can leave untracked files in the checkout, and worktree creation refuses a dirty base.
  - **Impact:** Mobile tasks with attachments can dirty the active repo and block future worktree execution.
  - **Refs:** `src/lib/codexInteractiveRunner.js`, `src/lib/codexWorktree.js`.
  - **Fix direction:** Store temporary attachments under the Echo data directory outside the repo, or ensure the path is ignored and cleaned up during startup/session recovery.

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

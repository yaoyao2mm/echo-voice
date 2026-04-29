# Mobile Codex Remote Roadmap

## Product Boundary

Echo should not become a remote shell. It should be a guarded task queue for local Codex:

- The phone captures quick ideas, turns them into tasks, submits them, and reviews progress.
- The public relay authenticates users, queues jobs, stores limited state, and streams progress.
- The desktop agent is the only process that can touch local repositories or run Codex.
- The desktop agent only makes outbound HTTPS requests to the relay.
- Codex jobs run only inside `ECHO_CODEX_WORKSPACES`.
- The default runtime is `codex exec --json` with the `workspace-write` sandbox.

This keeps the core promise clear: say or type an idea on the phone, queue it for Codex, run it on the local PC, and watch progress without exposing the local machine to inbound internet traffic.

## Product North Star

The ideal workflow is:

1. Capture a rough idea from the phone.
2. Let Echo structure it into a clear Codex task.
3. Put that task into a queue.
4. Let the desktop agent execute it locally.
5. Review status, output, changed files, and follow-up options from the phone.

Today, jobs may run directly in the selected allowlisted workspace. The future execution model should create an isolated Git worktree per job so Codex can work without polluting the user's active checkout. The user should be able to inspect the result, continue the task, apply/merge the change, or discard the entire worktree.

## Experience Principle

Echo should feel like the missing mobile companion to the local Codex client:

- Starting a job should feel as direct as opening Codex on the computer and typing a task.
- Watching a job should feel like watching the local Codex client work: status, reasoning/output, tool activity, errors, and final answer are all visible.
- Follow-up should preserve context. The user should not have to copy old logs or rewrite the previous task by hand.
- Local trust boundaries remain desktop-owned. The phone can request, monitor, and decide, but the desktop agent owns filesystem access, Git worktrees, Codex credentials, and execution policy.
- If an official mobile Codex client exists someday, Echo should still be useful as a local-worktree and relay layer rather than a generic chat clone.

## Non-Goals

- No arbitrary remote shell endpoint.
- No arbitrary filesystem paths from the phone.
- No public exposure of Codex `app-server`.
- No remote approval flow in the first stable version.
- No GitHub self-hosted runner as the primary execution channel.

## Phase 1: Reliable MVP

Goal: submit a task from the phone, run it locally, and show a useful result.

### Scope

- Keep the relay plus desktop-agent architecture.
- Keep `ECHO_CODEX_WORKSPACES` as the only project selection mechanism.
- Run tasks with `codex exec --json`.
- Show desktop online status, allowed projects, queued/running job, recent jobs, logs, errors, and final message.
- Keep the default sandbox at `workspace-write`.

### Implementation Tasks

- Normalize job statuses:
  - `queued`
  - `running`
  - `completed`
  - `failed`
  - `cancelled`
- Parse JSONL events from Codex into display-friendly event types:
  - runner lifecycle
  - command execution
  - file changes
  - stderr
  - Codex error
  - final agent message
- Cap stored events per job.
- Cap event text size.
- Improve failure messages for common cases:
  - Codex CLI missing
  - Codex login missing
  - unsupported model
  - sandbox denial
  - workspace not found
  - timeout

### Done When

- A phone can submit "run tests and fix the failure" against an allowlisted repo.
- The desktop agent pulls the task and runs it locally.
- The phone can see the task move from queued to running to completed or failed.
- The phone shows enough error detail to know whether the issue is Codex, permissions, model config, workspace config, or project tests.

## Phase 2: Permission Model

Goal: turn Codex permissions into a small set of understandable product modes.

### Permission Presets

#### Safe

- Sandbox: `workspace-write`.
- Network: off by default.
- Intended for reading code, small edits, tests that do not require downloads, and documentation updates.

#### Repo Trusted

- Sandbox: `workspace-write`.
- Uses a named Codex profile or ruleset for trusted repo commands.
- Intended for common local commands such as `pnpm test`, `pnpm run lint`, `pytest`, or repo-specific scripts.

#### Network Needed

- Allows tasks that may need network access, dependency installation, package metadata, or external docs.
- Must be selected explicitly.
- Should be visually distinct in the mobile UI.

#### Full Access

- Only enabled from the desktop settings UI.
- Not offered as a normal phone-side option.
- Requires clear warning text and should be treated as an escape hatch, not a default workflow.

### Implementation Tasks

- Add `ECHO_CODEX_PERMISSION_PRESET`.
- Add optional per-workspace preset overrides.
- Show active sandbox/profile/model in the phone UI before task submission.
- Add a "permission needed" failure state when Codex cannot proceed.
- Avoid phone-side remote approvals for the first stable version.

### Done When

- The user can understand what a task is allowed to do before running it.
- Permission failures are legible instead of mysterious.
- Riskier modes require explicit choice.

## Phase 3: Progress Experience

Goal: make long-running tasks feel visible and controllable.

### Scope

- Upgrade job progress from polling-only to server-sent events or WebSocket.
- Prefer SSE first because it is simple and fits one-way progress updates.
- Keep desktop agent reporting events with ordinary HTTPS POSTs.

### Implementation Tasks

- Add `GET /api/codex/jobs/:id/events` as an SSE endpoint.
- Keep polling endpoints as fallback.
- Split job detail into:
  - overview
  - timeline
  - detailed logs
  - final response
  - error details
- Add task controls:
  - cancel
  - retry
  - follow-up
- After completion, ask the desktop agent for a local change summary:
  - `git status --short`
  - `git diff --stat`
  - optionally changed file list

### Done When

- The phone updates while Codex is running without manual refresh.
- The user can cancel a task.
- The user can see which files changed after a successful run.

## Phase 4: Reliable Storage And Agent Leasing

Goal: stop relying on in-memory queues for anything important.

### Scope

- Store jobs and events persistently.
- Make agent polling safe if the process restarts.
- Prevent duplicate execution.

### Implementation Tasks

- Add SQLite storage for the relay:
  - `jobs`
  - `job_events`
  - `agents`
  - `sessions` if needed
- Add job leases:
  - `leased_by`
  - `lease_expires_at`
  - `agent_id`
- Add stale-job handling:
  - return stale running jobs to queued, or
  - mark them failed with a clear stale-agent reason.
- Add pagination for events.
- Add retention policies:
  - max jobs
  - max events per job
  - max event age

### Done When

- Restarting the relay does not lose recent jobs.
- A crashed desktop agent does not leave the system permanently stuck.
- A task cannot be executed twice by accident.

Current implementation:

- Codex jobs, events, and agents are stored in SQLite at `~/.echo-voice/echo.sqlite`.
- The desktop agent stores a stable local id in `~/.echo-voice/desktop-agent-id`.
- Running jobs are leased to an agent via `leased_by` and `lease_expires_at`.
- Codex event posts and quiet desktop-agent heartbeats renew the lease.
- Completion posts clear the lease.
- Expired leases are returned to `queued` and annotated with a `lease.expired` event.

## Phase 5: Desktop Agent Hardening

Goal: make the local agent feel like a dependable desktop service.

### Scope

- Improve diagnostics.
- Improve startup checks.
- Improve agent identity and heartbeat.

### Implementation Tasks

- Generate a stable local `agent_id`.
- Heartbeat every 15-30 seconds with:
  - agent id
  - hostname
  - online timestamp
  - Codex command path
  - Codex version if available
  - model/profile/sandbox
  - allowlisted workspaces
- Add a Codex doctor:
  - Codex CLI exists
  - Codex can run a tiny non-mutating command
  - Codex login appears valid
  - workspace paths exist
  - workspace paths are Git repos when expected
  - relay is reachable
  - proxy config works
- Expose doctor results in the desktop settings page.

### Done When

- A broken setup explains itself.
- The phone can distinguish "agent offline" from "agent online but Codex misconfigured".
- The desktop settings UI can fix or point to the most common setup issues.

## Phase 6: Mobile Workflow

Goal: make the phone interface efficient enough for daily use.

### Views

#### Dashboard

- Agent online state.
- Current running job.
- Recent jobs.
- Allowed workspaces.
- Active runtime summary.

#### New Task

- Workspace picker.
- Prompt box.
- Native phone keyboard and voice-input text capture.
- Post-processing modes for Codex task, execution plan, structured notes, and light cleanup.
- Permission preset picker.
- Model/profile display.
- Optional toggles:
  - run tests after changes
  - summarize diff after completion
  - stop on first test failure

#### Job Detail

- Status.
- Timeline.
- Logs.
- Final response.
- Error details.
- Changed files summary.
- Cancel/retry/follow-up controls.

#### Templates

- Fix failing tests.
- Implement a small feature.
- Explain this repository.
- Write or update tests.
- Review recent changes.
- Summarize today's work.

### Done When

- Starting a useful task takes less than a minute from the phone.
- Re-running and following up do not require copying old context manually.
- Common tasks feel like product flows, not raw prompt entry.

## Phase 7: Security Hardening

Goal: make the internet relay boring to operate.

### Authentication

- Keep desktop-agent token separate from web login sessions.
- Use long random tokens for agents.
- Support per-device or per-user web sessions.
- Add session expiration and logout.

### Abuse Controls

- Rate limit login.
- Rate limit job creation.
- Limit prompt size.
- Limit concurrent running jobs per user.
- Limit total queued jobs.

### Log Safety

- Mask common secret patterns before storing relay-side events.
- Avoid uploading `.env` file contents.
- Truncate raw events.
- Add retention controls.

### Audit Trail

Store enough metadata to answer:

- Who created the job?
- Which workspace was selected?
- Which agent ran it?
- Which sandbox/profile/model was used?
- When did it start and finish?
- What was the exit code?

### Done When

- A leaked web session is less damaging than a leaked agent token.
- Logs are useful for progress but not an unbounded secret sink.
- The relay can be exposed behind HTTPS with confidence.

## Phase 8: Isolated Worktree Execution

Goal: let each queued idea run in its own local Git worktree, so Codex can change files without touching the user's active checkout.

### Execution Model

- Keep `ECHO_CODEX_WORKSPACES` as the trusted project allowlist.
- For each job, create a job branch and worktree under a desktop-controlled directory, for example:
  - branch: `echo/job-<short-id>`
  - worktree: `~/.echo-voice/worktrees/<workspace-id>/<job-id>`
- Run `codex exec --json` inside the job worktree.
- Store the worktree path, branch name, base branch, base commit, and final commit status on the job.
- Keep the original workspace untouched unless the user explicitly applies or merges the result.

### Safety Rules

- Only create worktrees for Git repositories.
- Refuse worktree mode if the base workspace has unresolved Git state that makes the base ambiguous.
- Never let the phone choose arbitrary worktree paths.
- Clean up stale worktrees through a retention policy, not immediately after completion.
- Keep `danger-full-access` as a desktop-only escape hatch.

### Phone Experience

- A queued job shows whether it will run in the main workspace or an isolated worktree.
- A completed job shows:
  - changed file summary
  - diff stat
  - branch/worktree name
  - final Codex response
  - apply/merge/discard options
- Follow-up tasks can continue in the same worktree before the user applies the result.

### Desktop Experience

- Settings expose:
  - worktree mode: off | optional | always
  - worktree root directory
  - retention count or retention days
- Doctor checks:
  - Git availability
  - workspace is a Git repository
  - worktree root is writable
  - branch naming does not collide

### Done When

- A phone-submitted idea can run in an isolated worktree.
- The user's active checkout does not change while the task is running.
- The phone can show what changed and let the user keep working, apply, or discard.
- Failed jobs leave enough metadata to inspect or clean up the worktree.

## Phase 9: Advanced Capabilities

Goal: add power only after the safe path is stable.

### Interactive Sessions

- Consider Codex `app-server` only over localhost, SSH forwarding, Tailscale, or another private tunnel.
- Do not expose it directly to the public internet.
- Treat WebSocket-based app-server workflows as a later layer, not the MVP foundation.

### Remote Approvals

- Add only after the permission preset model is stable.
- Prefer approving known command prefixes over arbitrary commands.
- Keep high-risk operations as desktop-only confirmation.

### Multiple Agents

- Register each desktop with an `agent_id`.
- Bind workspaces to agents.
- Let the phone choose target machine and workspace.

### GitHub Flow

- Let the desktop agent create a branch after successful changes.
- Optionally commit locally.
- Optionally push and open a PR.
- Keep merge/release decisions in GitHub.

## Suggested Build Order

Progress:

- Done: replace in-memory Codex jobs/events with SQLite.
- Done: persist desktop agent heartbeats and runtime/workspace snapshots.
- Done: add stable desktop agent identity.
- Done: lease running Codex jobs and return expired leases to the queue.

Next build order:

1. Add cancellation.
2. Add SSE job events.
3. Add Codex doctor.
4. Add permission presets.
5. Add isolated worktree metadata to jobs.
6. Add desktop-side worktree creation behind a feature flag.
7. Improve mobile job detail and timeline.
8. Add post-run `git status` and `git diff --stat`.
9. Add apply/discard/follow-up flows for worktree jobs.
10. Add log masking and retention.
11. Add templates and follow-up tasks.

## References

- OpenAI Codex non-interactive mode: https://developers.openai.com/codex/noninteractive
- OpenAI Codex approvals and sandboxing: https://developers.openai.com/codex/agent-approvals-security
- OpenAI Codex remote connections: https://developers.openai.com/codex/remote-connections
- OpenAI Codex app-server: https://developers.openai.com/codex/app-server
- Tailscale SSH: https://tailscale.com/docs/features/tailscale-ssh
- Cloudflare Tunnel: https://developers.cloudflare.com/tunnel/

# Mobile Codex Remote Plan

## Summary

Echo is a mobile control surface for local engineering work. The phone is the idea capture and review surface; the desktop agent is the only process allowed to touch local repositories.

See [Mobile Codex Remote Roadmap](mobile-codex-roadmap.md) for the detailed implementation path.

## Phase 1: One-Shot Local Codex Tasks

- Phone submits a structured task to the public relay.
- Desktop agent polls the relay, validates the selected project against `ECHO_CODEX_WORKSPACES`, then starts or continues a local `codex app-server` thread.
- Relay stores task status, recent events, final message, and errors.
- Phone shows desktop online status, allowlisted projects, recent tasks, and job logs.
- Safety default: no arbitrary shell endpoint, no arbitrary paths, `workspace-write` sandbox.

## Phase 2: Better Mobile Workflow

- Treat the phone composer as an idea inbox: rough thoughts become structured Codex tasks.
- Add task templates: bug fix, implement feature, review PR, write tests, explain code.
- Add project context snippets and per-project preferences before sending to Codex.
- Add explicit controls for stop/retry/follow-up.
- Add change summaries by reading `git status` and `git diff --stat` after a task.

## Phase 3: Isolated Worktrees

- Let the desktop agent create a per-job Git worktree under a controlled local directory.
- Run Codex in that isolated worktree instead of the user's active checkout.
- Track branch, worktree path, base commit, changed files, and diff stat on the job.
- Let the phone continue, apply/merge, or discard the worktree result.

## Phase 4: Interactive Session

- Use Codex `app-server` to support real interactive sessions.
- Stream structured events instead of polling static logs.
- Handle approvals and human input from the phone.
- Support session resume/fork from mobile.

## Assumptions

- The desktop agent runs on the machine with the real working tree and Codex login.
- The public relay is trusted to store prompts and logs.
- The phone already has good native dictation, so Echo only receives text.

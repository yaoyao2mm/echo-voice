# Echo Codex Agent Notes

## Product Intent

Echo is a remote control surface for local Codex, not a remote shell.

- The phone/PWA captures tasks, reviews progress, sends follow-ups, and makes explicit approval decisions.
- The relay authenticates users, queues work, stores session state, and streams progress.
- The desktop agent is the only process allowed to touch local repositories or start Codex.
- Codex app-server must stay local to the desktop agent over stdio; never expose it directly to the public internet.
- Phone requests must stay inside desktop-advertised workspaces. Do not add arbitrary path or shell execution APIs.

## Current Priority

Build toward a dependable remote Codex companion:

1. Mobile cancel/interrupt for the active Codex turn.
2. Realtime session updates via SSE, with polling kept as fallback.
3. Desktop-generated Git result summaries after turns complete.
4. Optional desktop-controlled Git worktree execution so remote tasks do not modify the active checkout.

## Development Notes

- Use `pnpm test` for the Node test suite.
- Use `pnpm run check:js` after touching server, desktop agent, or browser JavaScript.
- Use `pnpm run test:e2e:mobile` for mobile PWA behavior when UI flows change.
- The relay data store is SQLite at `~/.echo-voice/echo.sqlite` unless tests override `HOME`.
- Keep migrations compatible with existing local databases.
- Keep the default worktree mode off unless the desktop owner enables it.

## Safety Boundaries

- Keep `ECHO_CODEX_WORKSPACES` as the trusted allowlist.
- Risky execution modes must come from desktop-advertised policy, not arbitrary mobile strings.
- Approval requests from Codex should be visible on mobile and require an explicit decision.
- Logs and events are useful, but avoid adding unbounded secret-heavy storage.
- Do not revert user work in the active checkout. Worktree mode should protect that checkout by default when enabled.

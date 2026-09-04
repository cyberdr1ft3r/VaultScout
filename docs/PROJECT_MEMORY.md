# SubWatch project memory

> Durable handoff context for humans and coding agents. Read this first and update it when project reality changes.

## Goal

Build a local-first application that checks authenticated subscription billing pages and presents upcoming payments without storing account passwords or performing billing mutations.

## Current state

- Repository: `cyberdr1ft3r/SubWatch`
- Visibility: public
- Runtime: Node.js 22+ and TypeScript
- Implemented: CLI foundation, typed connector contract, subscription validation, secure data-directory creation, demo connector, tests
- Next milestone: reusable interactive Playwright authentication and session management
- Real providers selected: none yet

## Architecture decisions

| Decision | Status | Reason |
| --- | --- | --- |
| Local-first execution | Accepted | Authenticated billing data should remain on the user's machine. |
| Provider-specific connectors | Accepted | Billing pages and extraction rules differ by provider. |
| Browser sessions instead of stored passwords | Accepted | Reduces credential exposure while allowing repeat checks. |
| Read-only connectors | Accepted | SubWatch must not purchase, cancel, or modify subscriptions. |
| GitHub Issues as task source of truth | Accepted | Keeps work discoverable across Codex sessions. |

## Security invariants

- Never accept or store plaintext passwords.
- Never log secrets, cookies, tokens, full authenticated HTML, or sensitive screenshots.
- Session state stays under `.subwatch/` and must remain ignored by Git.
- MFA and CAPTCHA require interactive user involvement.
- Connectors may only read billing information.
- Any feature capable of payment, cancellation, or account modification is out of scope.

## Working agreement

At the start of a session, read this file and the open GitHub Issues. Select one issue and restate its intended outcome. Before ending, run checks, update the issue, and revise this file if facts or decisions changed.

## Last handoff

- Date: 2026-09-04
- Completed: repository bootstrap and continuity system
- Verified: TypeScript check and two unit tests pass
- Resume with: session-vault issue, then the first real provider connector
- Blocked on: user choosing the first three subscription providers

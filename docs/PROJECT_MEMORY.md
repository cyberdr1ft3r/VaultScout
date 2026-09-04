# SubWatch project memory

> Durable handoff context for humans and coding agents. Read this first and update it when project reality changes.

## Goal

Build a local-first application that checks authenticated subscription billing pages and presents upcoming payments without storing account passwords or performing billing mutations.

## Current state

- Repository: `cyberdr1ft3r/SubWatch`
- Visibility: public
- Runtime: Node.js 22+ and TypeScript
- Implemented: CLI and connector foundation, subscription validation, encrypted session vault, generic interactive Playwright authentication, demo connector, synthetic tests
- Next milestone: sanitized connector fixture harness
- Real providers selected: none yet

## Architecture decisions

| Decision | Status | Reason |
| --- | --- | --- |
| Local-first execution | Accepted | Authenticated billing data should remain on the user's machine. |
| Provider-specific connectors | Accepted | Billing pages and extraction rules differ by provider. |
| Browser sessions instead of stored passwords | Accepted | Reduces credential exposure while allowing repeat checks. |
| AES-256-GCM sessions with OS-keyring keys | Accepted | Keeps browser state encrypted at rest without a plaintext key fallback. |
| Opaque provider/account session paths | Accepted | Isolates accounts beneath the configured data directory without exposing identifiers in filenames. |
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
- Completed: Issue #3 session-vault foundation with OS-keyring-backed encryption, atomic writes, restrictive permissions, lifecycle states, and generic interactive login capture
- Verified: strict TypeScript check and all 8 tests pass, including a synthetic local-page Playwright authentication test
- Limitations: no real provider connector or CLI login command; Playwright browser binaries must be installed; Linux requires an unlocked Secret Service; same-user malware remains outside the encryption threat model
- Resume with exactly: GitHub Issue #2, implement the sanitized connector fixture harness and its safety checks
- Blocked on after Issue #2: user choosing the first three subscription providers

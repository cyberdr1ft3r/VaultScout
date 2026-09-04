# SubWatch project memory

> Durable handoff context for humans and coding agents. Read this first and update it when project reality changes.

## Goal

Build a local-first application that checks authenticated subscription billing pages and presents upcoming payments without storing account passwords or performing billing mutations.

## Current state

- Repository: `cyberdr1ft3r/SubWatch`
- Visibility: public
- Runtime: Node.js 22+ and TypeScript
- Implemented: CLI and connector foundation, subscription validation, encrypted session vault, generic interactive Playwright authentication, sanitized offline connector fixture harness, local SQLite check history, secure local renewal dashboard, demo connector
- Next milestone: first read-only provider connector after provider selection
- Real providers selected: none yet

## Architecture decisions

| Decision | Status | Reason |
| --- | --- | --- |
| Local-first execution | Accepted | Authenticated billing data should remain on the user's machine. |
| Provider-specific connectors | Accepted | Billing pages and extraction rules differ by provider. |
| Browser sessions instead of stored passwords | Accepted | Reduces credential exposure while allowing repeat checks. |
| AES-256-GCM sessions with OS-keyring keys | Accepted | Keeps browser state encrypted at rest without a plaintext key fallback. |
| Opaque provider/account session paths | Accepted | Isolates accounts beneath the configured data directory without exposing identifiers in filenames. |
| Static synthetic connector fixtures | Accepted | Enables deterministic extraction tests with JavaScript disabled and every network request blocked. |
| SQLite latest-state plus append-only history | Accepted | Supports dashboard reads and safe history pruning while retaining current subscription and connector state. |
| Loopback read-only dashboard | Accepted | Presents private local read models with Host validation, strict browser headers, and no connector or mutation surface. |
| Read-only connectors | Accepted | SubWatch must not purchase, cancel, or modify subscriptions. |
| GitHub Issues as task source of truth | Accepted | Keeps work discoverable across Codex sessions. |

## Security invariants

- Never accept or store plaintext passwords.
- Provider login URLs require HTTPS; HTTP is limited to explicit loopback hosts for synthetic tests.
- Never log secrets, cookies, tokens, full authenticated HTML, or sensitive screenshots.
- Never derive connector fixtures from captured provider pages; fixtures must be hand-written, synthetic, and sanitizer-approved.
- Session state stays under `.subwatch/` and must remain ignored by Git.
- SQLite stores only normalized billing metadata, opaque account references, outcomes, and redacted failure codes under the configured data directory.
- Dashboard APIs are GET-only, bind to loopback by default, validate Host headers, and never expose full opaque account references.
- MFA and CAPTCHA require interactive user involvement.
- Connectors may only read billing information.
- Any feature capable of payment, cancellation, or account modification is out of scope.

## Working agreement

At the start of a session, read this file and the open GitHub Issues. Select one issue and restate its intended outcome. Before ending, run checks, update the issue, and revise this file if facts or decisions changed.

## Last handoff

- Date: 2026-09-04
- Completed: Issue #4 production-built local renewal dashboard with summary metrics, renewals, warning states, history details, responsive themes, loopback/Host controls, and read-only APIs
- Verified: strict TypeScript check, production build, and all 75 tests pass; production audit reports no vulnerabilities; desktop light and mobile dark layouts verified with synthetic-only data and same-origin requests
- Limitations: no real provider connectors populate the dashboard yet; history is limited to 200 recent checks with no pagination; non-loopback mode has no authentication and is explicitly unsafe outside a trusted network
- Resume with exactly: select the first subscription provider, create its connector issue from the template, then implement a read-only connector using only hand-written synthetic fixtures
- Blocked on: user choosing the first subscription provider

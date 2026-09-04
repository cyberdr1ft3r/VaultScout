# VaultScout project memory

> Durable handoff context for humans and coding agents. Read this first and update it when project reality changes.

## Goal

Build a local-first, agent-safe access broker that lets an authorized AI check
subscription billing pages without receiving credential values. Original
credentials remain in a mature password manager; VaultScout enforces a narrow,
domain-bound, read-only login-and-check capability.

## Current state

- Repository: `cyberdr1ft3r/VaultScout`
- Visibility: public
- Runtime: Node.js 22+ and TypeScript
- Implemented: end-to-end synthetic `check_subscription` flow, domain-bound broker with synthetic fake and production local 1Password backends, encrypted session reuse, controlled Playwright login, strict normalized extraction, SQLite outcomes, fixture harness, demo connector, and CLI foundation
- Corrected product direction: VaultScout is an AI credential broker for subscription checks, not merely a renewal dashboard and not a password-manager replacement
- Credential system of record: 1Password for the first vertical slice
- Next milestone: one-credential, one-domain 1Password broker proof of concept with no agent-visible secret channel
- Real providers selected: none yet

## Architecture decisions

| Decision | Status | Reason |
| --- | --- | --- |
| Local-first execution | Accepted | Authenticated billing data should remain on the user's machine. |
| Established password manager as credential system of record | Accepted | Building and auditing a new password vault is outside the product goal. |
| 1Password as the first credential backend | Accepted | Its supported local desktop integration and OS authorization fit the initial single-user desktop model. |
| Agent-safe broker boundary | Accepted | The AI may request an allowed login-and-check operation but may never request or receive a secret value. |
| Explicit credential-to-origin binding | Accepted | A stored item reference must not authorize use on caller-selected or redirected domains. |
| Strict agent request and reconstructed response | Accepted | Runtime callers provide only account plus `check_subscription`; trusted item/origin/backend data and backend output never pass through. |
| Desktop-integrated `op read` backend | Accepted | Retrieves one fixed account/vault/item/field through local 1Password authorization with no shell, enumeration, token, or agent-visible CLI surface. |
| Exact-origin controlled browser | Accepted | Installs interception before page creation, disables service workers/frames, and permits only read requests plus one validated login POST. |
| Provider-specific connectors | Accepted | Billing pages and extraction rules differ by provider. |
| Encrypted browser sessions before credential retrieval | Accepted | Reduces password-manager access and repeated user prompts while preserving reauthentication. |
| AES-256-GCM sessions with OS-keyring keys | Accepted | Keeps browser state encrypted at rest without a plaintext key fallback. |
| Opaque provider/account session paths | Accepted | Isolates accounts beneath the configured data directory without exposing identifiers in filenames. |
| Static synthetic connector fixtures | Accepted | Enables deterministic extraction tests with JavaScript disabled and every network request blocked. |
| SQLite latest-state plus append-only history | Accepted | Supports dashboard reads and safe history pruning while retaining current subscription and connector state. |
| Read-only connectors | Accepted | VaultScout must not purchase, cancel, or modify subscriptions. |
| GitHub Issues as task source of truth | Accepted | Keeps work discoverable across Codex sessions. |

## Security invariants

- Never persist original credentials in VaultScout.
- Never expose a password, OTP, recovery code, cookie, token, or browser storage state through an agent-facing API.
- Only a trusted local broker may hold a credential briefly in memory to fill a login form after policy checks and any required user authorization.
- Bind every credential item reference to an explicit HTTPS origin and account; never accept a runtime domain from the agent as credential authority.
- Provider login URLs require HTTPS; HTTP is limited to explicit loopback hosts for synthetic tests.
- Never log secrets, cookies, tokens, full authenticated HTML, or sensitive screenshots.
- Never derive connector fixtures from captured provider pages; fixtures must be hand-written, synthetic, and sanitizer-approved.
- Session state stays under `.vaultscout/` and must remain ignored by Git.
- SQLite stores only normalized billing metadata, opaque account references, outcomes, and redacted failure codes under the configured data directory.
- MFA and CAPTCHA require interactive user involvement and cannot be bypassed.
- Connector output is reconstructed through a strict schema before persistence or agent return; raw connector objects never cross the broker boundary.
- Connectors may only read billing information.
- Generic secret retrieval, vault search/listing, payment, cancellation, and account mutation are out of scope.

## Working agreement

At the start of a session, read this file and the open GitHub Issues. Select one issue and restate its intended outcome. Before ending, run checks, update the issue, and revise this file if facts or decisions changed.

## Last handoff

- Date: 2026-09-04
- Completed: Issue #12 synthetic vertical slice covering trusted target resolution, session reuse/reauthentication, callback-scoped form fill, exact-origin browser enforcement, strict extraction, redacted responses, and SQLite outcomes
- Verification: pending type check, complete/offline tests, audit, diff check, and tracked/runtime artifact scans
- Deferred: the dashboard until an end-to-end brokered subscription check exists
- Limitations: only the fixed synthetic form/connector is supported; MFA/CAPTCHA stop rather than resume; JavaScript cannot guarantee secure memory zeroing; trusted configuration remains programmatic; no real 1Password/browser check was performed
- Resume with exactly: Issue #13, select and implement the first real read-only subscription connector using hand-written synthetic fixtures
- Blocked on: user selecting the first real provider and user-present Windows 11 validation before any real credential is used

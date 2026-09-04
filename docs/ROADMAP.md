# Roadmap

## Milestone 0 — Rebaseline the product

- Define VaultScout as an agent-safe subscription access broker
- Keep credentials in an established password manager
- Document trust boundaries, default permissions, and denied actions
- Defer the dashboard until the secure vertical slice works

## Milestone 1 — One safe vertical slice

- Define an opaque, domain-bound credential reference model
- Add a narrow `CredentialBackend` abstraction and 1Password adapter
- Require local authorization when retrieving a credential
- Fill one approved HTTPS login form without returning the secret to the caller
- Reuse the existing encrypted browser session when possible
- Exercise the full flow against a synthetic provider with secret-leak tests

## Milestone 2 — One real subscription check

- Select one real subscription provider
- Implement one read-only connector using hand-written synthetic fixtures
- Return and persist only normalized renewal data and redacted outcomes
- Add clear reauthentication and interactive MFA states
- Perform a manual local security review before enabling scheduling

## Milestone 3 — Useful automation

- Scheduled local checks
- Renewal warnings and failed-check reporting
- Minimal local results view
- Connector health indicators
- Backup and restore of non-secret application data

## Milestone 4 — Carefully expand

- Additional provider connectors
- Evaluate Bitwarden behind the same credential-backend interface
- Calendar/reminder export
- Revisit a fuller local dashboard only after real usage validates it

## Explicitly out of scope

- Password-vault implementation or credential syncing
- Generic vault listing, vault search, or `get secret` APIs
- Returning passwords, OTPs, recovery codes, cookies, or tokens to an AI agent
- Wildcard or caller-selected credential domains
- Automatic payments
- Cancelling or changing subscriptions
- CAPTCHA bypass
- Uploading authenticated billing data to a hosted service

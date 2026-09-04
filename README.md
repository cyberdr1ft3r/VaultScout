# SubWatch

SubWatch is a local-first tool that checks subscription billing pages and collects renewal dates, amounts, plans, and account status in one place.

## Security model

- Passwords are never stored by SubWatch.
- Authentication happens in the provider's browser page.
- Reusable browser sessions are encrypted and live only in `.subwatch/`, which is ignored by Git.
- Logs contain connector events, not cookies, tokens, page HTML, or form values.
- A connector may read billing information, but it may not purchase, cancel, or modify a subscription.

## Current status

The foundation includes a typed connector contract, a secure encrypted session
vault, generic interactive Playwright authentication, a sanitized offline
connector fixture harness, local SQLite subscription history, a demo connector,
the local renewal dashboard, and a CLI. No real provider connector is
implemented yet.

The session vault stores its encryption key in Windows Credential Manager,
macOS Keychain, or Linux Secret Service and fails closed if that store is
unavailable. See [the session vault design](docs/SESSION_VAULT.md) for its
format, permissions, lifecycle states, and platform limitations.

Normalized connector outcomes and subscription snapshots remain in an
owner-only SQLite database under the configured data directory. See the
[persistence design](docs/PERSISTENCE.md) for its interface and retention
behavior.

## Run locally

```bash
npm install
npm run dev -- check demo
```

Expected output:

```text
Demo Cloud: renews 2026-10-01 — 9.99 EUR (active)
```

Start the read-only dashboard on IPv4 loopback:

```bash
npm run dev -- dashboard
```

Then open `http://127.0.0.1:4173`. See the
[dashboard guide](docs/DASHBOARD.md) for alternate ports, security headers,
and the explicit warning required for non-loopback binding.

## Planned MVP

1. Connectors for the first three real subscription providers
2. Expiry warnings and failed-check reporting
3. Reminder export and scheduled local checks

See [SECURITY.md](SECURITY.md) before adding a connector.

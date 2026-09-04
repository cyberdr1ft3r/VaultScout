# SubWatch

SubWatch is a local-first tool that checks subscription billing pages and collects renewal dates, amounts, plans, and account status in one place.

## Security model

- Passwords are never stored by SubWatch.
- Authentication happens in the provider's browser page.
- Reusable browser sessions live only in `.subwatch/`, which is ignored by Git.
- Logs contain connector events, not cookies, tokens, page HTML, or form values.
- A connector may read billing information, but it may not purchase, cancel, or modify a subscription.

## Current status

This initial foundation includes a typed connector contract, safe local data-directory creation, a demo connector, and a CLI. Provider-specific browser connectors and the dashboard come next.

## Run locally

```bash
npm install
npm run dev -- check demo
```

Expected output:

```text
Demo Cloud: renews 2026-10-01 — 9.99 EUR (active)
```

## Planned MVP

1. Interactive first login and reusable Playwright sessions
2. Connectors for the first three real subscription providers
3. SQLite-backed history and expiry warnings
4. Local dashboard and reminder export

See [SECURITY.md](SECURITY.md) before adding a connector.

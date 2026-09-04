# VaultScout

VaultScout is a local-first, agent-safe subscription checker. It lets an
authorized AI agent sign in to explicitly approved subscription sites, read
billing details, and report upcoming payments without revealing credentials to
the agent.

VaultScout is **not** a password manager. Original credentials stay in an
established vault; the first supported backend will be 1Password. VaultScout is a
narrow broker between that vault, a controlled browser, and a read-only
subscription connector.

## Intended experience

1. The user places a login in a dedicated 1Password vault and binds its item
   reference to one allowed HTTPS origin.
2. An agent asks VaultScout to check that subscription.
3. VaultScout enforces the account, domain, and read-only policy and obtains local
   user authorization when required.
4. The trusted broker fills the login into a controlled browser. The secret is
   never returned through the agent-facing API, logs, errors, or persistent app
   data.
5. A connector returns only normalized billing facts such as renewal date,
   amount, currency, plan, and status.

Reusable encrypted browser sessions allow later checks without repeatedly
opening the password vault. Expired sessions fall back to an authorized login.

## Security model

- Original credentials remain in 1Password and are referenced by opaque item
  identifiers; VaultScout does not implement a credential database.
- Agent callers never receive secret values. Only the trusted local broker may
  hold a credential briefly in memory while filling an approved login form.
- Every credential binding is restricted to an explicit HTTPS origin and
  account. Redirects do not expand that authority.
- The only agent capability is `check_subscription`; credential use remains
  internal to that trusted read-only flow.
- Purchases, cancellations, plan changes, payment-method changes, account
  changes, secret export, and MFA/CAPTCHA bypass are denied.
- Reusable browser sessions are encrypted and live only in `.vaultscout/`, which is ignored by Git.
- Logs contain connector events, not cookies, tokens, page HTML, or form values.

See [the architecture](docs/ARCHITECTURE.md) and [security policy](SECURITY.md)
before changing the authentication boundary.

## Current status

The existing foundation includes a typed connector contract, an encrypted
browser-session vault, generic interactive Playwright authentication, a
sanitized offline connector fixture harness, local SQLite subscription history,
a validated domain-bound credential broker contract with a synthetic fake
backend, a production local 1Password backend, a demo connector, and a CLI.

The synthetic vertical slice now performs a complete brokered login, encrypted
session reuse, normalized extraction, and redacted SQLite outcome flow using
only a loopback provider and fake backend. See the
[synthetic check design](docs/SYNTHETIC_CHECK.md).

The next deliverable is Issue #13, selecting and implementing the first real
read-only provider connector. No real provider connector is implemented yet.

See [the credential broker contract](docs/CREDENTIAL_BROKER.md) for the
agent-facing request, trusted backend boundary, exact-origin enforcement, and
JavaScript memory limitations.

The 1Password backend currently targets Windows 11. It requires the current
1Password desktop app, the official `op` CLI on `PATH`, Windows Hello enabled,
and **Settings → Developer → Integrate with 1Password CLI**. Use a dedicated
`AI Access` vault containing only the configured login. See the
[1Password integration guide](docs/ONE_PASSWORD.md) before local setup or
manual testing.

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

## Planned MVP

1. Select one real subscription provider
2. Implement one fixture-driven read-only connector
3. Exercise the provider through the brokered check flow
4. Add scheduling, warnings, and a minimal local results view

The project will reconsider additional vault backends only after this vertical
slice works safely. See [the roadmap](docs/ROADMAP.md) for sequencing.

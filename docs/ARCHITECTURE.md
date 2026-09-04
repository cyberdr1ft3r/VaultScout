# Architecture

## Product boundary

VaultScout is an agent-safe access broker for one job: checking subscription
billing information. It combines a mature password manager, a local policy
enforcement layer, a controlled browser, and read-only provider connectors.

It is not a replacement for 1Password or Bitwarden, and it is not a general
browser-control service for AI agents.

## Trust boundaries

| Component | May receive | Must never expose |
| --- | --- | --- |
| Agent-facing API | Account reference, requested action, normalized result | Passwords, one-time codes, cookies, browser storage, raw authenticated pages |
| Policy engine | Agent identity, account binding, allowed origin, action | Secret values |
| Credential backend | Opaque vault/item reference and authorized retrieval request | Secret values to the agent-facing API or logs |
| Trusted browser broker | Approved origin and a credential briefly in memory | Secret values through responses, logs, errors, screenshots, or persisted app data |
| Provider connector | Authenticated page context and normalized billing fields | Raw page content, credentials, or mutation capabilities |
| Session vault | Encrypted Playwright storage state | Plaintext session state or its encryption key |

The credential backend and browser broker run inside the trusted local VaultScout
process. An AI agent is an untrusted caller with a small capability surface.

## Initial vertical slice

The first implementation supports exactly:

- one local user;
- one 1Password-backed credential item reference;
- one explicitly configured HTTPS origin;
- one `check subscription` action;
- interactive local authorization when the credential must be retrieved;
- login form filling inside the broker-controlled Playwright page;
- a synthetic provider for all automated tests.

The agent receives a normalized subscription result or a redacted failure code.
There is no API that returns a password, OTP, cookie, storage state, or raw HTML.

Issue #10 establishes the contract boundary: the agent supplies only an opaque
account reference and `check_subscription`; trusted configuration resolves the
backend, item reference, and exact origin. Backend credential use is
callback-scoped and its result is discarded before the broker reconstructs an
agent-safe response. See [the credential broker contract](CREDENTIAL_BROKER.md).

## Login and check flow

1. Resolve the configured account binding to an allowed origin and opaque
   1Password item reference.
2. Validate the caller and requested `check subscription` capability.
3. Try the encrypted browser session first.
4. If reauthentication is required, request local user authorization and ask
   the credential backend to fill the approved login form.
5. Pause for user-handled MFA or CAPTCHA; never automate a bypass.
6. Verify the browser remains on the allowed origin before and after login.
7. Run the read-only provider connector.
8. Persist only normalized billing metadata and redacted outcome data.
9. Return the normalized result to the agent.

## Backend strategy

Start with a 1Password adapter behind a small `CredentialBackend` interface.
1Password remains the system of record, while VaultScout stores only an opaque
item reference and origin binding. The adapter must use a supported local
1Password integration and must fail closed when the desktop app is locked,
authorization is denied, or the target origin differs.

Issue #11 implements that adapter with the official desktop-integrated CLI. It
invokes one fixed `op read` secret reference by account, vault, item, and field
ID using a bounded no-shell child process. Credential bytes remain
callback-scoped inside the trusted process and no CLI operation is exposed to
the agent.

Bitwarden may be added later behind the same interface. Supporting a second
backend is not part of the first vertical slice.

## Denied by design

- Listing or searching the user's entire password vault
- Returning or displaying any secret to an agent
- A generic `get secret` tool
- Wildcard or caller-supplied credential domains
- Purchases, cancellations, plan or payment-method changes
- Account-profile changes, password changes, or recovery flows
- Autonomous handling of MFA, CAPTCHA, or recovery codes
- Hosted credential processing or syncing credentials through VaultScout

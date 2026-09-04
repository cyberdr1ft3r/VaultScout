# Security policy

VaultScout handles authenticated billing pages and brokers access to credentials
held by a password manager. It must be treated as sensitive local software.

## Credential broker rules

- Original credentials remain in the configured password manager. VaultScout may
  persist only an opaque item reference, an account reference, and an exact
  allowed HTTPS origin.
- No agent-facing method may return, display, enumerate, or search secrets.
- The trusted local broker may hold a credential only as briefly as required to
  fill an approved login form. It must not persist, log, serialize, or include
  that value in an error.
- Reject redirects or navigation that would use a credential outside its exact
  configured origin. Never treat a domain supplied by an agent as authority.
- Fail closed when the password manager is locked, authorization is denied, the
  account binding is missing, or origin validation fails.
- Automated tests must use fake credential backends and synthetic values that
  are blocked from logs and snapshots.

The implemented policy and interface boundary is documented in
[the credential broker contract](docs/CREDENTIAL_BROKER.md). JavaScript memory
cannot be reliably zeroed; VaultScout limits secret lifetime and visibility but
does not claim secure in-memory erasure.

## Connector rules

Connectors must remain read-only. They may navigate to billing pages and extract subscription metadata. They must not submit purchases, cancellations, plan changes, payment methods, passwords, recovery codes, or MFA values.

Never log cookies, authorization headers, browser storage, complete HTML, screenshots of billing pages, or input values. Redact account identifiers from errors. Session files must remain inside the configured data directory and must never be committed.

Reusable browser state is encrypted with an OS-keyring-backed key. See
[the session vault security design](docs/SESSION_VAULT.md) for platform
behavior and limitations.

MFA and CAPTCHA are explicit user-interaction boundaries. VaultScout may pause
and resume around them, but it must never attempt a bypass or ask an agent to
handle a recovery secret.

## Reporting a problem

Do not include credentials, cookies, tokens, invoices, or personal billing details in a public issue. Describe the affected connector and the observable behavior with sanitized data.

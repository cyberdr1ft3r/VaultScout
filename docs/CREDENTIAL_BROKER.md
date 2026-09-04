# Domain-bound credential broker contract

VaultScout exposes one agent-facing request:

```text
check subscription for configured account reference X
```

In code, that request contains only an opaque `acct_…` account reference and
the exact `check_subscription` capability. The caller cannot supply a
credential backend, password-manager item, origin, URL, secret, or alternate
capability.

## Trusted configuration

Each local credential binding contains:

- an opaque account reference;
- a backend kind (`one_password`, or `synthetic_fake` in tests);
- an opaque `item_…` password-manager reference; and
- one canonical exact allowed origin.

Real origins require HTTPS. HTTP is accepted only for the exact synthetic-test
hosts `localhost`, `127.0.0.1`, and `::1`. Origins cannot contain paths,
queries, fragments, URL user-info, wildcard hostnames, or non-canonical
spellings. Duplicate account bindings are rejected.

Bindings are supplied by trusted local configuration when the broker is
created. They are never selected or overridden by an agent request.

## Internal credential use

`CredentialBackend` is a trusted-process interface with one operation:
temporarily scope a password to a callback for one opaque item and allowed
origin. It deliberately has no `get secret`, return-value, list, search, OTP,
or recovery-code operation.

The trusted subscription-check executor must provide the browser's observed
URL immediately before credential use. VaultScout compares its parsed origin
to the configured exact origin before invoking the backend. Redirects to a
different scheme, host, or port fail closed.

Backend output and trusted executor output are not returned directly. The
agent-facing response is reconstructed from a strict schema and contains only
a completed status or a stable redacted failure code. Unexpected exception
messages and additional response properties are discarded.

Issue #10 provides a synthetic fake backend only. The real local 1Password
adapter is Issue #11, and the controlled browser-filling vertical slice is
Issue #12.

## Secret lifetime limitation

A backend implementation may need to materialize a password as a JavaScript
string long enough for the trusted browser code to fill an approved form. The
broker does not persist, serialize, log, snapshot, or return that value, and it
drops references after the callback finishes.

JavaScript strings are immutable and garbage-collected. VaultScout cannot
reliably overwrite or prove removal of every in-memory copy, and it does not
claim secure memory zeroing. The practical controls are narrow scope, short
lifetime, no agent-visible channel, no persistence, and a trusted local process
boundary.

## Denied operations

- generic secret retrieval, vault listing, or vault search;
- caller-selected credential items or domains;
- wildcard-domain authorization;
- credentials, OTPs, recovery codes, cookies, tokens, or browser storage in
  responses;
- payment, cancellation, plan-change, or account-mutation capabilities.

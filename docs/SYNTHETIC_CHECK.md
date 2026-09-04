# Brokered synthetic subscription check

Issue #12 completes the first end-to-end VaultScout vertical slice without a
real provider or real credential.

## Agent-facing flow

The agent sends only:

```text
{ accountReference, capability: "check_subscription" }
```

Trusted local configuration resolves the exact credential binding, synthetic
provider, trusted login identifier, controlled connector, browser session,
credential backend, and persistence repository. The agent cannot supply or
override any of those values, selectors, URLs, origins, navigation, or browser
actions.

The response is reconstructed through a strict schema. Success contains only
the opaque account reference, capability, and normalized subscription fields.
Failure contains only a stable redacted code.

## Session and login sequence

1. Load the account/provider session from the encrypted session vault.
2. If the session is valid, open `/billing` in a controlled context and verify
   it remains authenticated. The credential backend is not called.
3. Missing, expired, reauthentication-required, or no-longer-authenticated
   sessions open the fixed `/login` URL.
4. Detect MFA, CAPTCHA, or unsupported confirmation markers and stop with
   `INTERACTIVE_REQUIRED`.
5. Validate the top-level page, exact origin, absence of frames, fixed login
   form, and resolved form action before credential retrieval.
6. Retrieve the configured password through `CredentialBackend` and fill it
   only inside the trusted callback. The trusted username comes from local
   configuration.
7. Revalidate the page and form action immediately before filling and
   submitting. Native form submission bypasses page submit handlers.
8. Verify the post-login navigation, interactive state, exact origin, and
   authenticated synthetic billing marker.
9. Capture Playwright storage state in memory and pass it directly to the
   encrypted session vault. No plaintext browser-state file is created.
10. Revalidate the origin, run the existing synthetic read-only connector,
    reject extra or malformed fields, and reconstruct the normalized result.
11. Atomically persist a successful normalized snapshot or a failed check with
    only an approved redacted persistence code.

JavaScript cannot guarantee secure memory zeroing. Credential references are
dropped after callback/form completion, and no value is logged, serialized,
snapshotted, persisted, or returned.

## Controlled browser boundary

Request and WebSocket routing is installed before the first page is created.
Service workers are disabled. The context:

- permits HTTP(S) requests only to the configured exact origin;
- permits only GET/HEAD except for one validated POST to the fixed synthetic
  `/session` action;
- blocks sibling domains, scheme changes, port changes, external resources,
  popups, WebSockets, unsafe schemes, and every child frame;
- checks the origin on navigation, before credential retrieval, before form
  filling, before submission, after redirects, before session capture, and
  before extraction.

HTTP remains restricted to `localhost`, `127.0.0.1`, and `::1` synthetic
tests. Real origins require HTTPS through the credential binding contract.

## Interactive and failure states

VaultScout never fills OTPs, handles recovery codes, or solves CAPTCHA. MFA,
CAPTCHA, unsupported confirmation, and a locked backend that requires local
authorization return `INTERACTIVE_REQUIRED`.

Other agent-visible failures include request/binding/backend/authorization/
credential failures, session corruption, origin mismatch, login failure,
extraction failure, persistence failure, cancellation, and a generic check
failure. Internal exceptions, page content, selectors, form values, request
bodies, browser objects, and persistence errors are discarded.

## Scope and limitations

- The provider and login server are synthetic and loopback-only.
- Automated tests use `FakeCredentialBackend`; the real 1Password backend is
  not invoked.
- The slice supports one fixed username/password form shape and one existing
  synthetic connector. It is not generic browser automation.
- User-driven MFA continuation is represented but not resumed yet.
- Selecting and implementing the first real read-only provider is Issue #13.

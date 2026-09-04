# Session vault security design

SubWatch stores reusable Playwright storage state without accepting or persisting
account passwords. Login happens in a headed provider page. After the connector
confirms that login succeeded, SubWatch captures Playwright's cookies and web
storage and immediately encrypts them for later read-only checks.

## Encryption and key storage

- Each configured SubWatch data directory has a random 256-bit vault key.
- The key is stored as a generic secret named for a hash of the data-directory
  path. Session keys never have a plaintext file fallback.
- Session payloads use AES-256-GCM with a new 96-bit nonce for every write.
  Provider ID, account ID, and format version are authenticated as additional
  data, preventing encrypted files from being swapped between accounts.
- The encrypted payload contains the Playwright storage state and non-secret
  lifecycle metadata. The on-disk envelope contains only the format version,
  algorithm, nonce, authentication tag, and ciphertext.

The OS protects the vault key:

| Platform | Key protection | Session-file protection |
| --- | --- | --- |
| Windows | Windows Credential Manager, backed by DPAPI for the signed-in user | User-only ACLs applied with `icacls`; atomic replacement stays inside the account directory |
| macOS | Login Keychain | Owner-only directories (`0700`) and files (`0600`) |
| Linux | Secret Service collection, normally provided by GNOME Keyring or KWallet | Owner-only directories (`0700`) and files (`0600`) |

SubWatch fails closed when the platform credential store is unavailable. In
particular, a headless Linux host must provide an unlocked Secret Service
session; SubWatch does not write the vault key beside encrypted sessions.

Encryption protects session contents from offline inspection or accidental
backup disclosure when the OS credential store remains protected. It does not
protect against malware running as the same logged-in user or a compromised
provider page.

## Layout and isolation

All files stay under the path returned by `prepareDataDirectory`:

```text
.subwatch/
  sessions/
    <sha256-provider-id>/
      <sha256-account-id>/
        session.v1.enc
```

Raw provider and account identifiers are not used as path components. SubWatch
rejects empty identifiers and symbolic links in the managed session hierarchy.
Each write creates an exclusive owner-only temporary file, flushes it, renames
it over the destination, reapplies restrictive permissions, and flushes the
parent directory where supported.

## Lifecycle states

- `missing`: no encrypted session exists for this provider/account.
- `valid`: decryption and validation succeeded and the session has not expired.
- `expired`: its declared expiry time has passed. Storage state is not returned.
- `reauthentication_required`: a connector or authentication check marked the
  session invalid. Storage state is not returned.

Malformed, tampered, inaccessible, or undecryptable files are operational
errors rather than authentication states. Public errors contain only a stable
error code and generic message; they never include identifiers, cookies,
tokens, storage state, authenticated HTML, or lower-level exception text.

## Scope

The vault provides generic interactive authentication and session reuse for
future connectors. It does not automate password or MFA entry, bypass CAPTCHA,
implement a provider connector, or expose payment, cancellation, or
subscription-modification actions.

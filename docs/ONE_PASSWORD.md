# Local 1Password backend

VaultScout's first production credential backend uses the officially supported
1Password CLI integration with the local 1Password desktop app. It does not use
1Password service accounts, Connect, API tokens, hosted credential processing,
or vault enumeration.

Research was verified against the official documentation on 2026-09-04:

- [Desktop app integration](https://developer.1password.com/docs/cli/app-integration/)
- [Desktop integration security](https://developer.1password.com/docs/cli/app-integration-security/)
- [`op read` command](https://developer.1password.com/docs/cli/reference/commands/read)
- [CLI unique identifiers](https://developer.1password.com/docs/cli/reference/)

## Selected integration

The trusted backend starts the signed `op` executable directly, with no shell,
and resolves one secret reference:

```text
op://<vault-id>/<item-id>/<password-field-id>
```

The account, vault, item, field, and allowed origin all come from trusted local
configuration created before an agent request. Account, vault, and item IDs are
the 26-character unique identifiers documented by 1Password. VaultScout's
binding stores the item as `item_<item-id>`. The built-in Login password field
uses the fixed field ID `password`.

The internal invocation is equivalent to `op read` with the fixed secret
reference, fixed account ID, `--no-newline`, and `--no-color`. VaultScout does
not use `--force`, `--out-file`, `--session`, `op item list`, `op vault list`,
or any search command.

On Windows, 1Password CLI communicates with the desktop app over its
authenticated named-pipe integration. 1Password documents that the app
verifies the signed CLI executable and uses Windows Hello for the local
authorization prompt. Authorization is per account and is revoked when the app
locks.

## Process controls

- `op` is launched with an argument array and `shell: false`.
- Identifiers accept only fixed alphanumeric forms and cannot begin with `-`.
- Standard input is closed.
- The child environment is allowlisted to OS path/profile variables plus
  `OP_BIOMETRIC_UNLOCK_ENABLED=true`; service-account tokens, session
  variables, and unrelated parent variables are excluded.
- Stdout and stderr are separately limited to 8 KiB by default.
- Execution is limited to 30 seconds by default. Timeout or cancellation sends
  termination, escalates if needed, and fails closed.
- A successful process must exit `0`, produce no stderr, and return one
  non-empty, newline-free UTF-8 field value.
- The password is passed to the existing callback-scoped trusted consumer.
  The backend returns `void`.
- Captured byte buffers are overwritten on a best-effort basis and references
  are dropped after the callback.

1Password does not publish stable condition-specific CLI exit codes. VaultScout
therefore treats `0` as the only success code, privately recognizes known
locked, denied, unavailable, missing-vault, missing-item, and missing-field
stderr categories, and maps every unknown nonzero exit to a generic redacted
failure. Raw stdout, stderr, arguments, executable paths, environment contents,
and process errors are never included in adapter or broker errors.

JavaScript strings are immutable and garbage-collected. Best-effort buffer
overwriting does not guarantee that all in-memory copies are erased. VaultScout
does not claim secure memory zeroing.

## Windows 11 prerequisites

1. Install the current 1Password for Windows desktop app and sign in.
2. Install the current official 1Password CLI (`op.exe`) and add its install
   directory to the system `PATH`.
3. In 1Password, open **Settings → Security** and enable Windows Hello.
4. Open **Settings → Developer** and enable **Integrate with 1Password CLI**.
5. In **Settings → General**, keep 1Password running in the notification area
   so the authenticated local integration remains available.
6. Create a dedicated vault named `AI Access`. Do not use a personal or shared
   vault containing unrelated credentials.

## Manual synthetic smoke test

Only run this procedure with the user present to approve Windows Hello. Do not
use a real subscription account.

1. In `AI Access`, create one Login item named `VaultScout Synthetic Login`.
   Use an invented `.invalid` website origin, an obviously synthetic username,
   and a newly generated password used nowhere else.
2. In a private PowerShell window, obtain the account and dedicated vault IDs
   while printing only each top-level `id`:

   ```powershell
   (op account get --format json | ConvertFrom-Json).id
   (op vault get "AI Access" --format json --account <account-id> | ConvertFrom-Json).id
   ```

3. Obtain only the known synthetic item's top-level ID:

   ```powershell
   (op item get "VaultScout Synthetic Login" --vault <vault-id> --format json --account <account-id> | ConvertFrom-Json).id
   ```

   Never add `--reveal`, save the JSON, or paste the complete output. These are
   targeted setup-time `get` operations, not list or search operations.
4. Configure the trusted backend in a local, untracked developer harness with:
   the account ID, vault ID, `item_<item-id>`, password field ID `password`,
   and the exact synthetic allowed origin. Never place the password in this
   configuration.
5. Have the harness call `usePassword` with the matching trusted item/origin.
   The callback should record only that it ran; it must not print, return,
   snapshot, or persist its argument.
6. Approve the expected 1Password/Windows Hello authorization prompt. The safe
   result is callback completion or a stable redacted failure code.
7. Confirm terminal output and application logs contain neither the generated
   password nor raw `op` stdout/stderr. Also confirm no temporary files were
   created.
8. Delete the synthetic item and then the dedicated vault, and remove the
   untracked local harness/configuration.

Do not run `op read` manually to verify the password: that would print it to the
terminal. Do not run this smoke test unattended or with a real login.

## Current limitations

- Windows 11 is the supported first platform for manual validation.
- CLI error text is not a versioned machine-readable API; unknown failures
  intentionally collapse to a generic code.
- Trusted configuration is programmatic and has no committed config loader.
- Browser form filling and end-to-end subscription checking belong to Issue
  #12 and are not implemented here.

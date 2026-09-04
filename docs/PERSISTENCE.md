# Local subscription persistence

VaultScout stores normalized connector results in
`<configured-data-directory>/vaultscout.sqlite3`. The database is local private
data: it must not be committed, copied into bug reports, or treated as a
fixture.

## Stored data

The persistence API accepts:

- provider ID and display name;
- a generated opaque local account reference (`acct_` plus 128 random bits);
- normalized plan, renewal date, integer minor-unit amount, currency, billing
  cycle, subscription status, and UTC check timestamp;
- check outcome and, for failures, one code from a closed redacted code set.

It has no fields for passwords, cookies, tokens, MFA values, browser storage,
authenticated markup, invoices, payment cards, selectors, exception objects,
or exception messages. Unknown input fields are rejected. The session-vault
encryption key is never read by or written to this database.

## Schema and transactions

Static, versioned migrations are recorded in `schema_migrations`. Migrations
run once inside transactions and are safe to check repeatedly when the
database opens. Foreign-key enforcement is enabled for every connection.

A successful check is one transaction that:

1. updates the provider/account's current connector outcome;
2. appends the check;
3. appends its normalized subscription snapshot; and
4. updates the independent latest-subscription row when the check is not older
   than the currently stored state.

Any failure rolls back all four operations. Failed and
reauthentication-required checks store only normalized identity fields, the UTC
timestamp, outcome, and an approved redacted failure code.

Application data is always bound through prepared parameterized statements.
Only constant schema migrations and constant SQLite pragmas are executed as
static SQL.

## Retention

History is retained until the caller explicitly invokes `pruneCheckHistory`
with a UTC cutoff timestamp. Pruning deletes checks older than the cutoff and
their attached historical snapshots. It does not delete:

- the latest known normalized subscription per provider/account; or
- the latest connector outcome per provider/account.

Consequently, upcoming-renewal and reauthentication views remain available
after old history is pruned. SQLite secure deletion is enabled, and pruning
checkpoints the write-ahead log. Backup and restore policy is not implemented
yet.

## Filesystem and errors

The configured data directory must be a real directory, not a symbolic link.
The database filename is fixed, and existing database, WAL, shared-memory, or
journal paths must not be symbolic links. Directories use owner-only
permissions and database/sidecar files use owner-only permissions or a
user-only Windows ACL.

Public failures contain only stable error codes and generic messages. SQLite
error text, paths, SQL, bound values, and connector exception details are never
returned.

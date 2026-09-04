import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_subscription_history",
    sql: `
      CREATE TABLE connector_accounts (
        provider_id TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        latest_outcome TEXT NOT NULL
          CHECK (latest_outcome IN ('success', 'failed', 'reauthentication_required')),
        latest_failure_code TEXT,
        latest_checked_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, account_ref),
        CHECK (
          (latest_outcome = 'success' AND latest_failure_code IS NULL)
          OR
          (latest_outcome <> 'success' AND latest_failure_code IS NOT NULL)
        ),
        CHECK (
          latest_failure_code IS NULL OR latest_failure_code IN (
            'AUTHENTICATION_REQUIRED', 'SESSION_EXPIRED',
            'CONNECTOR_UNAVAILABLE', 'EXTRACTION_FAILED', 'INVALID_RESPONSE',
            'NETWORK_FAILED', 'UNKNOWN_FAILURE'
          )
        ),
        CHECK (
          latest_outcome <> 'reauthentication_required'
          OR latest_failure_code IN ('AUTHENTICATION_REQUIRED', 'SESSION_EXPIRED')
        )
      );

      CREATE TABLE subscription_checks (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('success', 'failed', 'reauthentication_required')),
        failure_code TEXT,
        FOREIGN KEY (provider_id, account_ref)
          REFERENCES connector_accounts (provider_id, account_ref),
        CHECK (
          (outcome = 'success' AND failure_code IS NULL)
          OR
          (outcome <> 'success' AND failure_code IS NOT NULL)
        ),
        CHECK (
          failure_code IS NULL OR failure_code IN (
            'AUTHENTICATION_REQUIRED', 'SESSION_EXPIRED',
            'CONNECTOR_UNAVAILABLE', 'EXTRACTION_FAILED', 'INVALID_RESPONSE',
            'NETWORK_FAILED', 'UNKNOWN_FAILURE'
          )
        ),
        CHECK (
          outcome <> 'reauthentication_required'
          OR failure_code IN ('AUTHENTICATION_REQUIRED', 'SESSION_EXPIRED')
        )
      );

      CREATE TABLE subscription_snapshots (
        check_id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        renewal_date TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency TEXT NOT NULL
          CHECK (length(currency) = 3 AND currency = upper(currency)),
        billing_cycle TEXT NOT NULL
          CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly', 'unknown')),
        subscription_status TEXT NOT NULL
          CHECK (subscription_status IN ('active', 'trial', 'past_due', 'cancelled', 'unknown')),
        checked_at TEXT NOT NULL,
        FOREIGN KEY (check_id) REFERENCES subscription_checks (id) ON DELETE CASCADE
      );

      CREATE TABLE latest_subscriptions (
        provider_id TEXT NOT NULL,
        account_ref TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        plan_name TEXT NOT NULL,
        renewal_date TEXT NOT NULL,
        amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
        currency TEXT NOT NULL
          CHECK (length(currency) = 3 AND currency = upper(currency)),
        billing_cycle TEXT NOT NULL
          CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly', 'unknown')),
        subscription_status TEXT NOT NULL
          CHECK (subscription_status IN ('active', 'trial', 'past_due', 'cancelled', 'unknown')),
        checked_at TEXT NOT NULL,
        source_check_id INTEGER,
        PRIMARY KEY (provider_id, account_ref),
        FOREIGN KEY (provider_id, account_ref)
          REFERENCES connector_accounts (provider_id, account_ref),
        FOREIGN KEY (source_check_id)
          REFERENCES subscription_checks (id) ON DELETE SET NULL
      );

      CREATE INDEX subscription_checks_account_history
        ON subscription_checks (provider_id, account_ref, checked_at DESC, id DESC);
      CREATE INDEX subscription_checks_recent_failures
        ON subscription_checks (outcome, checked_at DESC, id DESC);
      CREATE INDEX latest_subscriptions_upcoming
        ON latest_subscriptions (renewal_date, provider_id, account_ref);
    `,
  },
];

const createMigrationTableSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )
`;

interface AppliedMigration {
  version: number;
  name: string;
}

export function applyMigrations(
  database: Database.Database,
  appliedAt: string,
): void {
  database.exec(createMigrationTableSql);
  const userVersion = database.pragma("user_version", {
    simple: true,
  }) as number;
  const applied = database
    .prepare<[], AppliedMigration>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    )
    .all();

  if (
    applied.some(
      (migration, index) =>
        migration.version !== index + 1 ||
        migrations[index]?.name !== migration.name,
    ) ||
    applied.length > CURRENT_SCHEMA_VERSION ||
    userVersion !== applied.length
  ) {
    throw new Error("Unsupported database schema.");
  }

  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations.slice(applied.length)) {
    const migrate = database.transaction(() => {
      database.exec(migration.sql);
      insertMigration.run(migration.version, migration.name, appliedAt);
      database.pragma(`user_version = ${migration.version}`);
    });
    migrate.immediate();
  }
}

import { randomBytes } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Subscription } from "../core/subscription.js";
import { secureDirectory, secureFile } from "../core/secure-filesystem.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "./migrations.js";

export const SUBSCRIPTION_DATABASE_FILENAME = "subwatch.sqlite3";

const sidecarSuffixes = ["", "-wal", "-shm", "-journal"] as const;
const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const providerNameSchema = z.string().trim().min(1).max(100);
const opaqueAccountReferenceSchema = z
  .string()
  .regex(/^acct_[a-f0-9]{32}$/u);
const utcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  });
const dateSchema = z.iso.date();

export const redactedFailureCodes = [
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
  "CONNECTOR_UNAVAILABLE",
  "EXTRACTION_FAILED",
  "INVALID_RESPONSE",
  "NETWORK_FAILED",
  "UNKNOWN_FAILURE",
] as const;

export type RedactedFailureCode = (typeof redactedFailureCodes)[number];
export type CheckOutcome = "success" | "failed" | "reauthentication_required";

declare const opaqueAccountReferenceBrand: unique symbol;
export type OpaqueAccountReference = string & {
  readonly [opaqueAccountReferenceBrand]: true;
};

const normalizedSubscriptionSchema = z
  .object({
    providerId: providerIdSchema,
    providerName: providerNameSchema,
    planName: z.string().trim().min(1).max(200),
    renewalDate: dateSchema,
    amountMinor: z.number().int().nonnegative().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    billingCycle: z.enum(["monthly", "quarterly", "yearly", "unknown"]),
    status: z.enum(["active", "trial", "past_due", "cancelled", "unknown"]),
    checkedAt: utcTimestampSchema,
  })
  .strict();

const successfulCheckSchema = z
  .object({
    accountReference: opaqueAccountReferenceSchema,
    subscription: normalizedSubscriptionSchema,
  })
  .strict();

const failedCheckSchema = z
  .object({
    providerId: providerIdSchema,
    providerName: providerNameSchema,
    accountReference: opaqueAccountReferenceSchema,
    checkedAt: utcTimestampSchema,
    outcome: z.enum(["failed", "reauthentication_required"]),
    failureCode: z.enum(redactedFailureCodes),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.outcome === "reauthentication_required" &&
      value.failureCode !== "AUTHENTICATION_REQUIRED" &&
      value.failureCode !== "SESSION_EXPIRED"
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid reauthentication failure code.",
      });
    }
  });

const historyQuerySchema = z
  .object({
    providerId: providerIdSchema.optional(),
    accountReference: opaqueAccountReferenceSchema.optional(),
    limit: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();

const upcomingQuerySchema = z
  .object({
    fromDate: dateSchema,
    throughDate: dateSchema.optional(),
    limit: z.number().int().min(1).max(1_000).default(100),
  })
  .strict()
  .refine(
    (value) => !value.throughDate || value.throughDate >= value.fromDate,
    "Invalid renewal date range.",
  );

const recentFailureQuerySchema = z
  .object({
    since: utcTimestampSchema,
    limit: z.number().int().min(1).max(1_000).default(100),
  })
  .strict();

const pruneSchema = z.object({ before: utcTimestampSchema }).strict();

export interface SuccessfulCheckInput {
  accountReference: OpaqueAccountReference;
  subscription: Subscription;
}

export interface FailedCheckInput {
  providerId: string;
  providerName: string;
  accountReference: OpaqueAccountReference;
  checkedAt: string;
  outcome: Exclude<CheckOutcome, "success">;
  failureCode: RedactedFailureCode;
}

export interface PersistedSubscriptionState extends Subscription {
  accountReference: OpaqueAccountReference;
}

export interface PersistedCheck {
  id: number;
  providerId: string;
  providerName: string;
  accountReference: OpaqueAccountReference;
  checkedAt: string;
  outcome: CheckOutcome;
  failureCode: RedactedFailureCode | null;
  subscription: PersistedSubscriptionState | null;
}

export interface ReauthenticationRequirement {
  providerId: string;
  providerName: string;
  accountReference: OpaqueAccountReference;
  checkedAt: string;
  failureCode: "AUTHENTICATION_REQUIRED" | "SESSION_EXPIRED";
}

export interface HistoryQuery {
  providerId?: string;
  accountReference?: OpaqueAccountReference;
  limit?: number;
}

export interface UpcomingRenewalsQuery {
  fromDate: string;
  throughDate?: string;
  limit?: number;
}

export interface RecentFailuresQuery {
  since: string;
  limit?: number;
}

export interface SchemaStatus {
  version: number;
  appliedMigrations: number;
  foreignKeysEnabled: true;
}

export type PersistenceErrorCode =
  | "INVALID_INPUT"
  | "DATABASE_OPEN_FAILED"
  | "DATABASE_MIGRATION_FAILED"
  | "DATABASE_READ_FAILED"
  | "DATABASE_WRITE_FAILED"
  | "DATABASE_PRUNE_FAILED"
  | "DATABASE_CLOSED";

export class PersistenceError extends Error {
  constructor(readonly code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

function invalidInput(): PersistenceError {
  return new PersistenceError(
    "INVALID_INPUT",
    "The persistence input is invalid.",
  );
}

export function generateOpaqueAccountReference(): OpaqueAccountReference {
  return `acct_${randomBytes(16).toString("hex")}` as OpaqueAccountReference;
}

export function parseOpaqueAccountReference(
  value: string,
): OpaqueAccountReference {
  const parsed = opaqueAccountReferenceSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidInput();
  }
  return parsed.data as OpaqueAccountReference;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function assertSafePath(path: string, kind: "directory" | "file"): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
    ) {
      throw new Error("Unsafe persistence path.");
    }
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function prepareDatabasePath(dataDirectory: string): Promise<{
  dataDirectory: string;
  databasePath: string;
}> {
  const directory = resolve(dataDirectory);
  const exists = await assertSafePath(directory, "directory");
  if (!exists) {
    await secureDirectory(directory);
  } else {
    await secureDirectory(directory);
  }
  await assertSafePath(directory, "directory");

  const databasePath = join(directory, SUBSCRIPTION_DATABASE_FILENAME);
  if (dirname(databasePath) !== directory) {
    throw new Error("Unsafe persistence path.");
  }

  for (const suffix of sidecarSuffixes) {
    await assertSafePath(`${databasePath}${suffix}`, "file");
  }

  if (!(await assertSafePath(databasePath, "file"))) {
    const handle = await open(databasePath, "wx", 0o600);
    await handle.close();
  }
  await secureFile(databasePath);

  return { dataDirectory: directory, databasePath };
}

async function restrictDatabaseFiles(databasePath: string): Promise<void> {
  for (const suffix of sidecarSuffixes) {
    const path = `${databasePath}${suffix}`;
    if (await assertSafePath(path, "file")) {
      await secureFile(path);
    }
  }
}

interface LatestSubscriptionRow {
  providerId: string;
  providerName: string;
  accountReference: string;
  planName: string;
  renewalDate: string;
  amountMinor: number;
  currency: string;
  billingCycle: Subscription["billingCycle"];
  status: Subscription["status"];
  checkedAt: string;
}

interface CheckRow {
  id: number;
  providerId: string;
  providerName: string;
  accountReference: string;
  checkedAt: string;
  outcome: CheckOutcome;
  failureCode: RedactedFailureCode | null;
  snapshotProviderId: string | null;
  snapshotProviderName: string | null;
  snapshotAccountReference: string | null;
  planName: string | null;
  renewalDate: string | null;
  amountMinor: number | null;
  currency: string | null;
  billingCycle: Subscription["billingCycle"] | null;
  subscriptionStatus: Subscription["status"] | null;
  snapshotCheckedAt: string | null;
}

function mapSubscription(row: LatestSubscriptionRow): PersistedSubscriptionState {
  return {
    providerId: row.providerId,
    providerName: row.providerName,
    accountReference: row.accountReference as OpaqueAccountReference,
    planName: row.planName,
    renewalDate: row.renewalDate,
    amountMinor: row.amountMinor,
    currency: row.currency,
    billingCycle: row.billingCycle,
    status: row.status,
    checkedAt: row.checkedAt,
  };
}

function mapCheck(row: CheckRow): PersistedCheck {
  let subscription: PersistedSubscriptionState | null = null;
  if (
    row.snapshotProviderId !== null &&
    row.snapshotProviderName !== null &&
    row.snapshotAccountReference !== null &&
    row.planName !== null &&
    row.renewalDate !== null &&
    row.amountMinor !== null &&
    row.currency !== null &&
    row.billingCycle !== null &&
    row.subscriptionStatus !== null &&
    row.snapshotCheckedAt !== null
  ) {
    subscription = {
      providerId: row.snapshotProviderId,
      providerName: row.snapshotProviderName,
      accountReference:
        row.snapshotAccountReference as OpaqueAccountReference,
      planName: row.planName,
      renewalDate: row.renewalDate,
      amountMinor: row.amountMinor,
      currency: row.currency,
      billingCycle: row.billingCycle,
      status: row.subscriptionStatus,
      checkedAt: row.snapshotCheckedAt,
    };
  }

  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.providerName,
    accountReference: row.accountReference as OpaqueAccountReference,
    checkedAt: row.checkedAt,
    outcome: row.outcome,
    failureCode: row.failureCode,
    subscription,
  };
}

const latestSubscriptionSelect = `
  SELECT
    provider_id AS providerId,
    provider_name AS providerName,
    account_ref AS accountReference,
    plan_name AS planName,
    renewal_date AS renewalDate,
    amount_minor AS amountMinor,
    currency,
    billing_cycle AS billingCycle,
    subscription_status AS status,
    checked_at AS checkedAt
  FROM latest_subscriptions
`;

const checkHistorySelect = `
  SELECT
    checks.id,
    checks.provider_id AS providerId,
    checks.provider_name AS providerName,
    checks.account_ref AS accountReference,
    checks.checked_at AS checkedAt,
    checks.outcome,
    checks.failure_code AS failureCode,
    snapshots.provider_id AS snapshotProviderId,
    snapshots.provider_name AS snapshotProviderName,
    snapshots.account_ref AS snapshotAccountReference,
    snapshots.plan_name AS planName,
    snapshots.renewal_date AS renewalDate,
    snapshots.amount_minor AS amountMinor,
    snapshots.currency,
    snapshots.billing_cycle AS billingCycle,
    snapshots.subscription_status AS subscriptionStatus,
    snapshots.checked_at AS snapshotCheckedAt
  FROM subscription_checks AS checks
  LEFT JOIN subscription_snapshots AS snapshots ON snapshots.check_id = checks.id
`;

export class SubscriptionHistoryRepository {
  readonly #database: Database.Database;
  readonly #databasePath: string;
  #closed = false;

  constructor(database: Database.Database, databasePath: string) {
    this.#database = database;
    this.#databasePath = databasePath;
  }

  #ensureOpen(): void {
    if (this.#closed || !this.#database.open) {
      throw new PersistenceError("DATABASE_CLOSED", "The database is closed.");
    }
  }

  async #execute<T>(
    code: "DATABASE_READ_FAILED" | "DATABASE_WRITE_FAILED" | "DATABASE_PRUNE_FAILED",
    message: string,
    operation: () => T,
  ): Promise<T> {
    try {
      this.#ensureOpen();
      const result = operation();
      await restrictDatabaseFiles(this.#databasePath);
      return result;
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "DATABASE_CLOSED") {
        throw error;
      }
      throw new PersistenceError(code, message);
    }
  }

  async getSchemaStatus(): Promise<SchemaStatus> {
    return this.#execute(
      "DATABASE_READ_FAILED",
      "The database status could not be read.",
      () => {
        const version = this.#database.pragma("user_version", {
          simple: true,
        }) as number;
        const foreignKeys = this.#database.pragma("foreign_keys", {
          simple: true,
        }) as number;
        const migration = this.#database
          .prepare<[], { count: number }>(
            "SELECT count(*) AS count FROM schema_migrations",
          )
          .get();
        if (
          version !== CURRENT_SCHEMA_VERSION ||
          migration?.count !== CURRENT_SCHEMA_VERSION ||
          foreignKeys !== 1
        ) {
          throw new Error("Invalid database status.");
        }
        return {
          version,
          appliedMigrations: migration.count,
          foreignKeysEnabled: true,
        };
      },
    );
  }

  async recordSuccessfulCheck(input: SuccessfulCheckInput): Promise<number> {
    const parsed = successfulCheckSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidInput();
    }
    const { accountReference, subscription } = parsed.data;

    return this.#execute(
      "DATABASE_WRITE_FAILED",
      "The successful check could not be recorded.",
      () => {
        const transaction = this.#database.transaction(() => {
          this.#database
            .prepare(
              `INSERT INTO connector_accounts (
                provider_id, account_ref, provider_name, latest_outcome,
                latest_failure_code, latest_checked_at
              ) VALUES (?, ?, ?, 'success', NULL, ?)
              ON CONFLICT (provider_id, account_ref) DO UPDATE SET
                provider_name = excluded.provider_name,
                latest_outcome = excluded.latest_outcome,
                latest_failure_code = NULL,
                latest_checked_at = excluded.latest_checked_at
              WHERE excluded.latest_checked_at >= connector_accounts.latest_checked_at`,
            )
            .run(
              subscription.providerId,
              accountReference,
              subscription.providerName,
              subscription.checkedAt,
            );

          const check = this.#database
            .prepare(
              `INSERT INTO subscription_checks (
                provider_id, provider_name, account_ref, checked_at, outcome, failure_code
              ) VALUES (?, ?, ?, ?, 'success', NULL)`,
            )
            .run(
              subscription.providerId,
              subscription.providerName,
              accountReference,
              subscription.checkedAt,
            );
          const checkId = Number(check.lastInsertRowid);

          this.#database
            .prepare(
              `INSERT INTO subscription_snapshots (
                check_id, provider_id, provider_name, account_ref, plan_name,
                renewal_date, amount_minor, currency, billing_cycle,
                subscription_status, checked_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              checkId,
              subscription.providerId,
              subscription.providerName,
              accountReference,
              subscription.planName,
              subscription.renewalDate,
              subscription.amountMinor,
              subscription.currency,
              subscription.billingCycle,
              subscription.status,
              subscription.checkedAt,
            );

          this.#database
            .prepare(
              `INSERT INTO latest_subscriptions (
                provider_id, account_ref, provider_name, plan_name, renewal_date,
                amount_minor, currency, billing_cycle, subscription_status,
                checked_at, source_check_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (provider_id, account_ref) DO UPDATE SET
                provider_name = excluded.provider_name,
                plan_name = excluded.plan_name,
                renewal_date = excluded.renewal_date,
                amount_minor = excluded.amount_minor,
                currency = excluded.currency,
                billing_cycle = excluded.billing_cycle,
                subscription_status = excluded.subscription_status,
                checked_at = excluded.checked_at,
                source_check_id = excluded.source_check_id
              WHERE excluded.checked_at >= latest_subscriptions.checked_at`,
            )
            .run(
              subscription.providerId,
              accountReference,
              subscription.providerName,
              subscription.planName,
              subscription.renewalDate,
              subscription.amountMinor,
              subscription.currency,
              subscription.billingCycle,
              subscription.status,
              subscription.checkedAt,
              checkId,
            );

          return checkId;
        });

        return transaction.immediate();
      },
    );
  }

  async recordFailedCheck(input: FailedCheckInput): Promise<number> {
    const parsed = failedCheckSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidInput();
    }
    const value = parsed.data;

    return this.#execute(
      "DATABASE_WRITE_FAILED",
      "The failed check could not be recorded.",
      () => {
        const transaction = this.#database.transaction(() => {
          this.#database
            .prepare(
              `INSERT INTO connector_accounts (
                provider_id, account_ref, provider_name, latest_outcome,
                latest_failure_code, latest_checked_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (provider_id, account_ref) DO UPDATE SET
                provider_name = excluded.provider_name,
                latest_outcome = excluded.latest_outcome,
                latest_failure_code = excluded.latest_failure_code,
                latest_checked_at = excluded.latest_checked_at
              WHERE excluded.latest_checked_at >= connector_accounts.latest_checked_at`,
            )
            .run(
              value.providerId,
              value.accountReference,
              value.providerName,
              value.outcome,
              value.failureCode,
              value.checkedAt,
            );

          const check = this.#database
            .prepare(
              `INSERT INTO subscription_checks (
                provider_id, provider_name, account_ref, checked_at, outcome, failure_code
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              value.providerId,
              value.providerName,
              value.accountReference,
              value.checkedAt,
              value.outcome,
              value.failureCode,
            );
          return Number(check.lastInsertRowid);
        });

        return transaction.immediate();
      },
    );
  }

  async getLatestSubscriptionStates(): Promise<PersistedSubscriptionState[]> {
    return this.#execute(
      "DATABASE_READ_FAILED",
      "The latest subscription states could not be read.",
      () =>
        this.#database
          .prepare<[], LatestSubscriptionRow>(
            `${latestSubscriptionSelect}
             ORDER BY provider_id, account_ref`,
          )
          .all()
          .map(mapSubscription),
    );
  }

  async getUpcomingRenewals(
    query: UpcomingRenewalsQuery,
  ): Promise<PersistedSubscriptionState[]> {
    const parsed = upcomingQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidInput();
    }

    return this.#execute(
      "DATABASE_READ_FAILED",
      "Upcoming renewals could not be read.",
      () => {
        const sql = parsed.data.throughDate
          ? `${latestSubscriptionSelect}
             WHERE renewal_date >= ? AND renewal_date <= ?
               AND subscription_status <> 'cancelled'
             ORDER BY renewal_date, provider_id, account_ref
             LIMIT ?`
          : `${latestSubscriptionSelect}
             WHERE renewal_date >= ?
               AND subscription_status <> 'cancelled'
             ORDER BY renewal_date, provider_id, account_ref
             LIMIT ?`;
        const statement = this.#database.prepare<
          unknown[],
          LatestSubscriptionRow
        >(sql);
        const rows = parsed.data.throughDate
          ? statement.all(
              parsed.data.fromDate,
              parsed.data.throughDate,
              parsed.data.limit,
            )
          : statement.all(parsed.data.fromDate, parsed.data.limit);
        return rows.map(mapSubscription);
      },
    );
  }

  async getCheckHistory(query: HistoryQuery = {}): Promise<PersistedCheck[]> {
    const parsed = historyQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidInput();
    }

    return this.#execute(
      "DATABASE_READ_FAILED",
      "Subscription check history could not be read.",
      () =>
        this.#database
          .prepare<
            [string | null, string | null, string | null, string | null, number],
            CheckRow
          >(
            `${checkHistorySelect}
             WHERE (? IS NULL OR checks.provider_id = ?)
               AND (? IS NULL OR checks.account_ref = ?)
             ORDER BY checks.checked_at DESC, checks.id DESC
             LIMIT ?`,
          )
          .all(
            parsed.data.providerId ?? null,
            parsed.data.providerId ?? null,
            parsed.data.accountReference ?? null,
            parsed.data.accountReference ?? null,
            parsed.data.limit,
          )
          .map(mapCheck),
    );
  }

  async getConnectorsRequiringReauthentication(): Promise<
    ReauthenticationRequirement[]
  > {
    return this.#execute(
      "DATABASE_READ_FAILED",
      "Reauthentication requirements could not be read.",
      () =>
        this.#database
          .prepare<
            [],
            {
              providerId: string;
              providerName: string;
              accountReference: string;
              checkedAt: string;
              failureCode:
                | "AUTHENTICATION_REQUIRED"
                | "SESSION_EXPIRED";
            }
          >(
            `SELECT
               provider_id AS providerId,
               provider_name AS providerName,
               account_ref AS accountReference,
               latest_checked_at AS checkedAt,
               latest_failure_code AS failureCode
             FROM connector_accounts
             WHERE latest_outcome = 'reauthentication_required'
             ORDER BY latest_checked_at DESC, provider_id, account_ref`,
          )
          .all()
          .map((row) => ({
            ...row,
            accountReference: row.accountReference as OpaqueAccountReference,
          })),
    );
  }

  async getRecentFailedChecks(
    query: RecentFailuresQuery,
  ): Promise<PersistedCheck[]> {
    const parsed = recentFailureQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw invalidInput();
    }

    return this.#execute(
      "DATABASE_READ_FAILED",
      "Recent failed checks could not be read.",
      () =>
        this.#database
          .prepare<[string, number], CheckRow>(
            `${checkHistorySelect}
             WHERE checks.outcome = 'failed' AND checks.checked_at >= ?
             ORDER BY checks.checked_at DESC, checks.id DESC
             LIMIT ?`,
          )
          .all(parsed.data.since, parsed.data.limit)
          .map(mapCheck),
    );
  }

  async pruneCheckHistory(input: { before: string }): Promise<number> {
    const parsed = pruneSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidInput();
    }

    return this.#execute(
      "DATABASE_PRUNE_FAILED",
      "Subscription check history could not be pruned.",
      () => {
        const prune = this.#database.transaction(() =>
          this.#database
            .prepare("DELETE FROM subscription_checks WHERE checked_at < ?")
            .run(parsed.data.before),
        );
        const result = prune.immediate();
        this.#database.pragma("wal_checkpoint(TRUNCATE)");
        return result.changes;
      },
    );
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }

    try {
      this.#database.pragma("wal_checkpoint(TRUNCATE)");
      this.#database.close();
      this.#closed = true;
      await restrictDatabaseFiles(this.#databasePath);
    } catch {
      this.#closed = true;
      throw new PersistenceError(
        "DATABASE_WRITE_FAILED",
        "The database could not be closed safely.",
      );
    }
  }
}

export async function openSubscriptionHistory(
  configuredDataDirectory: string,
): Promise<SubscriptionHistoryRepository> {
  let prepared: Awaited<ReturnType<typeof prepareDatabasePath>>;
  try {
    prepared = await prepareDatabasePath(configuredDataDirectory);
  } catch {
    throw new PersistenceError(
      "DATABASE_OPEN_FAILED",
      "The subscription database could not be opened.",
    );
  }

  let database: Database.Database;
  try {
    database = new Database(prepared.databasePath, {
      fileMustExist: true,
      timeout: 5_000,
    });
  } catch {
    throw new PersistenceError(
      "DATABASE_OPEN_FAILED",
      "The subscription database could not be opened.",
    );
  }

  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("secure_delete = ON");
    database.pragma("trusted_schema = OFF");
    applyMigrations(database, new Date().toISOString());
    await restrictDatabaseFiles(prepared.databasePath);
    return new SubscriptionHistoryRepository(database, prepared.databasePath);
  } catch {
    try {
      database.close();
    } catch {
      // The public migration error remains generic.
    }
    throw new PersistenceError(
      "DATABASE_MIGRATION_FAILED",
      "The subscription database could not be initialized.",
    );
  }
}

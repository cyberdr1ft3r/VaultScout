import { lstat, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Subscription } from "../core/subscription.js";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";
import {
  generateOpaqueAccountReference,
  openSubscriptionHistory,
  parseOpaqueAccountReference,
  PersistenceError,
  SUBSCRIPTION_DATABASE_FILENAME,
  type FailedCheckInput,
  type OpaqueAccountReference,
  type SubscriptionHistoryRepository,
  type SuccessfulCheckInput,
} from "./subscription-history.js";

const primaryAccount = parseOpaqueAccountReference(
  "acct_11111111111111111111111111111111",
);
const secondaryAccount = parseOpaqueAccountReference(
  "acct_22222222222222222222222222222222",
);

function subscription(
  overrides: Partial<Subscription> = {},
): Subscription {
  return {
    providerId: "synthetic-cloud",
    providerName: "Synthetic Cloud",
    planName: "Fixture Basic",
    renewalDate: "2030-03-15",
    amountMinor: 1995,
    currency: "USD",
    billingCycle: "monthly",
    status: "active",
    checkedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];
const openRepositories: SubscriptionHistoryRepository[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vaultscout-history-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function openTemporaryRepository(): Promise<{
  directory: string;
  repository: SubscriptionHistoryRepository;
}> {
  const directory = await temporaryDirectory();
  const repository = await openSubscriptionHistory(directory);
  openRepositories.push(repository);
  return { directory, repository };
}

afterEach(async () => {
  await Promise.all(
    openRepositories.splice(0).map((repository) =>
      repository.close().catch(() => undefined),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("subscription history initialization and migrations", () => {
  it("initializes an empty owner-only database with foreign keys enabled", async () => {
    const parent = await temporaryDirectory();
    const directory = join(parent, "data");
    const repository = await openSubscriptionHistory(directory);
    openRepositories.push(repository);

    await expect(repository.getSchemaStatus()).resolves.toEqual({
      version: CURRENT_SCHEMA_VERSION,
      appliedMigrations: CURRENT_SCHEMA_VERSION,
      foreignKeysEnabled: true,
    });
    await expect(repository.getCheckHistory()).resolves.toEqual([]);
    await expect(repository.getLatestSubscriptionStates()).resolves.toEqual([]);

    const entries = await readdir(directory);
    expect(entries).toContain(SUBSCRIPTION_DATABASE_FILENAME);
    expect(
      entries.every(
        (entry) =>
          entry === SUBSCRIPTION_DATABASE_FILENAME ||
          entry.startsWith(`${SUBSCRIPTION_DATABASE_FILENAME}-`),
      ),
    ).toBe(true);

    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      for (const entry of entries) {
        expect((await lstat(join(directory, entry))).mode & 0o777).toBe(0o600);
      }
    }
  });

  it("applies versioned migrations exactly once across repeated opens", async () => {
    const { directory, repository } = await openTemporaryRepository();
    await repository.close();
    openRepositories.splice(openRepositories.indexOf(repository), 1);

    const reopened = await openSubscriptionHistory(directory);
    openRepositories.push(reopened);
    await expect(reopened.getSchemaStatus()).resolves.toEqual({
      version: 1,
      appliedMigrations: 1,
      foreignKeysEnabled: true,
    });

    const raw = new Database(join(directory, SUBSCRIPTION_DATABASE_FILENAME), {
      readonly: true,
    });
    try {
      expect(
        raw
          .prepare("SELECT version, name FROM schema_migrations")
          .all(),
      ).toEqual([
        { version: 1, name: "initial_subscription_history" },
      ]);
    } finally {
      raw.close();
    }
  });

  it("rejects an unsupported database version with a redacted error", async () => {
    const { directory, repository } = await openTemporaryRepository();
    await repository.close();
    openRepositories.splice(openRepositories.indexOf(repository), 1);

    const databasePath = join(directory, SUBSCRIPTION_DATABASE_FILENAME);
    const raw = new Database(databasePath);
    raw.pragma("user_version = 99");
    raw.close();

    const failure = await openSubscriptionHistory(directory).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PersistenceError);
    expect(failure).toMatchObject({
      code: "DATABASE_MIGRATION_FAILED",
      message: "The subscription database could not be initialized.",
    });
    expect(String(failure)).not.toContain(databasePath);
    expect(String(failure)).not.toContain("99");
  });
});

describe("recording connector checks", () => {
  it("records a successful check and normalized snapshot atomically", async () => {
    const { repository } = await openTemporaryRepository();
    const value = subscription();

    const checkId = await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: value,
    });

    expect(checkId).toBeGreaterThan(0);
    await expect(repository.getLatestSubscriptionStates()).resolves.toEqual([
      { ...value, accountReference: primaryAccount },
    ]);
    await expect(repository.getCheckHistory()).resolves.toEqual([
      {
        id: checkId,
        providerId: value.providerId,
        providerName: value.providerName,
        accountReference: primaryAccount,
        checkedAt: value.checkedAt,
        outcome: "success",
        failureCode: null,
        subscription: { ...value, accountReference: primaryAccount },
      },
    ]);
  });

  it("rolls back the check when snapshot persistence fails", async () => {
    const { directory, repository } = await openTemporaryRepository();
    const databasePath = join(directory, SUBSCRIPTION_DATABASE_FILENAME);
    const raw = new Database(databasePath);
    raw.exec(`
      CREATE TRIGGER synthetic_snapshot_failure
      BEFORE INSERT ON subscription_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'synthetic internal detail');
      END
    `);
    raw.close();

    const failure = await repository
      .recordSuccessfulCheck({
        accountReference: primaryAccount,
        subscription: subscription(),
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "DATABASE_WRITE_FAILED",
      message: "The successful check could not be recorded.",
    });
    expect(String(failure)).not.toContain("synthetic internal detail");
    await expect(repository.getCheckHistory()).resolves.toEqual([]);
    await expect(repository.getLatestSubscriptionStates()).resolves.toEqual([]);
  });

  it("records failed and reauthentication-required outcomes without snapshots", async () => {
    const { repository } = await openTemporaryRepository();
    await repository.recordFailedCheck({
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: primaryAccount,
      checkedAt: "2030-01-02T00:00:00.000Z",
      outcome: "failed",
      failureCode: "EXTRACTION_FAILED",
    });
    await repository.recordFailedCheck({
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: secondaryAccount,
      checkedAt: "2030-01-03T00:00:00.000Z",
      outcome: "reauthentication_required",
      failureCode: "AUTHENTICATION_REQUIRED",
    });

    const history = await repository.getCheckHistory();
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.subscription === null)).toBe(true);
    await expect(
      repository.getConnectorsRequiringReauthentication(),
    ).resolves.toEqual([
      {
        providerId: "synthetic-cloud",
        providerName: "Synthetic Cloud",
        accountReference: secondaryAccount,
        checkedAt: "2030-01-03T00:00:00.000Z",
        failureCode: "AUTHENTICATION_REQUIRED",
      },
    ]);
    await expect(
      repository.getRecentFailedChecks({
        since: "2030-01-01T00:00:00.000Z",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        accountReference: primaryAccount,
        outcome: "failed",
        failureCode: "EXTRACTION_FAILED",
        subscription: null,
      }),
    ]);
  });

  it("clears a reauthentication requirement after a newer success", async () => {
    const { repository } = await openTemporaryRepository();
    await repository.recordFailedCheck({
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: primaryAccount,
      checkedAt: "2030-01-01T00:00:00.000Z",
      outcome: "reauthentication_required",
      failureCode: "SESSION_EXPIRED",
    });
    await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: subscription({
        checkedAt: "2030-01-02T00:00:00.000Z",
      }),
    });

    await expect(
      repository.getConnectorsRequiringReauthentication(),
    ).resolves.toEqual([]);
  });
});

describe("dashboard read models and retention", () => {
  it("returns latest states and upcoming renewals ordered by date", async () => {
    const { repository } = await openTemporaryRepository();
    await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: subscription({
        renewalDate: "2030-04-01",
        checkedAt: "2030-01-02T00:00:00.000Z",
      }),
    });
    await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: subscription({
        planName: "Outdated Fixture",
        renewalDate: "2030-02-01",
        checkedAt: "2030-01-01T00:00:00.000Z",
      }),
    });
    await repository.recordSuccessfulCheck({
      accountReference: secondaryAccount,
      subscription: subscription({
        planName: "Fixture Annual",
        renewalDate: "2030-03-01",
        amountMinor: 9900,
        billingCycle: "yearly",
        checkedAt: "2030-01-03T00:00:00.000Z",
      }),
    });
    const cancelledAccount = parseOpaqueAccountReference(
      "acct_33333333333333333333333333333333",
    );
    await repository.recordSuccessfulCheck({
      accountReference: cancelledAccount,
      subscription: subscription({
        status: "cancelled",
        renewalDate: "2030-02-15",
        checkedAt: "2030-01-04T00:00:00.000Z",
      }),
    });

    const latest = await repository.getLatestSubscriptionStates();
    expect(latest).toHaveLength(3);
    expect(
      latest.find((entry) => entry.accountReference === primaryAccount),
    ).toMatchObject({
      planName: "Fixture Basic",
      renewalDate: "2030-04-01",
    });

    const upcoming = await repository.getUpcomingRenewals({
      fromDate: "2030-02-01",
      throughDate: "2030-04-30",
    });
    expect(upcoming.map((entry) => entry.accountReference)).toEqual([
      secondaryAccount,
      primaryAccount,
    ]);
  });

  it("filters check history by provider and opaque account", async () => {
    const { repository } = await openTemporaryRepository();
    await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: subscription(),
    });
    await repository.recordSuccessfulCheck({
      accountReference: secondaryAccount,
      subscription: subscription({
        checkedAt: "2030-01-02T00:00:00.000Z",
      }),
    });

    const history = await repository.getCheckHistory({
      providerId: "synthetic-cloud",
      accountReference: primaryAccount,
      limit: 10,
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.accountReference).toBe(primaryAccount);
  });

  it("prunes old history while preserving latest state and connector outcome", async () => {
    const { repository } = await openTemporaryRepository();
    await repository.recordSuccessfulCheck({
      accountReference: primaryAccount,
      subscription: subscription({
        checkedAt: "2030-01-01T00:00:00.000Z",
      }),
    });
    await repository.recordFailedCheck({
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: primaryAccount,
      checkedAt: "2030-03-01T00:00:00.000Z",
      outcome: "reauthentication_required",
      failureCode: "AUTHENTICATION_REQUIRED",
    });

    await expect(
      repository.pruneCheckHistory({
        before: "2030-02-01T00:00:00.000Z",
      }),
    ).resolves.toBe(1);
    await expect(repository.getCheckHistory()).resolves.toHaveLength(1);
    await expect(repository.getLatestSubscriptionStates()).resolves.toEqual([
      {
        ...subscription({ checkedAt: "2030-01-01T00:00:00.000Z" }),
        accountReference: primaryAccount,
      },
    ]);
    await expect(
      repository.getConnectorsRequiringReauthentication(),
    ).resolves.toHaveLength(1);
  });
});

describe("persistence input and filesystem safety", () => {
  it("generates opaque random local account references", () => {
    const first = generateOpaqueAccountReference();
    const second = generateOpaqueAccountReference();
    expect(first).toMatch(/^acct_[a-f0-9]{32}$/u);
    expect(second).toMatch(/^acct_[a-f0-9]{32}$/u);
    expect(first).not.toBe(second);
  });

  it("rejects traversal-shaped account references before writing", async () => {
    const { directory, repository } = await openTemporaryRepository();
    const input = {
      accountReference: "../../outside",
      subscription: subscription(),
    } as unknown as SuccessfulCheckInput;

    await expect(repository.recordSuccessfulCheck(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await readdir(directory)).not.toContain("outside");
    await expect(repository.getCheckHistory()).resolves.toEqual([]);
  });

  it("rejects symbolic data directories and database files", async () => {
    const parent = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const linkedDirectory = join(parent, "linked-data");
    await symlink(outside, linkedDirectory);

    await expect(openSubscriptionHistory(linkedDirectory)).rejects.toMatchObject({
      code: "DATABASE_OPEN_FAILED",
    });

    const dataDirectory = join(parent, "data");
    const outsideFile = join(outside, "outside.sqlite3");
    await writeFile(outsideFile, "");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDirectory);
    await symlink(
      outsideFile,
      join(dataDirectory, SUBSCRIPTION_DATABASE_FILENAME),
    );
    await expect(openSubscriptionHistory(dataDirectory)).rejects.toMatchObject({
      code: "DATABASE_OPEN_FAILED",
    });
    await expect(lstat(outsideFile)).resolves.toMatchObject({ size: 0 });
  });

  it("rejects secret-bearing or exception-shaped fields", async () => {
    const { repository } = await openTemporaryRepository();
    const secretFields = [
      { password: "" },
      { cookies: [] },
      { ["storage" + "State"]: {} },
      { exception: new Error() },
      { message: "" },
    ];

    for (const extra of secretFields) {
      const input = {
        accountReference: primaryAccount,
        subscription: subscription(),
        ...extra,
      } as unknown as SuccessfulCheckInput;
      await expect(repository.recordSuccessfulCheck(input)).rejects.toMatchObject(
        { code: "INVALID_INPUT" },
      );
    }
    const nestedSecretField = {
      accountReference: primaryAccount,
      subscription: {
        ...subscription(),
        cookies: [],
      },
    } as unknown as SuccessfulCheckInput;
    await expect(
      repository.recordSuccessfulCheck(nestedSecretField),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const invalidFailure = {
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: primaryAccount,
      checkedAt: "2030-01-01T00:00:00.000Z",
      outcome: "failed",
      failureCode: "UNREDACTED_DETAIL",
    } as unknown as FailedCheckInput;
    await expect(repository.recordFailedCheck(invalidFailure)).rejects.toMatchObject(
      { code: "INVALID_INPUT" },
    );
    const failureWithMessage = {
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      accountReference: primaryAccount,
      checkedAt: "2030-01-01T00:00:00.000Z",
      outcome: "failed",
      failureCode: "UNKNOWN_FAILURE",
      message: "",
    } as unknown as FailedCheckInput;
    await expect(
      repository.recordFailedCheck(failureWithMessage),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.getCheckHistory()).resolves.toEqual([]);
  });

  it("rejects non-UTC timestamps and unsafe monetary values", async () => {
    const { repository } = await openTemporaryRepository();

    await expect(
      repository.recordSuccessfulCheck({
        accountReference: primaryAccount,
        subscription: subscription({
          checkedAt: "2030-01-01T01:00:00.000+01:00",
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      repository.recordSuccessfulCheck({
        accountReference: primaryAccount,
        subscription: subscription({
          amountMinor: Number.MAX_SAFE_INTEGER + 1,
        }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("returns generic failures after the database is closed", async () => {
    const { directory, repository } = await openTemporaryRepository();
    await repository.close();
    openRepositories.splice(openRepositories.indexOf(repository), 1);

    const failure = await repository.getCheckHistory().catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "DATABASE_CLOSED",
      message: "The database is closed.",
    });
    expect(String(failure)).not.toContain(directory);
    expect(String(failure)).not.toContain("SELECT");
  });
});

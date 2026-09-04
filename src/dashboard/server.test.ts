import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSubscriptionHistory,
  parseOpaqueAccountReference,
  type OpaqueAccountReference,
  type SubscriptionHistoryRepository,
} from "../persistence/subscription-history.js";
import {
  DashboardServerError,
  startDashboardServer,
  type DashboardServer,
} from "./server.js";

const NOW = new Date("2030-01-10T12:00:00.000Z");
const accountReferences = [
  "acct_00000000000000000000000000001001",
  "acct_00000000000000000000000000001002",
  "acct_00000000000000000000000000001003",
  "acct_00000000000000000000000000001004",
].map(parseOpaqueAccountReference);

const temporaryDirectories: string[] = [];
const repositories: SubscriptionHistoryRepository[] = [];
const servers: DashboardServer[] = [];

async function temporaryRepository(): Promise<SubscriptionHistoryRepository> {
  const directory = await mkdtemp(join(tmpdir(), "subwatch-dashboard-test-"));
  temporaryDirectories.push(directory);
  const repository = await openSubscriptionHistory(directory);
  repositories.push(repository);
  return repository;
}

async function seedRepository(
  repository: SubscriptionHistoryRepository,
): Promise<void> {
  const [first, second, third, fourth] = accountReferences as [
    OpaqueAccountReference,
    OpaqueAccountReference,
    OpaqueAccountReference,
    OpaqueAccountReference,
  ];
  await repository.recordSuccessfulCheck({
    accountReference: first,
    subscription: {
      providerId: "synthetic-alpha",
      providerName: "Synthetic Alpha",
      planName: "Fixture Core",
      renewalDate: "2030-01-15",
      amountMinor: 1299,
      currency: "USD",
      billingCycle: "monthly",
      status: "active",
      checkedAt: "2030-01-09T10:00:00.000Z",
    },
  });
  await repository.recordSuccessfulCheck({
    accountReference: second,
    subscription: {
      providerId: "synthetic-beta",
      providerName: "Synthetic Beta",
      planName: "Fixture Annual",
      renewalDate: "2030-02-01",
      amountMinor: 8400,
      currency: "EUR",
      billingCycle: "yearly",
      status: "active",
      checkedAt: "2030-01-08T09:00:00.000Z",
    },
  });
  await repository.recordFailedCheck({
    providerId: "synthetic-beta",
    providerName: "Synthetic Beta",
    accountReference: second,
    checkedAt: "2030-01-10T08:00:00.000Z",
    outcome: "failed",
    failureCode: "EXTRACTION_FAILED",
  });
  await repository.recordSuccessfulCheck({
    accountReference: third,
    subscription: {
      providerId: "synthetic-gamma",
      providerName: "Synthetic Gamma",
      planName: "Fixture Plus",
      renewalDate: "2030-01-05",
      amountMinor: 2500,
      currency: "GBP",
      billingCycle: "monthly",
      status: "past_due",
      checkedAt: "2030-01-07T11:00:00.000Z",
    },
  });
  await repository.recordFailedCheck({
    providerId: "synthetic-gamma",
    providerName: "Synthetic Gamma",
    accountReference: third,
    checkedAt: "2030-01-10T09:00:00.000Z",
    outcome: "reauthentication_required",
    failureCode: "AUTHENTICATION_REQUIRED",
  });
  await repository.recordSuccessfulCheck({
    accountReference: fourth,
    subscription: {
      providerId: "synthetic-delta",
      providerName: "Synthetic Delta",
      planName: "Fixture Retired",
      renewalDate: "2030-01-12",
      amountMinor: 500,
      currency: "USD",
      billingCycle: "monthly",
      status: "cancelled",
      checkedAt: "2030-01-06T10:00:00.000Z",
    },
  });
}

async function start(
  repository: SubscriptionHistoryRepository,
): Promise<DashboardServer> {
  const server = await startDashboardServer({
    repository,
    port: 0,
    now: () => NOW,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => server.close().catch(() => undefined)),
  );
  await Promise.all(
    repositories
      .splice(0)
      .map((repository) => repository.close().catch(() => undefined)),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard server security boundary", () => {
  it("binds to IPv4 loopback by default", async () => {
    const server = await start(await temporaryRepository());
    expect(server.host).toBe("127.0.0.1");
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  it("refuses non-loopback binding without explicit opt-in", async () => {
    await expect(
      startDashboardServer({
        repository: await temporaryRepository(),
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toMatchObject({
      code: "UNSAFE_BIND_ADDRESS",
      message: "Non-loopback dashboard binding requires explicit opt-in.",
    });
  });

  it("allows non-loopback binding only with explicit opt-in", async () => {
    const server = await startDashboardServer({
      repository: await temporaryRepository(),
      host: "0.0.0.0",
      port: 0,
      allowNonLoopback: true,
    });
    servers.push(server);
    expect(server.host).toBe("0.0.0.0");
  });

  it("rejects unsafe Host headers", async () => {
    const server = await start(await temporaryRepository());
    const response = await new Promise<{
      status: number | undefined;
      body: string;
    }>((resolvePromise, rejectPromise) => {
      const client = request(
        server.origin,
        { headers: { Host: "dashboard.example.invalid" } },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("end", () =>
            resolvePromise({ status: incoming.statusCode, body }),
          );
        },
      );
      client.on("error", rejectPromise);
      client.end();
    });

    expect(response.status).toBe(421);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "UNSAFE_HOST",
        message: "Request host is not allowed.",
      },
    });
  });

  it("sets restrictive security headers without permissive CORS", async () => {
    const server = await start(await temporaryRepository());
    const response = await fetch(server.origin);

    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps API endpoints read-only and static assets allowlisted", async () => {
    const server = await start(await temporaryRepository());
    const mutation = await fetch(`${server.origin}/api/summary`, {
      method: "POST",
    });
    expect(mutation.status).toBe(405);
    await expect(mutation.json()).resolves.toMatchObject({
      error: { code: "READ_ONLY_ENDPOINT" },
    });

    const traversal = await fetch(`${server.origin}/package.json`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('"dependencies"');
  });

  it("returns stable redacted server failures", async () => {
    const privateDetail = "synthetic private database detail";
    const failingRepository = {
      async getLatestSubscriptionStates() {
        throw new Error(privateDetail);
      },
      async getUpcomingRenewals() {
        throw new Error(privateDetail);
      },
      async getConnectorsRequiringReauthentication() {
        throw new Error(privateDetail);
      },
      async getRecentFailedChecks() {
        throw new Error(privateDetail);
      },
    } as unknown as SubscriptionHistoryRepository;
    const server = await start(failingRepository);

    const response = await fetch(`${server.origin}/api/summary`);
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "DASHBOARD_DATA_UNAVAILABLE",
        message: "Dashboard data is temporarily unavailable.",
      },
    });
    expect(body).not.toContain(privateDetail);
    expect(body.toLowerCase()).not.toContain("sqlite");
  });

  it("uses generic startup errors", async () => {
    const repository = await temporaryRepository();
    const first = await start(repository);
    const failure = await startDashboardServer({
      repository,
      host: "127.0.0.1",
      port: first.port,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DashboardServerError);
    expect(failure).toMatchObject({
      code: "SERVER_START_FAILED",
      message: "The dashboard server could not be started.",
    });
    expect(String(failure)).not.toContain("EADDRINUSE");
  });
});

describe("read-only dashboard API", () => {
  it("returns zeroed empty-database responses", async () => {
    const server = await start(await temporaryRepository());

    await expect(
      fetch(`${server.origin}/api/summary`).then((response) => response.json()),
    ).resolves.toEqual({
      asOf: NOW.toISOString(),
      activeSubscriptions: 0,
      renewalsWithin7Days: 0,
      renewalsWithin30Days: 0,
      reauthenticationRequired: 0,
      recentFailedChecks: 0,
    });
    for (const endpoint of ["renewals", "warnings", "history"]) {
      const response = await fetch(`${server.origin}/api/${endpoint}`);
      expect(response.status).toBe(200);
    }
  });

  it("returns summary metrics from synthetic local data", async () => {
    const repository = await temporaryRepository();
    await seedRepository(repository);
    const server = await start(repository);

    const response = await fetch(`${server.origin}/api/summary`);
    await expect(response.json()).resolves.toEqual({
      asOf: NOW.toISOString(),
      activeSubscriptions: 2,
      renewalsWithin7Days: 1,
      renewalsWithin30Days: 2,
      reauthenticationRequired: 1,
      recentFailedChecks: 1,
    });
  });

  it("returns ordered upcoming renewals without full account references", async () => {
    const repository = await temporaryRepository();
    await seedRepository(repository);
    const server = await start(repository);

    const response = await fetch(`${server.origin}/api/renewals`);
    const body = await response.text();
    const data = JSON.parse(body) as {
      renewals: Array<Record<string, unknown>>;
    };
    expect(data.renewals).toHaveLength(2);
    expect(data.renewals.map((renewal) => renewal.providerName)).toEqual([
      "Synthetic Alpha",
      "Synthetic Beta",
    ]);
    expect(data.renewals[0]).toMatchObject({
      planName: "Fixture Core",
      renewalDate: "2030-01-15",
      amountMinor: 1299,
      currency: "USD",
      billingCycle: "monthly",
      status: "active",
      checkedAt: "2030-01-09T10:00:00.000Z",
      accountLabel: "Local •1001",
    });
    for (const reference of accountReferences) {
      expect(body).not.toContain(reference);
    }
    expect(body).not.toContain("accountReference");
  });

  it("returns past-due, reauthentication, and recent-failure warnings", async () => {
    const repository = await temporaryRepository();
    await seedRepository(repository);
    const server = await start(repository);

    const response = await fetch(`${server.origin}/api/warnings`);
    const body = await response.text();
    const data = JSON.parse(body) as {
      pastDue: unknown[];
      reauthentication: unknown[];
      recentFailures: unknown[];
    };
    expect(data.pastDue).toHaveLength(1);
    expect(data.reauthentication).toEqual([
      expect.objectContaining({
        providerName: "Synthetic Gamma",
        accountLabel: "Local •1003",
        failureCode: "AUTHENTICATION_REQUIRED",
      }),
    ]);
    expect(data.recentFailures).toEqual([
      expect.objectContaining({
        providerName: "Synthetic Beta",
        accountLabel: "Local •1002",
        failureCode: "EXTRACTION_FAILED",
      }),
    ]);
    expect(body).not.toContain(accountReferences[2]!);
  });

  it("returns redacted check history and normalized details", async () => {
    const repository = await temporaryRepository();
    await seedRepository(repository);
    const server = await start(repository);

    const response = await fetch(`${server.origin}/api/history`);
    const body = await response.text();
    const data = JSON.parse(body) as {
      checks: Array<Record<string, unknown>>;
    };
    expect(data.checks).toHaveLength(6);
    expect(data.checks[0]).toMatchObject({
      providerName: "Synthetic Gamma",
      accountLabel: "Local •1003",
      outcome: "reauthentication_required",
      failureCode: "AUTHENTICATION_REQUIRED",
      subscription: null,
    });
    expect(
      data.checks.find((check) => check.outcome === "success"),
    ).toHaveProperty("subscription.planName");
    expect(body).not.toMatch(
      /accountReference|databasePath|storageState|cookies|tokens|exception|SELECT/iu,
    );
    for (const reference of accountReferences) {
      expect(body).not.toContain(reference);
    }
  });
});

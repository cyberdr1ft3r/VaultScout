import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  openSubscriptionHistory,
  parseOpaqueAccountReference,
  type SubscriptionHistoryRepository,
} from "../persistence/subscription-history.js";
import {
  startDashboardServer,
  type DashboardServer,
} from "./server.js";

const NOW = new Date("2030-01-10T12:00:00.000Z");
const directories: string[] = [];
const repositories: SubscriptionHistoryRepository[] = [];
const servers: DashboardServer[] = [];
let browser: Browser;

async function expectVisible(locator: Locator): Promise<void> {
  await locator.waitFor({ state: "visible" });
  expect(await locator.isVisible()).toBe(true);
}

async function expectContainsText(
  locator: Locator,
  expected: string,
): Promise<void> {
  await locator.waitFor({ state: "visible" });
  expect(await locator.textContent()).toContain(expected);
}

async function repository(): Promise<SubscriptionHistoryRepository> {
  const directory = await mkdtemp(join(tmpdir(), "subwatch-ui-test-"));
  directories.push(directory);
  const value = await openSubscriptionHistory(directory);
  repositories.push(value);
  return value;
}

async function server(
  history: SubscriptionHistoryRepository,
): Promise<DashboardServer> {
  const value = await startDashboardServer({
    repository: history,
    port: 0,
    now: () => NOW,
  });
  servers.push(value);
  return value;
}

async function populatedServer(): Promise<DashboardServer> {
  const history = await repository();
  const active = parseOpaqueAccountReference(
    "acct_00000000000000000000000000002001",
  );
  const warning = parseOpaqueAccountReference(
    "acct_00000000000000000000000000002002",
  );

  await history.recordSuccessfulCheck({
    accountReference: active,
    subscription: {
      providerId: "synthetic-orbit",
      providerName: "Synthetic Orbit",
      planName: "Fixture Standard",
      renewalDate: "2030-01-14",
      amountMinor: 1499,
      currency: "USD",
      billingCycle: "monthly",
      status: "active",
      checkedAt: "2030-01-09T10:00:00.000Z",
    },
  });
  await history.recordFailedCheck({
    providerId: "synthetic-orbit",
    providerName: "Synthetic Orbit",
    accountReference: active,
    checkedAt: "2030-01-10T08:00:00.000Z",
    outcome: "failed",
    failureCode: "EXTRACTION_FAILED",
  });
  await history.recordSuccessfulCheck({
    accountReference: warning,
    subscription: {
      providerId: "synthetic-north",
      providerName: "Synthetic North",
      planName: "Fixture Plus",
      renewalDate: "2030-01-05",
      amountMinor: 3200,
      currency: "EUR",
      billingCycle: "monthly",
      status: "past_due",
      checkedAt: "2030-01-08T11:00:00.000Z",
    },
  });
  await history.recordFailedCheck({
    providerId: "synthetic-north",
    providerName: "Synthetic North",
    accountReference: warning,
    checkedAt: "2030-01-10T09:00:00.000Z",
    outcome: "reauthentication_required",
    failureCode: "SESSION_EXPIRED",
  });

  return server(history);
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((value) => value.close().catch(() => undefined)),
  );
  await Promise.all(
    repositories
      .splice(0)
      .map((value) => value.close().catch(() => undefined)),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local dashboard UI", () => {
  it("renders populated summary, renewal, warning, and detail states", async () => {
    const dashboard = await populatedServer();
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(dashboard.origin);
    await expectVisible(page.locator("#dashboard-content"));
    expect(await page.locator("#metric-active").textContent()).toBe("1");
    expect(await page.locator("#metric-seven").textContent()).toBe("1");
    expect(await page.locator("#metric-reauth").textContent()).toBe("1");
    expect(await page.locator("#metric-failures").textContent()).toBe("1");
    expect(await page.locator("#renewal-rows tr").count()).toBe(1);
    await expectContainsText(
      page.locator("#renewal-rows"),
      "Synthetic Orbit",
    );
    await expectContainsText(
      page.locator("#warning-grid"),
      "Past-due subscription",
    );
    await expectContainsText(
      page.locator("#warning-grid"),
      "Reauthentication required",
    );
    await expectContainsText(
      page.locator("#warning-grid"),
      "Connector check failed",
    );
    await expectContainsText(
      page.locator("#history-detail"),
      "Synthetic North",
    );
    await page
      .locator(".history-item")
      .filter({ hasText: "Synthetic Orbit" })
      .last()
      .click();
    await expectContainsText(
      page.locator("#history-detail"),
      "Fixture Standard",
    );
    expect(
      requests.every((url) => url.startsWith(dashboard.origin)),
    ).toBe(true);

    await page.close();
  });

  it("shows useful loading and empty states", async () => {
    const dashboard = await server(await repository());
    const page = await browser.newPage();
    await page.route("**/api/**", async (route) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      await route.continue();
    });

    const navigation = page.goto(dashboard.origin);
    await expectVisible(page.locator("#loading-state"));
    await navigation;
    await expectVisible(page.locator("#dashboard-content"));
    expect(await page.locator("#metric-active").textContent()).toBe("0");
    await expectVisible(page.locator("#warning-empty"));
    await expectVisible(page.locator("#renewal-empty"));
    await expectVisible(page.locator("#history-empty"));

    await page.close();
  });

  it("shows a friendly error without internal server detail", async () => {
    const internalDetail = "synthetic internal query detail";
    const failing = {
      async getLatestSubscriptionStates() {
        throw new Error(internalDetail);
      },
      async getUpcomingRenewals() {
        throw new Error(internalDetail);
      },
      async getConnectorsRequiringReauthentication() {
        throw new Error(internalDetail);
      },
      async getRecentFailedChecks() {
        throw new Error(internalDetail);
      },
      async getCheckHistory() {
        throw new Error(internalDetail);
      },
    } as unknown as SubscriptionHistoryRepository;
    const dashboard = await server(failing);
    const page = await browser.newPage();

    await page.goto(dashboard.origin);
    await expectVisible(page.locator("#error-state"));
    expect(await page.locator("body").textContent()).not.toContain(
      internalDetail,
    );
    await expectContainsText(
      page.locator("#error-state"),
      "Dashboard data is unavailable",
    );

    await page.close();
  });

  it("adapts to mobile layout and system dark theme", async () => {
    const dashboard = await populatedServer();
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });

    await page.goto(dashboard.origin);
    await expectVisible(page.locator("#dashboard-content"));
    expect(
      await page
        .locator(".sidebar")
        .evaluate((element) => getComputedStyle(element).width),
    ).toBe("390px");
    expect(
      await page
        .locator("#renewal-rows td")
        .first()
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    expect(
      await page
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe("rgb(16, 18, 22)");
    const bodyWidth = await page
      .locator("body")
      .evaluate((body) => body.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(390);

    await page.close();
  });
});

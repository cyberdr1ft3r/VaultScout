import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { demoConnector } from "../connectors/demo.js";
import type { Subscription } from "../core/subscription.js";
import {
  assertNormalizedSubscription,
  type ConnectorFixture,
  FixtureHarnessError,
  loadConnectorFixture,
  validateConnectorFixture,
  withConnectorFixturePage,
} from "./connector-fixture.js";
import { extractSyntheticSubscription } from "./synthetic-provider.js";

const fixtureDirectory = fileURLToPath(
  new URL("./fixtures", import.meta.url),
);

function replaceMarkup(
  fixture: ConnectorFixture,
  current: string,
  replacement: string,
): ConnectorFixture {
  return validateConnectorFixture({
    ...fixture,
    html: fixture.html.replace(current, replacement),
  });
}

function expectedSubscription(fixture: ConnectorFixture): Subscription {
  if (fixture.expectation.outcome !== "subscription") {
    throw new Error("Test expected a subscription fixture.");
  }
  return fixture.expectation.subscription;
}

describe("connector fixture harness", () => {
  let browser: Browser;
  let working: ConnectorFixture;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    working = await loadConnectorFixture(
      fixtureDirectory,
      "synthetic-cloud.fixture.json",
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  it("loads a working synthetic page and asserts normalized output", async () => {
    const expected = expectedSubscription(working);
    const actual = await withConnectorFixturePage(
      browser,
      working,
      (page) => extractSyntheticSubscription(page, expected.checkedAt),
    );

    expect(() => assertNormalizedSubscription(actual, expected)).not.toThrow();
  });

  it("handles the intentionally changed selector with a safe failure", async () => {
    const changed = await loadConnectorFixture(
      fixtureDirectory,
      "synthetic-cloud-changed.fixture.json",
    );

    const failure = await withConnectorFixturePage(
      browser,
      changed,
      (page) =>
        extractSyntheticSubscription(page, "2030-01-01T00:00:00.000Z"),
    ).catch((error: unknown) => error);

    expect(changed.expectation).toEqual({
      outcome: "error",
      code: "CONNECTOR_EXTRACTION_FAILED",
    });
    expect(failure).toBeInstanceOf(FixtureHarnessError);
    expect(failure).toMatchObject({
      code: "CONNECTOR_EXTRACTION_FAILED",
      message: "The connector could not extract subscription details.",
    });
    expect(String(failure)).not.toContain(changed.html);
  });

  it("fails safely when a required field is missing", async () => {
    const missingPlan = replaceMarkup(
      working,
      '<strong data-field="plan-name">Fixture Basic</strong>',
      "",
    );

    const failure = await withConnectorFixturePage(
      browser,
      missingPlan,
      (page) =>
        extractSyntheticSubscription(page, "2030-01-01T00:00:00.000Z"),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "CONNECTOR_EXTRACTION_FAILED" });
    expect(String(failure)).not.toContain("plan-name");
  });

  it.each([
    ["2030-01-15", "not-a-date"],
    ["USD 19.95", "invalid-amount"],
    [">monthly<", ">sometimes<"],
    [">active<", ">uncertain<"],
  ])("fails safely for an invalid extracted value", async (current, replacement) => {
    const invalid = replaceMarkup(working, current, replacement);

    const failure = await withConnectorFixturePage(
      browser,
      invalid,
      (page) =>
        extractSyntheticSubscription(page, "2030-01-01T00:00:00.000Z"),
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "CONNECTOR_EXTRACTION_FAILED" });
    expect(String(failure)).not.toContain(replacement);
  });

  it("redacts unexpected extraction failures", async () => {
    const failure = await withConnectorFixturePage(
      browser,
      working,
      async () => {
        throw new Error("private extracted value");
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "FIXTURE_EXECUTION_FAILED",
      message: "The connector fixture could not be executed.",
    });
    expect(String(failure)).not.toContain("private extracted value");
  });

  it("blocks every attempted request before it reaches the network", async () => {
    const failure = await withConnectorFixturePage(
      browser,
      working,
      async (page) => {
        await page.goto("http://127.0.0.1:9/blocked");
      },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "FIXTURE_NETWORK_ATTEMPT" });
  });

  it("runs the shared normalized assertion against the demo connector", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    try {
      const actual = await demoConnector.check({
        dataDirectory: "/unused",
        headless: true,
      });
      assertNormalizedSubscription(actual, {
        providerId: "demo",
        providerName: "Demo Cloud",
        planName: "Starter",
        renewalDate: "2026-10-01",
        amountMinor: 999,
        currency: "EUR",
        billingCycle: "monthly",
        status: "active",
        checkedAt: "2030-01-01T00:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("normalized subscription assertions", () => {
  const expected: Subscription = {
    providerId: "synthetic-cloud",
    providerName: "Synthetic Cloud",
    planName: "Fixture Basic",
    renewalDate: "2030-01-15",
    amountMinor: 1995,
    currency: "USD",
    billingCycle: "monthly",
    status: "active",
    checkedAt: "2030-01-01T00:00:00.000Z",
  };

  it.each<[keyof Subscription, Subscription[keyof Subscription]]>([
    ["providerId", "synthetic-other"],
    ["providerName", "Synthetic Other"],
    ["planName", "Fixture Plus"],
    ["renewalDate", "2030-02-15"],
    ["amountMinor", 2995],
    ["currency", "EUR"],
    ["billingCycle", "yearly"],
    ["status", "trial"],
    ["checkedAt", "2030-01-02T00:00:00.000Z"],
  ])("checks normalized field %s", (field, changedValue) => {
    const actual = { ...expected, [field]: changedValue };
    expect(() => assertNormalizedSubscription(actual, expected)).toThrowError(
      expect.objectContaining({ code: "SUBSCRIPTION_MISMATCH" }),
    );
  });

  it("rejects structurally invalid output without exposing values", () => {
    const failure = (() => {
      try {
        assertNormalizedSubscription({ ...expected, amountMinor: -1 }, expected);
      } catch (error) {
        return error;
      }
    })();

    expect(failure).toMatchObject({ code: "SUBSCRIPTION_INVALID" });
    expect(String(failure)).not.toContain("-1");
  });
});

describe("fixture sanitization", () => {
  const minimalFixture = {
    version: 1,
    id: "synthetic-minimal",
    description: "A hand-written deterministic summary.",
    html: '<main data-subwatch-fixture="synthetic">Safe content</main>',
    expectation: {
      outcome: "error",
      code: "CONNECTOR_EXTRACTION_FAILED",
    },
  };

  it.each([
    {
      ...minimalFixture,
      cookies: [],
    },
    {
      ...minimalFixture,
      description: "Contact person@example.invalid",
    },
    {
      ...minimalFixture,
      html: '<main data-subwatch-fixture="synthetic"><script></script></main>',
    },
    {
      ...minimalFixture,
      html: '<main data-subwatch-fixture="synthetic">http://example.invalid</main>',
    },
    {
      ...minimalFixture,
      html: "<main>Missing synthetic marker</main>",
    },
  ])("rejects unsafe or non-synthetic fixture content", (candidate) => {
    expect(() => validateConnectorFixture(candidate)).toThrowError(
      expect.objectContaining({ code: "FIXTURE_INVALID" }),
    );
  });

  it("rejects fixture path traversal", async () => {
    await expect(
      loadConnectorFixture(fixtureDirectory, "../synthetic-cloud.fixture.json"),
    ).rejects.toMatchObject({ code: "FIXTURE_LOAD_FAILED" });
  });

  it("rejects symbolic-link fixture files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subwatch-fixtures-"));
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(
        join(fixtureDirectory, "synthetic-cloud.fixture.json"),
        join(directory, "linked.fixture.json"),
      );
      await expect(
        loadConnectorFixture(directory, "linked.fixture.json"),
      ).rejects.toMatchObject({ code: "FIXTURE_LOAD_FAILED" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

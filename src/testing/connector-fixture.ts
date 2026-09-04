import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import {
  subscriptionSchema,
  type Subscription,
} from "../core/subscription.js";

const MAX_FIXTURE_BYTES = 64 * 1024;
const FIXTURE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.fixture\.json$/u;
const SYNTHETIC_ID = /^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const expectedSubscriptionSchema = z
  .object({
    providerId: z.string().regex(SYNTHETIC_ID),
    providerName: z.string().min(1).max(80),
    planName: z.string().min(1).max(80),
    renewalDate: z.iso.date(),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    billingCycle: z.enum(["monthly", "quarterly", "yearly", "unknown"]),
    status: z.enum(["active", "trial", "past_due", "cancelled", "unknown"]),
    checkedAt: z.iso.datetime(),
  })
  .strict();

const expectationSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("subscription"),
      subscription: expectedSubscriptionSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("error"),
      code: z.literal("CONNECTOR_EXTRACTION_FAILED"),
    })
    .strict(),
]);

const connectorFixtureSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(SYNTHETIC_ID),
    description: z.string().min(1).max(200),
    html: z.string().min(1).max(MAX_FIXTURE_BYTES),
    expectation: expectationSchema,
  })
  .strict();

export type ConnectorFixture = z.infer<typeof connectorFixtureSchema>;

export type FixtureHarnessErrorCode =
  | "FIXTURE_INVALID"
  | "FIXTURE_LOAD_FAILED"
  | "FIXTURE_NETWORK_ATTEMPT"
  | "FIXTURE_EXECUTION_FAILED"
  | "SUBSCRIPTION_INVALID"
  | "SUBSCRIPTION_MISMATCH"
  | "CONNECTOR_EXTRACTION_FAILED";

export class FixtureHarnessError extends Error {
  constructor(readonly code: FixtureHarnessErrorCode, message: string) {
    super(message);
    this.name = "FixtureHarnessError";
  }
}

const forbiddenContentPatterns: RegExp[] = [
  /<!--/iu,
  /<(?:script|iframe|form|input|object|embed|link|img|audio|video|base|meta|style|svg|image|source|track)\b/iu,
  /\son[a-z]+\s*=/iu,
  /\b(?:src|href|action|formaction|poster|style)\s*=/iu,
  /\burl\s*\(/iu,
  /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/iu,
  /\b(?:https?:)?\/\//iu,
  /\b(?:account|authenticated|authorization|bearer|cookie|credential|invoice|password|secret|storage[\s_-]*state|token)\b/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:ghp|github_pat|sk_live|pk_live)_[A-Za-z0-9_]+\b/u,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /\b(?:\d{4}[ -]){3}\d{4}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

const forbiddenPropertyPattern =
  /"(?:authorization|cookies?|credentials?|headers?|password|storageState|tokens?)"\s*:/iu;

function rejectUnsafeFixtureContent(serialized: string, html: string): void {
  const normalized = serialized.normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (
    forbiddenPropertyPattern.test(normalized) ||
    forbiddenContentPatterns.some((pattern) => pattern.test(normalized)) ||
    !/<[a-z][^>]*\bdata-vaultscout-fixture=(?:"synthetic"|'synthetic')[^>]*>/iu.test(
      html,
    )
  ) {
    throw new FixtureHarnessError(
      "FIXTURE_INVALID",
      "The connector fixture failed sanitization.",
    );
  }
}

export function validateConnectorFixture(value: unknown): ConnectorFixture {
  const parsed = connectorFixtureSchema.safeParse(value);
  if (!parsed.success) {
    throw new FixtureHarnessError(
      "FIXTURE_INVALID",
      "The connector fixture is invalid.",
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new FixtureHarnessError(
      "FIXTURE_INVALID",
      "The connector fixture is invalid.",
    );
  }

  rejectUnsafeFixtureContent(serialized, parsed.data.html);

  if (
    parsed.data.expectation.outcome === "subscription" &&
    (parsed.data.expectation.subscription.providerId !== parsed.data.id ||
      !parsed.data.expectation.subscription.providerName
        .toLowerCase()
        .includes("synthetic"))
  ) {
    throw new FixtureHarnessError(
      "FIXTURE_INVALID",
      "The connector fixture is invalid.",
    );
  }

  return parsed.data;
}

export async function loadConnectorFixture(
  fixtureDirectory: string,
  filename: string,
): Promise<ConnectorFixture> {
  if (!FIXTURE_FILENAME.test(filename)) {
    throw new FixtureHarnessError(
      "FIXTURE_LOAD_FAILED",
      "The connector fixture could not be loaded.",
    );
  }

  try {
    const directory = resolve(fixtureDirectory);
    const path = resolve(directory, filename);
    if (dirname(path) !== directory) {
      throw new Error("Invalid fixture path.");
    }

    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_FIXTURE_BYTES) {
      throw new Error("Invalid fixture file.");
    }

    const serialized = await readFile(path, "utf8");
    return validateConnectorFixture(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof FixtureHarnessError && error.code === "FIXTURE_INVALID") {
      throw error;
    }
    throw new FixtureHarnessError(
      "FIXTURE_LOAD_FAILED",
      "The connector fixture could not be loaded.",
    );
  }
}

function safeExecutionError(error: unknown): FixtureHarnessError {
  if (error instanceof FixtureHarnessError) {
    if (error.code === "CONNECTOR_EXTRACTION_FAILED") {
      return new FixtureHarnessError(
        "CONNECTOR_EXTRACTION_FAILED",
        "The connector could not extract subscription details.",
      );
    }
  }
  return new FixtureHarnessError(
    "FIXTURE_EXECUTION_FAILED",
    "The connector fixture could not be executed.",
  );
}

export async function withConnectorFixturePage<T>(
  browser: Browser,
  fixture: ConnectorFixture,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const validated = validateConnectorFixture(fixture);
  let context: BrowserContext;
  try {
    context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
  } catch {
    throw new FixtureHarnessError(
      "FIXTURE_EXECUTION_FAILED",
      "The connector fixture could not be executed.",
    );
  }
  let networkAttempted = false;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;

  try {
    context.on("request", () => {
      networkAttempted = true;
    });
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    await page.setContent(validated.html, { waitUntil: "domcontentloaded" });
    result = await operation(page);
  } catch (error) {
    operationError = error;
    operationFailed = true;
  } finally {
    await context.close().catch(() => undefined);
  }

  if (networkAttempted) {
    throw new FixtureHarnessError(
      "FIXTURE_NETWORK_ATTEMPT",
      "The connector fixture attempted network access.",
    );
  }
  if (operationFailed) {
    throw safeExecutionError(operationError);
  }

  return result as T;
}

const normalizedSubscriptionFields = [
  "providerId",
  "providerName",
  "planName",
  "renewalDate",
  "amountMinor",
  "currency",
  "billingCycle",
  "status",
  "checkedAt",
] as const satisfies readonly (keyof Subscription)[];

export function assertNormalizedSubscription(
  actual: unknown,
  expected: Subscription,
): asserts actual is Subscription {
  const parsed = subscriptionSchema.safeParse(actual);
  if (!parsed.success) {
    throw new FixtureHarnessError(
      "SUBSCRIPTION_INVALID",
      "The connector returned an invalid subscription.",
    );
  }

  const unparsed = actual as Record<string, unknown>;
  if (
    unparsed.currency !== parsed.data.currency ||
    normalizedSubscriptionFields.some(
      (field) => parsed.data[field] !== expected[field],
    )
  ) {
    throw new FixtureHarnessError(
      "SUBSCRIPTION_MISMATCH",
      "The connector output did not match the fixture.",
    );
  }
}

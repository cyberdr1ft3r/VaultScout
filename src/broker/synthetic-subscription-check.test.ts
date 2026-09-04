import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CHECK_SUBSCRIPTION_CAPABILITY,
  type CheckSubscriptionResponse,
} from "./credential-broker.js";
import type { CredentialBackendFailureCode } from "./credential-backend.js";
import { SessionVault } from "../core/session-vault.js";
import type { SessionKeyProvider } from "../core/session-key-provider.js";
import {
  openSubscriptionHistory,
  parseOpaqueAccountReference,
  type SubscriptionHistoryRepository,
} from "../persistence/subscription-history.js";
import {
  loadConnectorFixture,
  type ConnectorFixture,
} from "../testing/connector-fixture.js";
import { extractSyntheticSubscription } from "../testing/synthetic-provider.js";
import { FakeCredentialBackend } from "./testing/fake-credential-backend.js";
import { createBrokeredSyntheticSubscriptionCheck } from "./synthetic-subscription-check.js";

const SYNTHETIC_PASSWORD = [
  "VAULTSCOUT",
  "SYNTHETIC",
  "E2E",
  "PASSWORD",
  "TEST",
  "ONLY",
].join("_");
const SYNTHETIC_USERNAME = [
  "vaultscout",
  "synthetic",
  "user",
].join("-");
const SYNTHETIC_SESSION_VALUE = [
  "VAULTSCOUT",
  "SYNTHETIC",
  "SESSION",
  "TEST",
  "ONLY",
].join("_");
const COOKIE_NAME = "vaultscout_synthetic_session";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const ACCOUNT_REFERENCE = parseOpaqueAccountReference(
  "acct_cccccccccccccccccccccccccccccccc",
);
const ITEM_REFERENCE = "item_SYNTHETICCHECK0001";
const fixtureDirectory = fileURLToPath(
  new URL("../testing/fixtures", import.meta.url),
);

type LoginMode =
  | "normal"
  | "redirect_before"
  | "cross_form"
  | "sibling_form"
  | "same_origin_mutation"
  | "scheme_form"
  | "unsafe_scheme"
  | "port_form"
  | "unsafe_iframe"
  | "mfa"
  | "captcha"
  | "confirmation";
type SubmitMode =
  | "success"
  | "login_failure"
  | "redirect_during"
  | "mfa"
  | "captcha"
  | "hang";
type BillingMode = "normal" | "external_request" | "service_worker";

interface SyntheticServerOptions {
  login?: LoginMode;
  submit?: SubmitMode;
  billing?: BillingMode;
}

interface SyntheticServer {
  origin: string;
  requests: string[];
  serviceWorkerRequests: number;
  close(): Promise<void>;
}

let billingFixture: ConnectorFixture;
const temporaryDirectories: string[] = [];
const repositories: SubscriptionHistoryRepository[] = [];
const servers: SyntheticServer[] = [];
const launchedBrowsers: Browser[] = [];

function sendHtml(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}

async function requestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_192) {
        request.destroy();
        rejectPromise(new Error("Synthetic request exceeded limit."));
      }
    });
    request.on("end", () => resolvePromise(body));
    request.on("error", rejectPromise);
  });
}

async function startSyntheticServer(
  options: SyntheticServerOptions = {},
): Promise<SyntheticServer> {
  const requests: string[] = [];
  let serviceWorkerRequests = 0;
  let port = 0;
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    void (async () => {
      const origin = `http://127.0.0.1:${port}`;
      const alternateOrigin = `http://localhost:${port}`;
      const path = new URL(request.url ?? "/", origin).pathname;

      if (path === "/login" && request.method === "GET") {
        const mode = options.login ?? "normal";
        if (mode === "redirect_before") {
          redirect(response, `${alternateOrigin}/login`);
          return;
        }
        if (
          mode === "mfa" ||
          mode === "captcha" ||
          mode === "confirmation"
        ) {
          sendHtml(
            response,
            `<main data-vaultscout-interactive="${mode}">Synthetic interaction required</main>`,
          );
          return;
        }

        const action =
          mode === "cross_form"
            ? `${alternateOrigin}/session`
            : mode === "sibling_form"
              ? `http://sibling.localhost:${port}/session`
              : mode === "same_origin_mutation"
                ? `${origin}/account-change`
                : mode === "scheme_form"
                  ? `https://127.0.0.1:${port}/session`
                  : mode === "unsafe_scheme"
                    ? "data:text/plain,blocked"
                    : mode === "port_form"
                      ? `http://127.0.0.1:${port + 1}/session`
                      : `${origin}/session`;
        const frame =
          mode === "unsafe_iframe"
            ? '<iframe src="/synthetic-frame"></iframe>'
            : "";
        sendHtml(
          response,
          `<main><form data-vaultscout-login="true" method="post" action="${action}"><input name="username"><input name="password" type="password"><button type="submit">Continue</button></form>${frame}</main>`,
        );
        return;
      }

      if (path === "/synthetic-frame") {
        sendHtml(response, "<p>Synthetic child frame</p>");
        return;
      }

      if (path === "/session" && request.method === "POST") {
        if ((options.submit ?? "success") === "hang") {
          return;
        }
        const submitted = new URLSearchParams(await requestBody(request));
        if ((options.submit ?? "success") === "redirect_during") {
          redirect(response, `${alternateOrigin}/billing`);
          return;
        }
        if (
          submitted.get("username") !== SYNTHETIC_USERNAME ||
          submitted.get("password") !== SYNTHETIC_PASSWORD ||
          (options.submit ?? "success") === "login_failure"
        ) {
          redirect(response, `${origin}/login`);
          return;
        }
        if (options.submit === "mfa" || options.submit === "captcha") {
          sendHtml(
            response,
            `<main data-vaultscout-interactive="${options.submit}">Synthetic interaction required</main>`,
          );
          return;
        }
        response.writeHead(302, {
          location: `${origin}/billing`,
          "set-cookie": `${COOKIE_NAME}=${SYNTHETIC_SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`,
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      if (path === "/billing") {
        const authenticated = request.headers.cookie?.includes(
          `${COOKIE_NAME}=${SYNTHETIC_SESSION_VALUE}`,
        );
        if (!authenticated) {
          redirect(response, `${origin}/login`);
          return;
        }
        const extra =
          options.billing === "external_request"
            ? `<img src="${alternateOrigin}/external-resource">`
            : options.billing === "service_worker"
              ? "<script>navigator.serviceWorker.register('/synthetic-worker.js')</script>"
              : "";
        sendHtml(response, `${billingFixture.html}${extra}`);
        return;
      }

      if (path === "/synthetic-worker.js") {
        serviceWorkerRequests += 1;
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end("self.addEventListener('fetch', () => undefined)");
        return;
      }

      sendHtml(response, "<p>Synthetic not found</p>", 404);
    })().catch(() => {
      if (!response.headersSent) {
        sendHtml(response, "<p>Synthetic failure</p>", 500);
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic server did not start.");
  }
  port = address.port;

  const syntheticServer: SyntheticServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get serviceWorkerRequests() {
      return serviceWorkerRequests;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    },
  };
  servers.push(syntheticServer);
  return syntheticServer;
}

interface SetupOptions {
  server?: SyntheticServerOptions;
  backendFailure?: CredentialBackendFailureCode;
  connector?: {
    id: string;
    name: string;
    extract(
      page: Parameters<typeof extractSyntheticSubscription>[0],
      checkedAt: string,
    ): Promise<unknown>;
  };
  persistence?: SubscriptionHistoryRepository;
  timeoutMs?: number;
}

async function setup(options: SetupOptions = {}) {
  const syntheticServer = await startSyntheticServer(options.server);
  const directory = await mkdtemp(
    join(tmpdir(), "vaultscout-synthetic-check-"),
  );
  temporaryDirectories.push(directory);
  const keyProvider: SessionKeyProvider = {
    async getKey() {
      return Buffer.alloc(32, 11);
    },
  };
  const sessionVault = new SessionVault(directory, {
    keyProvider,
    now: () => NOW,
  });
  const persistence =
    options.persistence ?? (await openSubscriptionHistory(directory));
  if (!options.persistence) repositories.push(persistence);
  const backend = new FakeCredentialBackend({
    entries: [
      {
        itemReference: ITEM_REFERENCE,
        allowedOrigin: syntheticServer.origin,
        password: SYNTHETIC_PASSWORD,
      },
    ],
    ...(options.backendFailure
      ? { failWith: options.backendFailure }
      : {}),
  });
  const connector = options.connector ?? {
    id: "synthetic-cloud",
    name: "Synthetic Cloud",
    extract: extractSyntheticSubscription,
  };
  const broker = createBrokeredSyntheticSubscriptionCheck({
    binding: {
      accountReference: ACCOUNT_REFERENCE,
      backendKind: "synthetic_fake",
      itemReference: ITEM_REFERENCE,
      allowedOrigin: syntheticServer.origin,
    },
    backend,
    target: {
      accountReference: ACCOUNT_REFERENCE,
      providerId: "synthetic-cloud",
      providerName: "Synthetic Cloud",
      trustedUsername: SYNTHETIC_USERNAME,
      sessionLifetimeMs: 60 * 60 * 1_000,
      connector,
    },
    sessionVault,
    persistence,
    async launchBrowser() {
      const browser = await chromium.launch({ headless: true });
      launchedBrowsers.push(browser);
      return browser;
    },
    now: () => NOW,
    checkTimeoutMs: options.timeoutMs ?? 5_000,
  });

  return {
    broker,
    backend,
    directory,
    persistence,
    sessionVault,
    syntheticServer,
  };
}

function request() {
  return {
    accountReference: ACCOUNT_REFERENCE,
    capability: CHECK_SUBSCRIPTION_CAPABILITY,
  } as const;
}

function authenticatedStorageState(origin: string) {
  const { hostname } = new URL(origin);
  return {
    cookies: [
      {
        name: COOKIE_NAME,
        value: SYNTHETIC_SESSION_VALUE,
        domain: hostname,
        path: "/",
        expires: 2_000_000_000,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  };
}

async function saveSession(
  sessionVault: SessionVault,
  origin: string,
  expiresAt: Date,
): Promise<void> {
  await sessionVault.save(
    {
      providerId: "synthetic-cloud",
      accountId: ACCOUNT_REFERENCE,
    },
    {
      storageState: authenticatedStorageState(origin),
      expiresAt,
    },
  );
}

beforeAll(async () => {
  billingFixture = await loadConnectorFixture(
    fixtureDirectory,
    "synthetic-cloud.fixture.json",
  );
});

afterAll(async () => {
  expect(
    launchedBrowsers.every((browser) => !browser.isConnected()),
  ).toBe(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
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

describe("brokered synthetic subscription check", () => {
  it("reuses a valid encrypted session without calling the backend", async () => {
    const values = await setup();
    await saveSession(
      values.sessionVault,
      values.syntheticServer.origin,
      new Date("2030-01-01T01:00:00.000Z"),
    );

    const response = await values.broker.checkSubscription(request());

    expect(response.outcome).toBe("completed");
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
    expect(values.syntheticServer.requests).not.toContain("GET /login");
  });

  it.each([
    ["missing", undefined],
    ["expired", new Date("2029-12-31T23:59:59.000Z")],
    ["reauthentication_required", new Date("2030-01-01T01:00:00.000Z")],
  ] as const)("brokered login handles %s session state", async (
    state,
    expiresAt,
  ) => {
    const values = await setup();
    if (expiresAt) {
      await saveSession(
        values.sessionVault,
        values.syntheticServer.origin,
        expiresAt,
      );
    }
    if (state === "reauthentication_required") {
      await values.sessionVault.requireReauthentication({
        providerId: "synthetic-cloud",
        accountId: ACCOUNT_REFERENCE,
      });
    }

    const response = await values.broker.checkSubscription(request());

    expect(response.outcome).toBe("completed");
    expect(values.backend.safeSnapshot().useAttempts).toBe(1);
    expect(values.syntheticServer.requests).toContain("POST /session");
  });

  it("rejects an unexpected same-origin form action", async () => {
    const values = await setup({
      server: { login: "same_origin_mutation" },
    });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "LOGIN_FAILED",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
    expect(values.syntheticServer.requests).not.toContain(
      "POST /account-change",
    );
  });

  it("fails safely on a corrupt encrypted session", async () => {
    const values = await setup();
    await saveSession(
      values.sessionVault,
      values.syntheticServer.origin,
      new Date("2030-01-01T01:00:00.000Z"),
    );
    const sessionFile = (await readdir(values.directory, { recursive: true }))
      .map(String)
      .find((path) => path.endsWith(".enc"));
    expect(sessionFile).toBeDefined();
    await writeFile(join(values.directory, sessionFile!), "corrupt");

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "SESSION_CORRUPT",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
  });

  it("completes, reconstructs, and persists one normalized result", async () => {
    const values = await setup();

    const response = await values.broker.checkSubscription(request());

    expect(response).toEqual({
      outcome: "completed",
      accountReference: ACCOUNT_REFERENCE,
      capability: "check_subscription",
      subscription: billingFixture.expectation.outcome === "subscription"
        ? billingFixture.expectation.subscription
        : undefined,
    });
    const history = await values.persistence.getCheckHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      outcome: "success",
      failureCode: null,
      subscription: billingFixture.expectation.outcome === "subscription"
        ? billingFixture.expectation.subscription
        : undefined,
    });
  });

  it("saves only encrypted browser state after login", async () => {
    const values = await setup();
    const response = await values.broker.checkSubscription(request());
    expect(response.outcome).toBe("completed");

    const paths = (await readdir(values.directory, { recursive: true })).map(
      String,
    );
    const sessionFile = paths.find((path) => path.endsWith(".enc"));
    expect(sessionFile).toBeDefined();
    const encrypted = await readFile(
      join(values.directory, sessionFile!),
      "utf8",
    );
    expect(encrypted).not.toContain(SYNTHETIC_PASSWORD);
    expect(encrypted).not.toContain(SYNTHETIC_SESSION_VALUE);
    expect(paths.join(" ")).not.toContain(SYNTHETIC_PASSWORD);
    expect(paths.some((path) => path.endsWith(".json"))).toBe(false);
  });

  it.each([
    ["AUTHORIZATION_DENIED", "AUTHORIZATION_DENIED"],
    ["BACKEND_LOCKED", "INTERACTIVE_REQUIRED"],
    ["ITEM_NOT_FOUND", "CREDENTIAL_UNAVAILABLE"],
    ["BACKEND_UNAVAILABLE", "BACKEND_UNAVAILABLE"],
  ] as const)("returns and persists redacted backend failure %s", async (
    backendFailure,
    publicFailure,
  ) => {
    const values = await setup({ backendFailure });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: publicFailure,
    });
    const history = await values.persistence.getCheckHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.subscription).toBeNull();
    expect(history[0]?.failureCode).toMatch(
      /AUTHENTICATION_REQUIRED|CONNECTOR_UNAVAILABLE/u,
    );
  });

  it("returns and persists a redacted login failure", async () => {
    const values = await setup({ server: { submit: "login_failure" } });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "LOGIN_FAILED",
    });
    const history = await values.persistence.getCheckHistory();
    expect(history[0]).toMatchObject({
      outcome: "reauthentication_required",
      failureCode: "AUTHENTICATION_REQUIRED",
      subscription: null,
    });
  });

  it("returns extraction failure for connector exceptions", async () => {
    const values = await setup({
      connector: {
        id: "synthetic-cloud",
        name: "Synthetic Cloud",
        async extract() {
          throw new Error(SYNTHETIC_PASSWORD);
        },
      },
    });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "EXTRACTION_FAILED",
    });
    expect((await values.persistence.getCheckHistory())[0]).toMatchObject({
      failureCode: "EXTRACTION_FAILED",
      subscription: null,
    });
  });

  it.each(["malformed", "extra"] as const)(
    "rejects %s connector fields",
    async (variant) => {
      const result =
        variant === "extra" &&
        billingFixture.expectation.outcome === "subscription"
          ? {
              ...billingFixture.expectation.subscription,
              extra: "unexpected",
            }
          : {
              providerId: "synthetic-cloud",
              providerName: "Synthetic Cloud",
            };
      const values = await setup({
        connector: {
          id: "synthetic-cloud",
          name: "Synthetic Cloud",
          async extract() {
            return result;
          },
        },
      });

      await expect(
        values.broker.checkSubscription(request()),
      ).resolves.toEqual({
        outcome: "failed",
        failureCode: "EXTRACTION_FAILED",
      });
    },
  );

  it("returns persistence failure without exposing repository errors", async () => {
    const privateMessage = "synthetic private persistence detail";
    const persistence = {
      async recordSuccessfulCheck() {
        throw new Error(privateMessage);
      },
      async recordFailedCheck() {
        throw new Error(privateMessage);
      },
    } as unknown as SubscriptionHistoryRepository;
    const values = await setup({ persistence });

    const response = await values.broker.checkSubscription(request());

    expect(response).toEqual({
      outcome: "failed",
      failureCode: "PERSISTENCE_FAILED",
    });
    expect(JSON.stringify(response)).not.toContain(privateMessage);
  });
});

describe("exact-origin controlled browser", () => {
  it("blocks a malicious redirect before credential use", async () => {
    const values = await setup({ server: { login: "redirect_before" } });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
    expect(values.syntheticServer.requests).not.toContain(
      "GET /external-resource",
    );
  });

  it("blocks a malicious redirect during form submission", async () => {
    const values = await setup({ server: { submit: "redirect_during" } });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(1);
  });

  it.each([
    ["cross_form", "sibling hostname"],
    ["sibling_form", "sibling subdomain"],
    ["scheme_form", "scheme"],
    ["unsafe_scheme", "unsafe scheme"],
    ["port_form", "port"],
  ] as const)("rejects %s mismatch in login form action", async (
    login,
    _description,
  ) => {
    const values = await setup({ server: { login } });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
  });

  it("rejects an iframe before credential use", async () => {
    const values = await setup({ server: { login: "unsafe_iframe" } });

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
  });

  it("blocks external resource requests on an authenticated page", async () => {
    const values = await setup({
      server: { billing: "external_request" },
    });
    await saveSession(
      values.sessionVault,
      values.syntheticServer.origin,
      new Date("2030-01-01T01:00:00.000Z"),
    );

    await expect(
      values.broker.checkSubscription(request()),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(values.backend.safeSnapshot().useAttempts).toBe(0);
    expect(values.syntheticServer.requests).not.toContain(
      "GET /external-resource",
    );
  });

  it("disables service workers before page code executes", async () => {
    const values = await setup({ server: { billing: "service_worker" } });

    const response = await values.broker.checkSubscription(request());

    expect(response.outcome).toBe("completed");
    expect(values.syntheticServer.serviceWorkerRequests).toBe(0);
  });

  it.each(["mfa", "captcha", "confirmation"] as const)(
    "returns interactive-required for %s without solving it",
    async (login) => {
      const values = await setup({ server: { login } });

      await expect(
        values.broker.checkSubscription(request()),
      ).resolves.toEqual({
        outcome: "failed",
        failureCode: "INTERACTIVE_REQUIRED",
      });
      expect(values.backend.safeSnapshot().useAttempts).toBe(0);
      expect((await values.persistence.getCheckHistory())[0]).toMatchObject({
        outcome: "reauthentication_required",
        failureCode: "AUTHENTICATION_REQUIRED",
      });
    },
  );

  it.each(["mfa", "captcha"] as const)(
    "stops at post-login %s without automating it",
    async (submit) => {
      const values = await setup({ server: { submit } });

      await expect(
        values.broker.checkSubscription(request()),
      ).resolves.toEqual({
        outcome: "failed",
        failureCode: "INTERACTIVE_REQUIRED",
      });
      expect(values.backend.safeSnapshot().useAttempts).toBe(1);
    },
  );

  it("cancels a hanging login and closes the browser", async () => {
    const before = launchedBrowsers.length;
    const values = await setup({
      server: { submit: "hang" },
      timeoutMs: 150,
    });

    const response = await values.broker.checkSubscription(request());

    expect(response).toEqual({
      outcome: "failed",
      failureCode: "REQUEST_CANCELLED",
    });
    expect(launchedBrowsers.length).toBe(before + 1);
    expect(launchedBrowsers.at(-1)?.isConnected()).toBe(false);
  });
});

describe("agent response non-disclosure", () => {
  it("keeps credentials and session material out of every observable surface", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const values = await setup();

    const response: CheckSubscriptionResponse =
      await values.broker.checkSubscription(request());
    const serialized = JSON.stringify({
      response,
      backend: values.backend.safeSnapshot(),
    });
    expect(serialized).not.toContain(SYNTHETIC_PASSWORD);
    expect(serialized).not.toContain(SYNTHETIC_SESSION_VALUE);
    expect(serialized).not.toMatch(
      /cookies|tokens|storageState|password|username|allowedOrigin|itemReference/iu,
    );
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);

    await values.persistence.close();
    repositories.splice(repositories.indexOf(values.persistence), 1);
    const paths = (await readdir(values.directory, { recursive: true })).map(
      String,
    );
    for (const path of paths) {
      const fullPath = join(values.directory, path);
      if (!(await lstat(fullPath)).isFile()) continue;
      const contents = await readFile(fullPath);
      expect(contents.includes(Buffer.from(SYNTHETIC_PASSWORD))).toBe(false);
      expect(contents.includes(Buffer.from(SYNTHETIC_SESSION_VALUE))).toBe(
        false,
      );
    }
    expect(values.backend.kind).toBe("synthetic_fake");
  });
});

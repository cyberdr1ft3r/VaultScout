import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_SUBSCRIPTION_CAPABILITY,
  createCredentialBroker,
  CredentialBrokerConfigurationError,
  type CheckSubscriptionRequest,
  type TrustedSubscriptionCheckExecutor,
} from "./credential-broker.js";
import type { CredentialBackend } from "./credential-backend.js";
import {
  CredentialBindingError,
  originMatchesBinding,
  validateCredentialBinding,
  validateCredentialBindings,
} from "./credential-binding.js";
import { FakeCredentialBackend } from "./testing/fake-credential-backend.js";
import { parseOpaqueAccountReference } from "../persistence/subscription-history.js";

const SYNTHETIC_PASSWORD = [
  "VAULTSCOUT",
  "SYNTHETIC",
  "PASSWORD",
  "TEST",
  "ONLY",
].join("_");
const accountReference = parseOpaqueAccountReference(
  "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);
const missingAccountReference = parseOpaqueAccountReference(
  "acct_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);
const itemReference = "item_SYNTHETICITEM0001";
const allowedOrigin = "https://billing.synthetic.invalid";

const temporaryDirectories: string[] = [];

function binding(overrides: Record<string, unknown> = {}): unknown {
  return {
    accountReference,
    backendKind: "synthetic_fake",
    itemReference,
    allowedOrigin,
    ...overrides,
  };
}

function fakeBackend(
  overrides: Partial<ConstructorParameters<typeof FakeCredentialBackend>[0]> = {},
): FakeCredentialBackend {
  return new FakeCredentialBackend({
    entries: [
      {
        itemReference,
        allowedOrigin,
        password: SYNTHETIC_PASSWORD,
      },
    ],
    ...overrides,
  });
}

function request(
  overrides: Record<string, unknown> = {},
): CheckSubscriptionRequest {
  return {
    accountReference,
    capability: CHECK_SUBSCRIPTION_CAPABILITY,
    ...overrides,
  } as CheckSubscriptionRequest;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("credential binding validation", () => {
  it("accepts one canonical exact HTTPS origin", () => {
    expect(validateCredentialBinding(binding())).toEqual({
      accountReference,
      backendKind: "synthetic_fake",
      itemReference,
      allowedOrigin,
    });
  });

  it.each([
    "http://localhost:4100",
    "http://127.0.0.1:4100",
    "http://[::1]:4100",
  ])("permits explicit loopback HTTP origin %s for tests", (origin) => {
    expect(
      validateCredentialBinding(binding({ allowedOrigin: origin })),
    ).toMatchObject({ allowedOrigin: origin });
  });

  it.each([
    "http://billing.synthetic.invalid",
    "https://*.synthetic.invalid",
    "https://user@billing.synthetic.invalid",
    "https://user:pass@billing.synthetic.invalid",
    "https://billing.synthetic.invalid/",
    "https://billing.synthetic.invalid/login",
    "https://billing.synthetic.invalid?next=login",
    "https://billing.synthetic.invalid#login",
    "not a URL",
  ])("rejects unsafe or non-exact configured origin %s", (origin) => {
    expect(() =>
      validateCredentialBinding(binding({ allowedOrigin: origin })),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CREDENTIAL_BINDING" }),
    );
  });

  it("rejects non-opaque item references and unknown binding fields", () => {
    expect(() =>
      validateCredentialBinding(
        binding({ itemReference: "https://vault.invalid/item" }),
      ),
    ).toThrow(CredentialBindingError);
    expect(() =>
      validateCredentialBinding({
        ...(binding() as Record<string, unknown>),
        credentialDomain: allowedOrigin,
      }),
    ).toThrow(CredentialBindingError);
  });

  it("rejects duplicate account bindings", () => {
    expect(() =>
      validateCredentialBindings([binding(), binding()]),
    ).toThrowError(
      expect.objectContaining({ code: "INVALID_CREDENTIAL_BINDING" }),
    );
  });

  it("redacts exceptions thrown while reading binding properties", () => {
    const hostileBinding = {
      get accountReference() {
        throw new Error(SYNTHETIC_PASSWORD);
      },
      backendKind: "synthetic_fake",
      itemReference,
      allowedOrigin,
    };

    const failure = (() => {
      try {
        validateCredentialBinding(hostileBinding);
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(CredentialBindingError);
    expect(String(failure)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("matches the observed URL only to the configured exact origin", () => {
    expect(
      originMatchesBinding(
        "https://billing.synthetic.invalid/subscription",
        allowedOrigin,
      ),
    ).toBe(true);
    expect(
      originMatchesBinding(
        "https://other.synthetic.invalid/subscription",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      originMatchesBinding(
        "http://billing.synthetic.invalid/subscription",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      originMatchesBinding(
        "https://billing.synthetic.invalid:444/subscription",
        allowedOrigin,
      ),
    ).toBe(false);
    expect(
      originMatchesBinding(
        "https://user@billing.synthetic.invalid/subscription",
        allowedOrigin,
      ),
    ).toBe(false);
  });
});

describe("domain-bound credential broker", () => {
  it("authorizes only check_subscription for a configured account", async () => {
    const backend = fakeBackend();
    let consumedInsideTrustedExecutor = false;
    const executor: TrustedSubscriptionCheckExecutor = {
      async execute(context) {
        await context.usePasswordForObservedUrl(
          `${context.allowedOrigin}/login`,
          async (password) => {
            consumedInsideTrustedExecutor =
              password === SYNTHETIC_PASSWORD;
          },
        );
        return { outcome: "completed" };
      },
    };
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor,
    });

    const response = await broker.checkSubscription(request());

    expect(consumedInsideTrustedExecutor).toBe(true);
    expect(response).toMatchInlineSnapshot(`
      {
        "accountReference": "acct_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "capability": "check_subscription",
        "outcome": "completed",
      }
    `);
    expect(JSON.stringify(response)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it.each([
    { capability: "get_secret" },
    { capability: "cancel_subscription" },
    { allowedOrigin },
    { itemReference },
    { backendKind: "synthetic_fake" },
    { password: SYNTHETIC_PASSWORD },
  ])("denies caller-selected authority or capability", async (override) => {
    const backend = fakeBackend();
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor: {
        async execute() {
          return { outcome: "completed" };
        },
      },
    });

    await expect(
      broker.checkSubscription(request(override)),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "REQUEST_DENIED",
    });
    expect(backend.safeSnapshot().useAttempts).toBe(0);
  });

  it("returns a redacted missing-binding decision", async () => {
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [fakeBackend()],
      executor: {
        async execute() {
          return { outcome: "completed" };
        },
      },
    });

    await expect(
      broker.checkSubscription(
        request({ accountReference: missingAccountReference }),
      ),
    ).resolves.toEqual({
      outcome: "failed",
      failureCode: "BINDING_NOT_FOUND",
    });
  });

  it("redacts exceptions thrown while reading agent request properties", async () => {
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [fakeBackend()],
      executor: {
        async execute() {
          return { outcome: "completed" };
        },
      },
    });
    const hostileRequest = {
      get accountReference() {
        throw new Error(SYNTHETIC_PASSWORD);
      },
      capability: CHECK_SUBSCRIPTION_CAPABILITY,
    } as unknown as CheckSubscriptionRequest;

    const response = await broker.checkSubscription(hostileRequest);
    expect(response).toEqual({
      outcome: "failed",
      failureCode: "REQUEST_DENIED",
    });
    expect(JSON.stringify(response)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("refuses credential use before an exact origin match", async () => {
    const backend = fakeBackend();
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor: {
        async execute(context) {
          try {
            await context.usePasswordForObservedUrl(
              "https://other.synthetic.invalid/login",
              async () => {
                throw new Error("Unreachable synthetic consumer.");
              },
            );
          } catch {
            // A faulty executor cannot hide the broker's policy failure.
          }
          return { outcome: "completed" };
        },
      },
    });

    await expect(broker.checkSubscription(request())).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
    expect(backend.safeSnapshot().useAttempts).toBe(0);
  });

  it("fails closed when the backend's trusted origin differs", async () => {
    const backend = new FakeCredentialBackend({
      entries: [
        {
          itemReference,
          allowedOrigin: "https://different.synthetic.invalid",
          password: SYNTHETIC_PASSWORD,
        },
      ],
    });
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor: {
        async execute(context) {
          await context.usePasswordForObservedUrl(
            `${context.allowedOrigin}/login`,
            async () => undefined,
          );
          return { outcome: "completed" };
        },
      },
    });

    await expect(broker.checkSubscription(request())).resolves.toEqual({
      outcome: "failed",
      failureCode: "ORIGIN_MISMATCH",
    });
  });

  it.each([
    ["BACKEND_UNAVAILABLE", "BACKEND_UNAVAILABLE"],
    ["BACKEND_LOCKED", "INTERACTIVE_REQUIRED"],
    ["AUTHORIZATION_DENIED", "AUTHORIZATION_DENIED"],
    ["ITEM_NOT_FOUND", "CREDENTIAL_UNAVAILABLE"],
    ["VAULT_NOT_FOUND", "CREDENTIAL_UNAVAILABLE"],
    ["FIELD_NOT_FOUND", "CREDENTIAL_UNAVAILABLE"],
    ["MALFORMED_OUTPUT", "CREDENTIAL_UNAVAILABLE"],
    ["PROCESS_TIMEOUT", "BACKEND_UNAVAILABLE"],
    ["OUTPUT_LIMIT_EXCEEDED", "BACKEND_UNAVAILABLE"],
    ["PROCESS_FAILED", "BACKEND_UNAVAILABLE"],
    ["CANCELLED", "REQUEST_CANCELLED"],
    ["CONSUMER_FAILED", "LOGIN_FAILED"],
  ] as const)("maps backend failure %s to redacted code %s", async (
    backendCode,
    brokerCode,
  ) => {
    const backend = fakeBackend({ failWith: backendCode });
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor: {
        async execute(context) {
          await context.usePasswordForObservedUrl(
            `${context.allowedOrigin}/login`,
            async () => undefined,
          );
          return { outcome: "completed" };
        },
      },
    });

    await expect(broker.checkSubscription(request())).resolves.toEqual({
      outcome: "failed",
      failureCode: brokerCode,
    });
  });

  it("returns backend-unavailable when trusted configuration lacks the backend", async () => {
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [],
      executor: {
        async execute() {
          return { outcome: "completed" };
        },
      },
    });

    await expect(broker.checkSubscription(request())).resolves.toEqual({
      outcome: "failed",
      failureCode: "BACKEND_UNAVAILABLE",
    });
  });

  it("rejects extra executor result fields instead of returning them", async () => {
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [fakeBackend()],
      executor: {
        async execute(context) {
          let passwordForInvalidResult = "";
          await context.usePasswordForObservedUrl(
            `${context.allowedOrigin}/login`,
            async (password) => {
              passwordForInvalidResult = password;
            },
          );
          return {
            outcome: "completed",
            password: passwordForInvalidResult,
          } as unknown as { outcome: "completed" };
        },
      },
    });

    const response = await broker.checkSubscription(request());
    expect(response).toEqual({
      outcome: "failed",
      failureCode: "CHECK_FAILED",
    });
    expect(JSON.stringify(response)).not.toContain(SYNTHETIC_PASSWORD);
  });
});

describe("synthetic credential non-disclosure", () => {
  it("keeps the marker out of API values, logs, errors, snapshots, and persisted state", async () => {
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const backend: CredentialBackend = {
      kind: "synthetic_fake",
      async usePassword(_request, consume) {
        await consume(SYNTHETIC_PASSWORD);
        throw new Error(SYNTHETIC_PASSWORD);
      },
    };
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [backend],
      executor: {
        async execute(context) {
          await context.usePasswordForObservedUrl(
            `${context.allowedOrigin}/login`,
            async () => undefined,
          );
          return { outcome: "completed" };
        },
      },
    });

    const response = await broker.checkSubscription(request());
    const fake = fakeBackend();
    const safeSnapshot = fake.safeSnapshot();
    expect(safeSnapshot).toMatchInlineSnapshot(`
      {
        "completedUses": 0,
        "configuredEntries": 1,
        "kind": "synthetic_fake",
        "useAttempts": 0,
      }
    `);

    let configurationError: unknown;
    try {
      createCredentialBroker({
        bindings: [
          {
            ...(binding() as Record<string, unknown>),
            password: SYNTHETIC_PASSWORD,
          },
        ],
        backends: [fake],
        executor: { async execute() { return { outcome: "completed" }; } },
      });
    } catch (error) {
      configurationError = error;
    }
    expect(configurationError).toBeInstanceOf(
      CredentialBrokerConfigurationError,
    );

    const serialized = JSON.stringify({
      response,
      broker,
      backend,
      fake,
      safeSnapshot,
      configurationError: String(configurationError),
    });
    expect(serialized).not.toContain(SYNTHETIC_PASSWORD);
    expect(serialized).not.toContain('"password"');
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).join(" ")).not.toContain(
      SYNTHETIC_PASSWORD,
    );
    expect(String(configurationError)).not.toContain(SYNTHETIC_PASSWORD);

    const directory = await mkdtemp(join(tmpdir(), "vaultscout-broker-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "safe-state.json");
    await writeFile(path, serialized, { mode: 0o600 });
    expect(await readFile(path, "utf8")).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("does not expose generic vault or mutation methods", () => {
    const broker = createCredentialBroker({
      bindings: [binding()],
      backends: [fakeBackend()],
      executor: {
        async execute() {
          return { outcome: "completed" };
        },
      },
    });

    for (const deniedMethod of [
      "getSecret",
      "listVaults",
      "searchVault",
      "getOtp",
      "cancelSubscription",
      "changePlan",
      "mutateAccount",
    ]) {
      expect(deniedMethod in broker).toBe(false);
    }
  });
});
